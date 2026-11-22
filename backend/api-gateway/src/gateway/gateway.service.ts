import { randomUUID } from 'node:crypto';
import type { IncomingMessage, OutgoingHttpHeaders, ServerResponse } from 'node:http';
import { Injectable, type OnApplicationShutdown } from '@nestjs/common';
import { HTTP_BUCKETS, HTTP_METRICS_RECORDED, MetricsService, onResponseDone } from '@tms/common';
import { Id } from '@tms/contracts';
import { Histogram } from 'prom-client';
import { forward, sendJson } from './proxy';
import { RateLimiter } from './rate-limiter';
import { resolveRoute, routeLabel, serviceUrls, type ServiceKey } from './routes';
import { TokenVerifier } from './token-verifier';

type Request = IncomingMessage & { ip?: string; originalUrl?: string };

/**
 * The single entry point for clients (docs/02 §2): resolve the route, rate-limit,
 * authenticate with the Firebase ID token, rewrite identity headers, proxy.
 * Mounted on `/api` by configureApp.
 */
@Injectable()
export class GatewayService implements OnApplicationShutdown {
  private readonly urls: Record<ServiceKey, string> = serviceUrls();
  private readonly verifier = new TokenVerifier();
  private readonly limiter = new RateLimiter(
    process.env.REDIS_URL,
    process.env.RATE_LIMIT_PREFIX ?? 'rl',
    Number(process.env.RATE_LIMIT_IP_PER_MINUTE ?? 600),
    Number(process.env.RATE_LIMIT_USER_PER_MINUTE ?? 300),
  );

  /**
   * Every /api request as the client saw it: route template, final status and the service
   * it was proxied to (`target`; `gateway` when the gateway answered itself: 401, 404, 429...).
   */
  private readonly requests: Histogram<'method' | 'route' | 'status' | 'target'>;

  constructor(metrics: MetricsService) {
    this.requests = new Histogram({
      name: 'tms_gateway_requests_seconds',
      help: 'Requests through the API gateway, by method, route template, status and target service',
      labelNames: ['method', 'route', 'status', 'target'],
      buckets: HTTP_BUCKETS,
      registers: [metrics.registry],
    });
  }

  readonly handle = (req: Request, res: ServerResponse): void => {
    void this.process(req, res);
  };

  private async process(req: Request, res: ServerResponse): Promise<void> {
    (res as unknown as Record<symbol, unknown>)[HTTP_METRICS_RECORDED] = true;
    const stop = this.requests.startTimer();

    const incoming = req.headers['x-correlation-id'];
    const correlationId =
      typeof incoming === 'string' && Id.safeParse(incoming).success ? incoming : randomUUID();
    const responseHeaders: OutgoingHttpHeaders = { 'x-correlation-id': correlationId };
    const fail = (status: number, message: string, extra: OutgoingHttpHeaders = {}) =>
      sendJson(res, status, { statusCode: status, message }, { ...responseHeaders, ...extra });

    // Mounted on /api, so req.url is the downstream path (query string included).
    const path = req.url ?? '/';
    const route = resolveRoute(req.method ?? 'GET', path.split('?')[0]);
    const method = req.method ?? 'GET';
    const routeName = routeLabel(path.split('?')[0], route);
    let target: ServiceKey | 'gateway' = 'gateway'; // set once the request is proxied
    onResponseDone(res, () =>
      stop({ method, route: routeName, status: String(res.statusCode), target }),
    );
    if (route.kind === 'not-found') return fail(404, 'not found');
    if (route.kind === 'not-implemented')
      return fail(501, 'not implemented in the MVP (BR-SYS-03)');

    const ip = req.ip ?? req.socket.remoteAddress ?? 'unknown';
    const byIp = await this.limiter.forIp(ip);
    if (!byIp.allowed)
      return fail(429, 'too many requests', { 'retry-after': String(byIp.retryAfter) });

    // Never trust identity headers from the client.
    const headers: OutgoingHttpHeaders = {};
    for (const [name, value] of Object.entries(req.headers)) {
      if (!name.startsWith('x-user-') && name !== 'authorization') headers[name] = value;
    }
    headers['x-correlation-id'] = correlationId;
    headers['x-forwarded-for'] = ip;

    if (route.access !== 'public') {
      const idToken = req.headers.authorization?.match(/^Bearer (.+)$/i)?.[1];
      if (!idToken) return fail(401, 'missing Firebase ID token');
      let user;
      try {
        user = (await this.verifier.verify(idToken)).user;
      } catch {
        return fail(401, 'invalid, expired or revoked Firebase ID token');
      }

      if (route.access === 'token-only') {
        headers.authorization = req.headers.authorization; // Identity verifies it itself
      } else {
        if (!user)
          return fail(
            403,
            'this account has no role yet: finish registration or accept the invitation',
          );
        const byUser = await this.limiter.forUser(user.id);
        if (!byUser.allowed) {
          return fail(429, 'too many requests', { 'retry-after': String(byUser.retryAfter) });
        }
        headers['x-user-id'] = user.id;
        headers['x-user-role'] = user.role;
      }
    }

    target = route.service;
    forward(req, res, this.urls[route.service], path, headers, responseHeaders);
  }

  async onApplicationShutdown(): Promise<void> {
    await this.limiter.close();
  }
}
