import {
  connect,
  type ChannelModel,
  type ConfirmChannel,
  type RecoveringChannelModel,
} from 'amqplib';
import { DEAD_LETTER_EXCHANGE, EVENTS_EXCHANGE } from '@tms/contracts';
import type { Logger } from '../logger';

type Setup = (model: ChannelModel) => Promise<void>;

/**
 * One AMQP connection per service, using amqplib's built-in recovery: after every
 * (re)connect it declares the shared exchanges and re-runs each registered setup
 * (consumers re-declare their queues and start consuming again).
 */
export class RabbitConnection {
  private model?: RecoveringChannelModel;
  private current?: ChannelModel;
  private connected = false;
  private readonly setups: Setup[] = [];
  private publisher?: Promise<ConfirmChannel>;

  constructor(
    private readonly url: string,
    private readonly logger: Logger,
  ) {}

  async start(): Promise<void> {
    if (this.model) return;
    this.model = await connect(this.url, {
      recovery: {
        waitForConnect: false,
        maxDelay: 5000,
        setup: async (model: ChannelModel) => {
          this.current = model;
          this.publisher = undefined;
          await declareExchanges(model);
          for (const setup of this.setups) await setup(model);
        },
      },
    });
    this.model.on('connect', () => {
      this.connected = true;
      this.logger.log('connected to RabbitMQ', 'RabbitConnection');
    });
    this.model.on('disconnect', (err: Error) => {
      this.connected = false;
      this.publisher = undefined;
      this.logger.warn(`RabbitMQ disconnected: ${err.message}`, 'RabbitConnection');
    });
    this.model.on('error', (err: Error) =>
      this.logger.error(`RabbitMQ error: ${err.message}`, 'RabbitConnection'),
    );
  }

  /** Resolves once the first connection (and every registered setup) has completed. */
  async waitForConnect(): Promise<void> {
    await this.model?.waitForConnect();
  }

  isReady(): boolean {
    return this.connected;
  }

  /** Registers topology/consumer setup; runs now if already connected, and after every reconnect. */
  async onConnect(setup: Setup): Promise<void> {
    this.setups.push(setup);
    if (this.connected && this.current) await setup(this.current);
  }

  /** A confirm channel for publishing, recreated after a reconnect or channel error. */
  publishChannel(): Promise<ConfirmChannel> {
    if (!this.current) return Promise.reject(new Error('RabbitMQ is not connected'));
    if (!this.publisher) {
      const model = this.current;
      this.publisher = model.createConfirmChannel().then((channel) => {
        channel.on('close', () => (this.publisher = undefined));
        channel.on('error', () => (this.publisher = undefined));
        return channel;
      });
      this.publisher.catch(() => (this.publisher = undefined));
    }
    return this.publisher;
  }

  async close(): Promise<void> {
    this.connected = false;
    await this.model?.close().catch(() => undefined);
    this.model = undefined;
  }
}

async function declareExchanges(model: ChannelModel): Promise<void> {
  const channel = await model.createChannel();
  await channel.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
  await channel.assertExchange(DEAD_LETTER_EXCHANGE, 'topic', { durable: true });
  await channel.close();
}
