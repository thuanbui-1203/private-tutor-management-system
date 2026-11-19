import type { ChannelModel, ConfirmChannel, ConsumeMessage } from 'amqplib';
import {
  DEAD_LETTER_EXCHANGE,
  deadLetterQueueName,
  EVENTS_EXCHANGE,
  queueName,
  routingKeyOf,
  safeParseEvent,
  type EventEnvelope,
  type EventType,
  type ServiceName,
} from '@tms/contracts';
import { runWithCorrelationId } from '../correlation';
import type { Database, SqlExecutor } from '../database';
import type { Logger } from '../logger';
import type { RabbitConnection } from './connection';

/** docs/02 §10: up to 3 retries, 5s → 30s → 2 min, then the service's DLQ. */
export const DEFAULT_RETRY_DELAYS_MS = [5_000, 30_000, 120_000] as const;

const RETRY_HEADER = 'x-retry-count';

export type EventHandler<T extends EventType> = (
  event: EventEnvelope<T>,
  tx: SqlExecutor,
) => Promise<void>;

export interface ConsumerOptions {
  retryDelaysMs?: readonly number[];
  prefetch?: number;
  /** Called after each message is settled; used for metrics. */
  onSettled?: (
    eventType: string,
    outcome: 'handled' | 'duplicate' | 'retried' | 'dead-lettered',
  ) => void;
}

/**
 * Subscribes a service to events with the guarantees in docs/02 §1 and §10:
 * - the handler runs in one DB transaction together with the `processed_events`
 *   insert, so a redelivered event is skipped (idempotent consumer);
 * - the message is acked only after that transaction commits;
 * - a failure goes to `<queue>.retry.<n>` (a TTL queue that dead-letters back to the
 *   main queue); after the last retry, or for a message that breaks the contract,
 *   it goes to `tms.dlx` → `<service>.dlq` with the error in `x-error`.
 * Separate retry queues per delay avoid a long delay blocking a short one.
 */
export class EventConsumer {
  constructor(
    private readonly service: ServiceName,
    private readonly db: Database,
    private readonly rabbit: RabbitConnection,
    private readonly logger: Logger,
    private readonly options: ConsumerOptions = {},
  ) {}

  private get delays(): readonly number[] {
    return this.options.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  }

  subscribe<T extends EventType>(eventType: T, handler: EventHandler<T>): Promise<void> {
    return this.rabbit.onConnect(async (model) => {
      const channel = await this.declareTopology(model, eventType);
      await channel.prefetch(this.options.prefetch ?? 10);
      await channel.consume(queueName(this.service, eventType), (msg) => {
        if (msg) void this.handle(channel, eventType, handler, msg);
      });
    });
  }

  private async declareTopology(
    model: ChannelModel,
    eventType: EventType,
  ): Promise<ConfirmChannel> {
    const channel = await model.createConfirmChannel();
    const queue = queueName(this.service, eventType);
    const dlq = deadLetterQueueName(this.service);

    await channel.assertQueue(queue, { durable: true });
    await channel.bindQueue(queue, EVENTS_EXCHANGE, routingKeyOf(eventType));
    for (const [i, delay] of this.delays.entries()) {
      await channel.assertQueue(`${queue}.retry.${i + 1}`, {
        durable: true,
        arguments: {
          'x-message-ttl': delay,
          'x-dead-letter-exchange': '',
          'x-dead-letter-routing-key': queue,
        },
      });
    }
    await channel.assertQueue(dlq, { durable: true });
    await channel.bindQueue(dlq, DEAD_LETTER_EXCHANGE, `${this.service}.#`);
    return channel;
  }

  private async handle<T extends EventType>(
    channel: ConfirmChannel,
    eventType: T,
    handler: EventHandler<T>,
    msg: ConsumeMessage,
  ): Promise<void> {
    const queue = queueName(this.service, eventType);
    const parsed = safeParseJson(msg.content);
    const result = parsed.ok ? safeParseEvent(parsed.value) : undefined;
    if (!result?.success || result.event.eventType !== eventType) {
      const reason = !parsed.ok
        ? 'message is not JSON'
        : result && !result.success
          ? `contract violation: ${result.error.message}`
          : `unexpected eventType on ${queue}`;
      await this.deadLetter(channel, queue, eventType, msg, reason);
      return;
    }
    const event = result.event as EventEnvelope<T>;

    try {
      const handled = await runWithCorrelationId(event.correlationId, () =>
        this.db.transaction(async (tx) => {
          const inserted = await tx.$executeRawUnsafe(
            'INSERT INTO processed_events (event_id) VALUES ($1::uuid) ON CONFLICT DO NOTHING',
            event.eventId,
          );
          if (inserted === 0) return false; // already processed: duplicate delivery
          await handler(event, tx);
          return true;
        }),
      );
      channel.ack(msg);
      this.options.onSettled?.(eventType, handled ? 'handled' : 'duplicate');
    } catch (err) {
      const error = err instanceof Error ? err : new Error(String(err));
      const retries = Number(msg.properties.headers?.[RETRY_HEADER] ?? 0);
      if (retries < this.delays.length) {
        await this.republish(channel, msg, `${queue}.retry.${retries + 1}`, retries + 1, error);
        this.logger.warn(
          `${eventType} ${event.eventId} failed (attempt ${retries + 1}), retrying: ${error.message}`,
          'EventConsumer',
        );
        this.options.onSettled?.(eventType, 'retried');
      } else {
        await this.deadLetter(channel, queue, eventType, msg, error.message);
      }
    }
  }

  private async republish(
    channel: ConfirmChannel,
    msg: ConsumeMessage,
    retryQueue: string,
    retryCount: number,
    error: Error,
  ): Promise<void> {
    channel.sendToQueue(retryQueue, msg.content, {
      ...msg.properties,
      persistent: true,
      headers: {
        ...msg.properties.headers,
        [RETRY_HEADER]: retryCount,
        'x-last-error': error.message,
      },
    });
    await channel.waitForConfirms();
    channel.ack(msg);
  }

  private async deadLetter(
    channel: ConfirmChannel,
    queue: string,
    eventType: EventType,
    msg: ConsumeMessage,
    reason: string,
  ): Promise<void> {
    channel.publish(DEAD_LETTER_EXCHANGE, queue, msg.content, {
      ...msg.properties,
      persistent: true,
      headers: { ...msg.properties.headers, 'x-error': reason, 'x-original-queue': queue },
    });
    await channel.waitForConfirms();
    channel.ack(msg);
    this.logger.error(`message on ${queue} dead-lettered: ${reason}`, 'EventConsumer');
    this.options.onSettled?.(eventType, 'dead-lettered');
  }
}

function safeParseJson(content: Buffer): { ok: true; value: unknown } | { ok: false } {
  try {
    return { ok: true, value: JSON.parse(content.toString('utf8')) };
  } catch {
    return { ok: false };
  }
}
