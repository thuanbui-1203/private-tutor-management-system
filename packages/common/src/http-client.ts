import type { z } from 'zod';
import { CORRELATION_HEADER, currentCorrelationId } from './correlation';

/** The callee answered with a 4xx: a real answer, so never retried and not a breaker failure. */
export class HttpError extends Error {
  constructor(
    readonly status: number,
    readonly body: unknown,
    url: string,
  ) {
    super(`${url} responded ${status}`);
  }
}

/** The callee timed out, was unreachable or answered 5xx on every attempt. */
export class ServiceUnavailableError extends Error {}

/** The circuit is open: the call was not attempted. Callers fall back (e.g. enrollment → PENDING). */
export class CircuitOpenError extends ServiceUnavailableError {}

export interface CircuitBreakerOptions {
  /** Consecutive failures that open the circuit. */
  failureThreshold?: number;
  /** How long the circuit stays open before one trial call is let through. */
  resetAfterMs?: number;
}

/** CLOSED → OPEN after N consecutive failures → HALF_OPEN after a pause → CLOSED on success. */
export class CircuitBreaker {
  private failures = 0;
  private openedAt?: number;

  constructor(
    private readonly options: CircuitBreakerOptions = {},
    private readonly now: () => number = Date.now,
  ) {}

  get state(): 'CLOSED' | 'OPEN' | 'HALF_OPEN' {
    if (this.openedAt === undefined) return 'CLOSED';
    return this.now() - this.openedAt >= (this.options.resetAfterMs ?? 30_000)
      ? 'HALF_OPEN'
      : 'OPEN';
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.state === 'OPEN') throw new CircuitOpenError('circuit open');
    try {
      const result = await fn();
      this.failures = 0;
      this.openedAt = undefined;
      return result;
    } catch (err) {
      if (err instanceof ServiceUnavailableError) {
        this.failures++;
        if (this.state === 'HALF_OPEN' || this.failures >= (this.options.failureThreshold ?? 5)) {
          this.openedAt = this.now();
        }
      }
      throw err;
    }
  }
}

export interface InternalHttpClientOptions {
  /** Per attempt. docs/02 §1: 2 s. */
  timeoutMs?: number;
  /** Extra attempts after the first. docs/02 §1: 2. */
  retries?: number;
  breaker?: CircuitBreakerOptions;
}

/**
 * Client for synchronous service-to-service calls (`/internal/**`), with the
 * timeout, retries and circuit breaker from docs/02 §1. Forwards X-Correlation-Id
 * and validates responses against a schema from @tms/contracts.
 */
export class InternalHttpClient {
  private readonly breaker: CircuitBreaker;

  constructor(
    private readonly baseUrl: string,
    private readonly options: InternalHttpClientOptions = {},
  ) {
    this.breaker = new CircuitBreaker(options.breaker);
  }

  get circuitState() {
    return this.breaker.state;
  }

  get<T>(path: string, schema: z.ZodType<T>): Promise<T> {
    return this.request('GET', path, undefined, schema);
  }

  post<T>(path: string, body: unknown, schema: z.ZodType<T>): Promise<T> {
    return this.request('POST', path, body, schema);
  }

  private request<T>(
    method: string,
    path: string,
    body: unknown,
    schema: z.ZodType<T>,
  ): Promise<T> {
    return this.breaker.run(async () => {
      const url = `${this.baseUrl}${path}`;
      const attempts = 1 + (this.options.retries ?? 2);
      let lastError: unknown;
      for (let attempt = 1; attempt <= attempts; attempt++) {
        try {
          const res = await fetch(url, {
            method,
            headers: {
              'content-type': 'application/json',
              ...(currentCorrelationId() && { [CORRELATION_HEADER]: currentCorrelationId() }),
            },
            body: body === undefined ? undefined : JSON.stringify(body),
            signal: AbortSignal.timeout(this.options.timeoutMs ?? 2_000),
          });
          const payload = await res.json().catch(() => undefined);
          if (res.status >= 400 && res.status < 500) throw new HttpError(res.status, payload, url);
          if (!res.ok) throw new Error(`${url} responded ${res.status}`);
          return schema.parse(payload);
        } catch (err) {
          if (err instanceof HttpError || isZodError(err)) throw err; // definitive answers
          lastError = err;
        }
      }
      throw new ServiceUnavailableError(
        `${method} ${url} failed after ${attempts} attempts: ${(lastError as Error)?.message}`,
      );
    });
  }
}

function isZodError(err: unknown): boolean {
  return err instanceof Error && err.name === 'ZodError';
}
