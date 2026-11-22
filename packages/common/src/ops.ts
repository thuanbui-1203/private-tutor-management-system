import {
  Controller,
  Get,
  Header,
  HttpStatus,
  Inject,
  Injectable,
  Res,
  type NestMiddleware,
} from '@nestjs/common';
import type { ServerResponse } from 'node:http';
import type { NextFunction, Request, Response } from 'express';
import { collectDefaultMetrics, Counter, Gauge, Histogram, Registry } from 'prom-client';
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

/** Latency buckets (seconds) shared by the service and gateway request histograms. */
export const HTTP_BUCKETS = [0.005, 0.01, 0.025, 0.05, 0.1, 0.25, 0.5, 1, 2.5, 5, 10];

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

  /**
   * Every HTTP request this service answered, by route template (`/billing/invoices/:id`,
   * never the raw path, so ids do not create new series). Grafana's API dashboard reads it.
   */
  readonly httpRequests = new Histogram({
    name: 'http_server_requests_seconds',
    help: 'HTTP requests answered, by method, route template and status code',
    labelNames: ['method', 'route', 'status'],
    buckets: HTTP_BUCKETS,
    registers: [this.registry],
  });
  readonly httpInFlight = new Gauge({
    name: 'http_server_requests_in_flight',
    help: 'HTTP requests currently being handled',
    labelNames: ['method'],
    registers: [this.registry],
  });

  constructor() {
    collectDefaultMetrics({ register: this.registry });
  }
}

/** Route label for requests no route matched (404s, scanners): one series, not one per path. */
export const UNMATCHED_ROUTE = 'UNMATCHED';

/**
 * Set on a response by code that records its own request metrics (the gateway's /api proxy),
 * so HttpMetricsMiddleware does not count the request twice.
 */
export const HTTP_METRICS_RECORDED = Symbol.for('tms.http-metrics-recorded');

/** Scrapes, health probes and Swagger are not user traffic. */
const UNMEASURED = /^\/(metrics|health|docs)(\/|-|$)/;

/** Times each request and records it under its Express route template once the response ends. */
@Injectable()
export class HttpMetricsMiddleware implements NestMiddleware {
  constructor(private readonly metrics: MetricsService) {}

  use(req: Request, res: Response, next: NextFunction): void {
    const path = (req.originalUrl ?? req.url).split('?')[0];
    if (UNMEASURED.test(path)) return next();

    const method = req.method;
    const inFlight = this.metrics.httpInFlight.labels(method);
    const stop = this.metrics.httpRequests.startTimer();
    inFlight.inc();
    onResponseDone(res, () => {
      inFlight.dec();
      if ((res as unknown as Record<symbol, unknown>)[HTTP_METRICS_RECORDED]) return;
      // req.route is set by Express once a controller route matched.
      const template = (req.route as { path?: unknown } | undefined)?.path;
      const route =
        typeof template === 'string' ? `${req.baseUrl ?? ''}${template}` : UNMATCHED_ROUTE;
      stop({ method, route, status: String(res.statusCode) });
    });
    next();
  }
}

/** Runs `fn` once when the response finished or the client went away. */
export function onResponseDone(res: ServerResponse, fn: () => void): void {
  let done = false;
  const once = () => {
    if (done) return;
    done = true;
    fn();
  };
  res.once('finish', once);
  res.once('close', once);
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
