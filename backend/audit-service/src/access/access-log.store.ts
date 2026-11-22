import { Injectable } from '@nestjs/common';
import type { AccessRecord } from '@tms/contracts';
import type { Prisma } from '../generated/prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export interface AccessQuery {
  userId?: string;
  correlationId?: string;
  method?: string;
  status?: number;
  from?: string;
  to?: string;
  limit: number;
  cursor?: string;
}

/** `<occurredAt ISO>|<id>` of the last row of a page, base64url. */
export const encodeCursor = (occurredAt: Date, id: string) =>
  Buffer.from(`${occurredAt.toISOString()}|${id}`).toString('base64url');

export function decodeCursor(cursor: string): { occurredAt: Date; id: string } | undefined {
  const [at, id] = Buffer.from(cursor, 'base64url').toString().split('|');
  const occurredAt = new Date(at);
  return id && !Number.isNaN(occurredAt.getTime()) ? { occurredAt, id } : undefined;
}

@Injectable()
export class AccessLogStore {
  constructor(private readonly prisma: PrismaService) {}

  /** Idempotent on the record id: a redelivered message stores nothing new. Returns rows inserted. */
  async insert(record: AccessRecord): Promise<number> {
    const { count } = await this.prisma.accessLog.createMany({
      data: [{ ...record, occurredAt: new Date(record.occurredAt) }],
      skipDuplicates: true,
    });
    return count;
  }

  /** Newest first, keyset-paginated on (occurredAt, id). */
  async list(q: AccessQuery) {
    const after = q.cursor ? decodeCursor(q.cursor) : undefined;
    const where: Prisma.AccessLogWhereInput = {
      ...(q.userId && { userId: q.userId }),
      ...(q.correlationId && { correlationId: q.correlationId }),
      ...(q.method && { method: q.method }),
      ...(q.status !== undefined && { status: q.status }),
      ...((q.from || q.to) && {
        occurredAt: {
          ...(q.from && { gte: new Date(q.from) }),
          ...(q.to && { lt: new Date(q.to) }),
        },
      }),
      ...(after && {
        OR: [
          { occurredAt: { lt: after.occurredAt } },
          { occurredAt: after.occurredAt, id: { lt: after.id } },
        ],
      }),
    };
    const rows = await this.prisma.accessLog.findMany({
      where,
      orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
      take: q.limit + 1,
    });
    const page = rows.slice(0, q.limit);
    const last = page.at(-1);
    return {
      items: page.map(({ receivedAt: _received, ...r }) => ({
        ...r,
        occurredAt: r.occurredAt.toISOString(),
      })),
      nextCursor: rows.length > q.limit && last ? encodeCursor(last.occurredAt, last.id) : null,
    };
  }

  /** Retention (ADR-0005): the only DELETE the table's trigger lets through. */
  async purgeOlderThan(cutoff: Date): Promise<number> {
    const [, deleted] = await this.prisma.$transaction([
      this.prisma.$executeRawUnsafe("SET LOCAL audit.purge = 'on'"),
      this.prisma.$executeRawUnsafe(
        'DELETE FROM access_log WHERE occurred_at < $1::timestamptz',
        cutoff.toISOString(),
      ),
    ]);
    return deleted;
  }
}
