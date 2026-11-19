import { randomUUID } from 'node:crypto';
import {
  createEvent,
  EVENTS_EXCHANGE,
  routingKeyOf,
  type EventData,
  type EventEnvelope,
  type EventType,
} from '@tms/contracts';
import { currentCorrelationId } from './correlation';
import type { Database, SqlExecutor } from './database';
import type { Logger } from './logger';
import type { RabbitConnection } from './messaging/connection';

/**
 * Write an event to the outbox inside the caller's transaction (`tx`), so it is
 * published if and only if the business change commits. The payload is validated
 * against @tms/contracts here; a bad payload throws and rolls the transaction back.
 */
export async function enqueueEvent<T extends EventType>(
  tx: SqlExecutor,
  eventType: T,
  data: EventData<T>,
  options: { correlationId?: string } = {},
): Promise<EventEnvelope<T>> {
  const event = createEvent(eventType, data, {
    correlationId: options.correlationId ?? currentCorrelationId() ?? randomUUID(),
  });
  await tx.$executeRawUnsafe(
    'INSERT INTO outbox_events (id, event_type, routing_key, payload) VALUES ($1::uuid, $2, $3, $4::jsonb)',
    event.eventId,
    event.eventType,
    routingKeyOf(eventType),
    JSON.stringify(event),
  );
  return event;
}

interface OutboxRow {
  id: string;
  routing_key: string;
  payload: EventEnvelope;
}

export interface OutboxRelayOptions {
  /** Poll interval; docs/02 §1 says 1s. */
  intervalMs?: number;
  batchSize?: number;
  /** Called with the number of events published in each successful batch (metrics). */
  onPublished?: (count: number) => void;
}

/**
 * Publishes unpublished outbox rows to `tms.events` with publisher confirms, then
 * marks them published. Delivery is at-least-once: if marking fails after the broker
 * confirmed, the rows are published again and idempotent consumers drop the copy.
 * `FOR UPDATE SKIP LOCKED` lets several instances of a service relay safely.
 */
export class OutboxRelay {
  private timer?: NodeJS.Timeout;
  private running?: Promise<unknown>;

  constructor(
    private readonly db: Database,
    private readonly rabbit: RabbitConnection,
    private readonly logger: Logger,
    private readonly options: OutboxRelayOptions = {},
  ) {}

  start(): void {
    if (this.timer) return;
    this.timer = setInterval(() => void this.tick(), this.options.intervalMs ?? 1000);
  }

  async stop(): Promise<void> {
    clearInterval(this.timer);
    this.timer = undefined;
    await this.running;
  }

  /** One polling round; skipped while the previous round runs or the broker is down. */
  private async tick(): Promise<void> {
    if (this.running || !this.rabbit.isReady()) return;
    this.running = this.publishBatch()
      .then((count) => count > 0 && this.options.onPublished?.(count))
      .catch((err: Error) =>
        this.logger.error(`outbox relay failed: ${err.message}`, 'OutboxRelay'),
      )
      .finally(() => (this.running = undefined));
    await this.running;
  }

  /** Publishes up to one batch. Returns how many events were published. */
  async publishBatch(): Promise<number> {
    return this.db.transaction(async (tx) => {
      const rows = await tx.$queryRawUnsafe<OutboxRow[]>(
        `SELECT id::text AS id, routing_key, payload FROM outbox_events
          WHERE published_at IS NULL ORDER BY created_at LIMIT $1 FOR UPDATE SKIP LOCKED`,
        this.options.batchSize ?? 100,
      );
      if (rows.length === 0) return 0;

      const channel = await this.rabbit.publishChannel();
      for (const row of rows) {
        channel.publish(
          EVENTS_EXCHANGE,
          row.routing_key,
          Buffer.from(JSON.stringify(row.payload)),
          {
            persistent: true,
            contentType: 'application/json',
            messageId: row.id,
            correlationId: row.payload.correlationId,
            type: row.payload.eventType,
          },
        );
      }
      await channel.waitForConfirms();

      const placeholders = rows.map((_, i) => `$${i + 1}::uuid`).join(', ');
      await tx.$executeRawUnsafe(
        `UPDATE outbox_events SET published_at = now() WHERE id IN (${placeholders})`,
        ...rows.map((r) => r.id),
      );
      return rows.length;
    });
  }
}
