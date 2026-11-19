import { Controller, Get, Header, HttpStatus, Inject, Injectable, Res } from '@nestjs/common';
import type { Response } from 'express';
import { collectDefaultMetrics, Counter, Registry } from 'prom-client';
import { Public } from './auth';
import type { Database } from './database';
import type { RabbitConnection } from './messaging/connection';

export const TMS_RUNTIME = Symbol('TMS_RUNTIME');

/** What health checks look at; built by TmsCommonModule. */
export interface TmsRuntime {
  service: string;
  database?: Database;
  rabbit?: RabbitConnection;
}

/** Prometheus registry per app (not the global one, so tests can boot apps repeatedly). */
@Injectable()
export class MetricsService {
  readonly registry = new Registry();
  readonly eventsConsumed = new Counter({
    name: 'tms_events_consumed_total',
    help: 'Consumed events by type and outcome (handled, duplicate, retried, dead-lettered)',
    labelNames: ['event_type', 'outcome'],
    registers: [this.registry],
  });
  readonly outboxPublished = new Counter({
    name: 'tms_outbox_published_total',
    help: 'Events published from the outbox',
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}

/** Liveness (process up) and readiness (database and broker reachable), docs/02 §1. */
@Public()
@Controller('health')
export class HealthController {
  constructor(@Inject(TMS_RUNTIME) private readonly runtime: TmsRuntime) {}

  @Get('live')
  live() {
    return { status: 'ok', service: this.runtime.service };
  }

  @Get('ready')
  async ready(@Res({ passthrough: true }) res: Response) {
    const checks: Record<string, 'up' | 'down'> = {};
    if (this.runtime.database) {
      checks.database = await this.runtime.database.executor
        .$queryRawUnsafe('SELECT 1')
        .then(() => 'up' as const)
        .catch(() => 'down' as const);
    }
    if (this.runtime.rabbit) checks.broker = this.runtime.rabbit.isReady() ? 'up' : 'down';
    const ok = Object.values(checks).every((c) => c === 'up');
    res.status(ok ? HttpStatus.OK : HttpStatus.SERVICE_UNAVAILABLE);
    return { status: ok ? 'ok' : 'unavailable', service: this.runtime.service, checks };
  }
}

@Public()
@Controller('metrics')
export class MetricsController {
  constructor(private readonly metrics: MetricsService) {}

  @Get()
  @Header('Content-Type', 'text/plain; version=0.0.4; charset=utf-8')
  scrape(): Promise<string> {
    return this.metrics.registry.metrics();
  }
}
