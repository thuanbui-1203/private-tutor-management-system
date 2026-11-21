import { AsyncLocalStorage } from 'node:async_hooks';
import { randomUUID } from 'node:crypto';
import type { NextFunction, Request, Response } from 'express';
import { Id } from '@tms/contracts';
import type { AuthUser } from './auth';

/**
 * Carries the correlation id through a request or a consumed message, so logs and
 * every event published while handling it share the id that came in at the gateway.
 */
const storage = new AsyncLocalStorage<{ correlationId: string; actor?: AuthUser }>();

export const CORRELATION_HEADER = 'x-correlation-id';

export function currentCorrelationId(): string | undefined {
  return storage.getStore()?.correlationId;
}

/** The signed-in user of the current request (set by AuthGuard); undefined in consumers and jobs. */
export function currentActor(): AuthUser | undefined {
  return storage.getStore()?.actor;
}

/** Called by AuthGuard once the X-User-* headers are validated, so Change records know who acted. */
export function setCurrentActor(actor: AuthUser): void {
  const store = storage.getStore();
  if (store) store.actor = actor;
}

export function runWithCorrelationId<T>(correlationId: string, fn: () => T): T {
  return storage.run({ correlationId }, fn);
}

/** Express middleware: reuse a valid incoming X-Correlation-Id or start a new one. */
export function correlationMiddleware(req: Request, res: Response, next: NextFunction): void {
  const incoming = req.header(CORRELATION_HEADER);
  const correlationId = Id.safeParse(incoming).success ? (incoming as string) : randomUUID();
  res.setHeader(CORRELATION_HEADER, correlationId);
  runWithCorrelationId(correlationId, next);
}
