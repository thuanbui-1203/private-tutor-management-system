import {
  Global,
  Inject,
  Injectable,
  Logger as NestLogger,
  Module,
  type DynamicModule,
  type MiddlewareConsumer,
  type ModuleMetadata,
  type NestModule,
  type OnApplicationBootstrap,
  type OnApplicationShutdown,
} from '@nestjs/common';
import { APP_GUARD } from '@nestjs/core';
import type { EventType, ServiceName } from '@tms/contracts';
import { AuthGuard } from './auth';
import { correlationMiddleware } from './correlation';
import type { Database } from './database';
import { RabbitConnection } from './messaging/connection';
import { EventConsumer, type ConsumerOptions, type EventHandler } from './messaging/consumer';
import {
  HealthController,
  HttpMetricsMiddleware,
  MetricsController,
  MetricsService,
  TMS_RUNTIME,
  type TmsRuntime,
} from './ops';
import { OutboxRelay, type OutboxRelayOptions } from './outbox';

/** Values only known at runtime (from env or other providers). */
export interface TmsCommonRuntimeOptions {
  /** Enables the outbox relay, consumers and the database readiness check. */
  database?: Database;
  /** Enables messaging. Leave undefined (e.g. in unit tests) to run without RabbitMQ. */
  rabbitmqUrl?: string;
  relay?: OutboxRelayOptions;
  consumer?: Omit<ConsumerOptions, 'onSettled'>;
}

export interface TmsCommonModuleOptions {
  service: ServiceName | 'api-gateway';
  /** Install the X-User-* AuthGuard globally. Default true; false for the gateway, which authenticates itself. */
  auth?: boolean;
  imports?: ModuleMetadata['imports'];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  inject?: any[];
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  useFactory?: (...args: any[]) => TmsCommonRuntimeOptions | Promise<TmsCommonRuntimeOptions>;
}

const RUNTIME_OPTIONS = Symbol('TMS_RUNTIME_OPTIONS');
const logger = new NestLogger('TmsCommon');

/** Subscribe to events. A no-op with a warning when messaging is not configured. */
@Injectable()
export class Messaging implements OnApplicationBootstrap, OnApplicationShutdown {
  private readonly consumer?: EventConsumer;
  private readonly relay?: OutboxRelay;

  constructor(
    @Inject(TMS_RUNTIME) private readonly runtime: TmsRuntime,
    @Inject(RUNTIME_OPTIONS) options: TmsCommonRuntimeOptions,
    metrics: MetricsService,
  ) {
    const { database, rabbit, service } = runtime;
    if (database && rabbit && service !== 'api-gateway') {
      this.consumer = new EventConsumer(service as ServiceName, database, rabbit, logger, {
        ...options.consumer,
        onSettled: (eventType, outcome) =>
          metrics.eventsConsumed.inc({ event_type: eventType, outcome }),
      });
      this.relay = new OutboxRelay(database, rabbit, logger, {
        ...options.relay,
        onPublished: (n) => metrics.outboxPublished.inc(n),
      });
    }
  }

  get enabled(): boolean {
    return this.consumer !== undefined;
  }

  subscribe<T extends EventType>(eventType: T, handler: EventHandler<T>): Promise<void> {
    if (!this.consumer) {
      logger.warn(
        `messaging disabled (no RABBITMQ_URL / database); not subscribing to ${eventType}`,
      );
      return Promise.resolve();
    }
    return this.consumer.subscribe(eventType, handler);
  }

  async onApplicationBootstrap(): Promise<void> {
    await this.runtime.rabbit?.start();
    this.relay?.start();
  }

  async onApplicationShutdown(): Promise<void> {
    await this.relay?.stop();
    await this.runtime.rabbit?.close();
  }
}

/**
 * Shared plumbing for every service: correlation ids, X-User-* auth guard,
 * /health/live, /health/ready, /metrics (with per-route HTTP metrics), outbox relay and
 * event consumers.
 *
 * ```ts
 * TmsCommonModule.forRoot({
 *   service: 'billing',
 *   imports: [PrismaModule],
 *   inject: [PrismaService],
 *   useFactory: (prisma: PrismaService) => ({
 *     database: prismaDatabase(prisma),
 *     rabbitmqUrl: process.env.RABBITMQ_URL,
 *   }),
 * })
 * ```
 */
@Global()
@Module({})
export class TmsCommonModule implements NestModule {
  static forRoot(options: TmsCommonModuleOptions): DynamicModule {
    return {
      module: TmsCommonModule,
      imports: options.imports ?? [],
      controllers: [HealthController, MetricsController],
      providers: [
        {
          provide: RUNTIME_OPTIONS,
          inject: options.inject ?? [],
          useFactory: options.useFactory ?? (() => ({})),
        },
        {
          provide: TMS_RUNTIME,
          inject: [RUNTIME_OPTIONS],
          useFactory: (runtime: TmsCommonRuntimeOptions): TmsRuntime => ({
            service: options.service,
            database: runtime.database,
            rabbit: runtime.rabbitmqUrl
              ? new RabbitConnection(runtime.rabbitmqUrl, logger)
              : undefined,
          }),
        },
        MetricsService,
        Messaging,
        ...(options.auth === false ? [] : [{ provide: APP_GUARD, useClass: AuthGuard }]),
      ],
      exports: [Messaging, MetricsService, TMS_RUNTIME],
    };
  }

  configure(consumer: MiddlewareConsumer): void {
    consumer.apply(correlationMiddleware, HttpMetricsMiddleware).forRoutes('*');
  }
}
