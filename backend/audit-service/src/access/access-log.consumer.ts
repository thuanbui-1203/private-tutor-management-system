import {
  Inject,
  Injectable,
  Logger,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
  type OnModuleInit,
} from '@nestjs/common';
import { TMS_RUNTIME, type TmsRuntime } from '@tms/common';
import {
  ACCESS_QUEUE,
  ACCESS_RECORDED,
  AccessRecord,
  AUDIT_EXCHANGE,
  DEAD_LETTER_EXCHANGE,
} from '@tms/contracts';
import type { Channel, ConsumeMessage } from 'amqplib';
import { AccessLogStore } from './access-log.store';

const DLQ = 'audit.dlq';
const DAY_MS = 86_400_000;
export const retentionDays = () => Number(process.env.AUDIT_RETENTION_DAYS ?? 365);

/**
 * Stores the Access records the gateway publishes on `tms.audit` (ADR-0005). A record
 * that breaks the contract goes to `audit.dlq`; a database failure puts the message
 * back after a second, so nothing is acknowledged before it is stored.
 */
@Injectable()
export class AccessLogConsumer
  implements OnModuleInit, OnApplicationBootstrap, OnApplicationShutdown
{
  private readonly logger = new Logger(AccessLogConsumer.name);
  private purgeTimer?: NodeJS.Timeout;

  constructor(
    @Inject(TMS_RUNTIME) private readonly runtime: TmsRuntime,
    private readonly store: AccessLogStore,
  ) {}

  async onModuleInit(): Promise<void> {
    const rabbit = this.runtime.rabbit;
    if (!rabbit) {
      this.logger.warn('RABBITMQ_URL not set: not consuming Access records');
      return;
    }
    await rabbit.onConnect(async (model) => {
      const channel = await model.createChannel();
      await channel.assertExchange(AUDIT_EXCHANGE, 'topic', { durable: true });
      await channel.assertQueue(ACCESS_QUEUE, {
        durable: true,
        arguments: {
          'x-dead-letter-exchange': DEAD_LETTER_EXCHANGE,
          'x-dead-letter-routing-key': 'audit.access-recorded',
        },
      });
      await channel.bindQueue(ACCESS_QUEUE, AUDIT_EXCHANGE, ACCESS_RECORDED);
      await channel.assertQueue(DLQ, { durable: true });
      await channel.bindQueue(DLQ, DEAD_LETTER_EXCHANGE, 'audit.#');
      await channel.prefetch(50);
      await channel.consume(ACCESS_QUEUE, (msg) => {
        if (msg) void this.handle(channel, msg);
      });
    });
  }

  async handle(channel: Pick<Channel, 'ack' | 'nack'>, msg: ConsumeMessage): Promise<void> {
    let record: AccessRecord;
    try {
      record = AccessRecord.parse(JSON.parse(msg.content.toString()));
    } catch (err) {
      this.logger.warn(`invalid Access record dead-lettered: ${(err as Error).message}`);
      channel.nack(msg, false, false);
      return;
    }
    try {
      await this.store.insert(record);
      channel.ack(msg);
    } catch (err) {
      this.logger.warn(`could not store Access record ${record.id}: ${(err as Error).message}`);
      setTimeout(() => channel.nack(msg, false, true), 1000).unref();
    }
  }

  onApplicationBootstrap(): void {
    const purge = () =>
      this.store
        .purgeOlderThan(new Date(Date.now() - retentionDays() * DAY_MS))
        .then((n) => n && this.logger.log(`purged ${n} Access record(s) past retention`))
        .catch((err: Error) => this.logger.warn(`retention purge failed: ${err.message}`));
    this.purgeTimer = setInterval(purge, 6 * 3_600_000);
    this.purgeTimer.unref();
  }

  onApplicationShutdown(): void {
    clearInterval(this.purgeTimer);
  }
}
