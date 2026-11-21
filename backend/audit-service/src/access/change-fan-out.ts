import { Injectable, Logger } from '@nestjs/common';
import { InternalHttpClient } from '@tms/common';
import { InternalAuditResponse, type ChangeRecord, type InternalAuditQuery } from '@tms/contracts';

/** Every service that writes Change records, and where it listens. */
export function changeSources(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  return {
    identity: env.IDENTITY_SERVICE_URL ?? 'http://identity-service:3001',
    student: env.STUDENT_SERVICE_URL ?? 'http://student-service:3002',
    class: env.CLASS_SERVICE_URL ?? 'http://class-service:3003',
    schedule: env.SCHEDULE_SERVICE_URL ?? 'http://schedule-service:3004',
    billing: env.BILLING_SERVICE_URL ?? 'http://billing-service:3006',
  };
}

/**
 * Change records stay in each service's own database (ADR-0005); this asks every
 * service's `GET /internal/audit` in parallel and merges the answers.
 */
@Injectable()
export class ChangeFanOut {
  private readonly logger = new Logger(ChangeFanOut.name);
  private readonly clients = Object.entries(changeSources()).map(
    ([name, url]) => [name, new InternalHttpClient(url, { timeoutMs: 3000, retries: 1 })] as const,
  );

  async query(q: InternalAuditQuery): Promise<{ records: ChangeRecord[]; unavailable: string[] }> {
    const params = new URLSearchParams(
      Object.entries(q)
        .filter(([, v]) => v !== undefined)
        .map(([k, v]): [string, string] => [k, String(v)]),
    );
    const answers = await Promise.all(
      this.clients.map(async ([name, client]) => {
        try {
          return {
            name,
            records: (await client.get(`/internal/audit?${params}`, InternalAuditResponse)).records,
          };
        } catch (err) {
          this.logger.warn(`${name}: Change records unavailable: ${(err as Error).message}`);
          return { name, records: undefined };
        }
      }),
    );
    const records = answers
      .flatMap((a) => a.records ?? [])
      .sort((a, b) => b.occurredAt.localeCompare(a.occurredAt) || b.id.localeCompare(a.id))
      .slice(0, q.limit);
    return { records, unavailable: answers.filter((a) => !a.records).map((a) => a.name) };
  }
}
