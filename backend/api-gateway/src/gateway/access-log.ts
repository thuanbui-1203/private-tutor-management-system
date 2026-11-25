import { randomUUID } from 'node:crypto';
import { appendFile, mkdir, readdir, readFile, rename, rm } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { MetricsService, RabbitConnection } from '@tms/common';
import { ACCESS_RECORDED, AccessRecord, AUDIT_EXCHANGE, type Role } from '@tms/contracts';
import type { ConfirmChannel } from 'amqplib';
import { Counter } from 'prom-client';

// Access records (ADR-0005): one per request under /api, published to `tms.audit` for
// audit-service. Never holds a body, a header value, a query value or a token.

/** Path segments that are secrets in themselves (an invitation, calendar or payment token). */
const SECRET_SEGMENTS: [RegExp, string][] = [
  [/^\/billing\/sandbox\/payments\/[^/]+$/, '/billing/sandbox/payments/:token'],
  [/^\/auth\/invitations\/[^/]+\/accept$/, '/auth/invitations/:token/accept'],
  [/^\/calendar\/[^/]+\.ics$/, '/calendar/:token.ics'],
];

/** The path without its query string, with secret segments replaced by `:token`. */
export function sanitizePath(url: string): string {
  const path = url.split('?')[0] || '/';
  for (const [pattern, replacement] of SECRET_SEGMENTS) {
    if (pattern.test(path)) return replacement;
  }
  return path.slice(0, 512);
}

/** Names of the query parameters, never their values. */
export function queryKeysOf(url: string): string[] {
  const query = url.split('?')[1];
  if (!query) return [];
  const keys = [...new Set(new URLSearchParams(query).keys())];
  return keys.slice(0, 32).map((k) => k.slice(0, 64));
}

/** What the gateway learns about a request while handling it. */
export interface AccessContext {
  user?: { id: string; role: Role };
  /** Set when the request is proxied to a service. */
  service?: string;
}

const LINE = '\n';
const SPOOL_FILE = 'access-spool.jsonl';

@Injectable()
export class AccessLogPublisher implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly logger = new Logger('AccessLog');
  private readonly rabbit?: RabbitConnection;
  private readonly declared = new WeakSet<ConfirmChannel>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly spoolDir = process.env.AUDIT_SPOOL_DIR ?? join(tmpdir(), 'tms-gateway-audit');
  private replayTimer?: NodeJS.Timeout;
  private replaying = false;
  private readonly outcomes: Counter<'outcome'>;

  constructor(metrics: MetricsService) {
    const url = process.env.RABBITMQ_URL;
    // Its own connection, not TmsCommonModule's: a broker outage must not make the
    // gateway "not ready" (the audit trail must never take the API down, ADR-0005).
    if (url) this.rabbit = new RabbitConnection(url, this.logger);
    else this.logger.warn('RABBITMQ_URL not set: Access records go to the spool file only');
    this.outcomes = new Counter({
      name: 'tms_audit_access_records_total',
      help: 'Access records by outcome: published, spooled (broker unavailable), replayed, dropped',
      labelNames: ['outcome'],
      registers: [metrics.registry],
    });
  }

  /** Call once per request, as soon as the correlation id is known. */
  begin(
    req: IncomingMessage & { ip?: string },
    res: ServerResponse,
    correlationId: string,
  ): AccessContext {
    const started = process.hrtime.bigint();
    const occurredAt = new Date().toISOString();
    const url = req.url ?? '/';
    const context: AccessContext = {};
    let done = false;
    const finish = (status: number) => {
      if (done) return;
      done = true;
      const userAgent = req.headers['user-agent'];
      this.submit({
        id: randomUUID(),
        occurredAt,
        correlationId,
        userId: context.user?.id ?? null,
        role: context.user?.role ?? null,
        ip: (req.ip ?? req.socket.remoteAddress ?? 'unknown').slice(0, 64),
        userAgent: typeof userAgent === 'string' ? userAgent.slice(0, 256) : null,
        method: (req.method ?? 'GET').slice(0, 10),
        path: sanitizePath(url),
        queryKeys: queryKeysOf(url),
        status,
        durationMs: Number(process.hrtime.bigint() - started) / 1e6,
        service: context.service ?? null,
      });
    };
    res.once('finish', () => finish(res.statusCode));
    // The client went away before the response was sent.
    res.once('close', () => finish(res.writableFinished ? res.statusCode : 0));
    return context;
  }

  /** Publishes in the background; the response never waits for the audit trail. */
  submit(record: AccessRecord): void {
    const task = this.publish(record)
      .then(() => this.outcomes.inc({ outcome: 'published' }))
      .catch(() => this.spool(record))
      .finally(() => this.inFlight.delete(task));
    this.inFlight.add(task);
  }

  private async publish(record: AccessRecord): Promise<void> {
    if (!this.rabbit?.isReady()) throw new Error('broker not connected');
    const channel = await this.rabbit.publishChannel();
    if (!this.declared.has(channel)) {
      await channel.assertExchange(AUDIT_EXCHANGE, 'topic', { durable: true });
      this.declared.add(channel);
    }
    const body = Buffer.from(JSON.stringify(AccessRecord.parse(record)));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('publish not confirmed in 5 s')), 5000);
      channel.publish(
        AUDIT_EXCHANGE,
        ACCESS_RECORDED,
        body,
        { persistent: true, contentType: 'application/json', messageId: record.id },
        (err) => {
          clearTimeout(timer);
          if (err) reject(err instanceof Error ? err : new Error(String(err)));
          else resolve();
        },
      );
    });
  }

  /** Broker unavailable: keep the record on disk until it can be published. */
  private async spool(record: AccessRecord): Promise<void> {
    try {
      await mkdir(this.spoolDir, { recursive: true });
      await appendFile(join(this.spoolDir, SPOOL_FILE), JSON.stringify(record) + LINE);
      this.outcomes.inc({ outcome: 'spooled' });
    } catch (err) {
      this.outcomes.inc({ outcome: 'dropped' });
      this.logger.error(`Access record ${record.id} lost: ${(err as Error).message}`);
    }
  }

  /**
   * Moves the spool aside and publishes it; what still fails goes back to the spool.
   * Leftover `replay-*` files (a crash mid-replay) are picked up too; audit-service
   * stores by record id, so a record published twice is stored once.
   */
  async replay(): Promise<number> {
    if (this.replaying || !this.rabbit?.isReady()) return 0;
    this.replaying = true;
    let replayed = 0;
    try {
      await mkdir(this.spoolDir, { recursive: true });
      await rename(
        join(this.spoolDir, SPOOL_FILE),
        join(this.spoolDir, `replay-${Date.now()}.jsonl`),
      ).catch(
        () => undefined, // nothing spooled
      );
      const files = (await readdir(this.spoolDir)).filter((f) => f.startsWith('replay-')).sort();
      for (const file of files) {
        const path = join(this.spoolDir, file);
        const lines = (await readFile(path, 'utf8')).split(LINE).filter(Boolean);
        for (const line of lines) {
          let record: AccessRecord;
          try {
            record = AccessRecord.parse(JSON.parse(line));
          } catch {
            this.outcomes.inc({ outcome: 'dropped' });
            continue;
          }
          try {
            await this.publish(record);
            this.outcomes.inc({ outcome: 'replayed' });
            replayed++;
          } catch {
            await this.spool(record);
          }
        }
        await rm(path);
      }
      if (replayed) this.logger.log(`published ${replayed} spooled Access record(s)`);
    } finally {
      this.replaying = false;
    }
    return replayed;
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.rabbit?.start();
    this.replayTimer = setInterval(() => void this.replay().catch(() => undefined), 5000);
    this.replayTimer.unref();
  }

  async onApplicationShutdown(): Promise<void> {
    clearInterval(this.replayTimer);
    await Promise.allSettled([...this.inFlight]);
    await this.rabbit?.close();
  }
}
