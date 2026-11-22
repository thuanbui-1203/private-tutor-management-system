import { z } from 'zod';
import { Role } from './enums';
import { Id, IsoDateTime } from './primitives';

// Audit trail (ADR-0005). Two kinds of record:
// - Access record: one per HTTP request at the API gateway, stored by audit-service.
// - Change record: one per business change, written by the owning service in the same
//   transaction as the change (table `audit_log`), read through `GET /internal/audit`.

/** Topic exchange for audit traffic, separate from business events (`tms.events`). */
export const AUDIT_EXCHANGE = 'tms.audit';

/** Routing key of an Access record on `tms.audit`. */
export const ACCESS_RECORDED = 'access.recorded';

/** audit-service's durable queue for Access records. */
export const ACCESS_QUEUE = 'audit.access-recorded';

/**
 * One request seen by the gateway, including the ones it answered itself (401, 404, 429…).
 * Never holds a body, a header value, a query value or a token: `path` has secret
 * segments replaced by `:token`, `queryKeys` only names the query parameters.
 */
export const AccessRecord = z.object({
  id: Id,
  occurredAt: IsoDateTime,
  correlationId: Id,
  /** users.id when the token was verified and carried a role; null otherwise. */
  userId: Id.nullable(),
  role: Role.nullable(),
  ip: z.string().max(64),
  userAgent: z.string().max(256).nullable(),
  method: z.string().min(1).max(10),
  path: z.string().min(1).max(512),
  queryKeys: z.array(z.string().max(64)).max(32),
  /** HTTP status sent to the client; 0 when the client went away before a response. */
  status: z.number().int().min(0).max(599),
  durationMs: z.number().nonnegative(),
  /** Service the request was proxied to; null when the gateway answered itself. */
  service: z.string().max(32).nullable(),
});
export type AccessRecord = z.infer<typeof AccessRecord>;

/** Who made a change: a signed-in user, or the system (consumers, scheduled jobs). */
export const ActorRole = z.union([Role, z.literal('SYSTEM')]);
export type ActorRole = z.infer<typeof ActorRole>;

/**
 * Masked values in a Change record: `[personal]` for personal data (never stored, so
 * Anonymisation stays complete), `[secret]` for secrets, `••••1234` for account numbers.
 */
export const FieldChange = z.object({ from: z.unknown().optional(), to: z.unknown().optional() });
export type FieldChange = z.infer<typeof FieldChange>;

export const ChangeRecord = z.object({
  id: Id,
  occurredAt: IsoDateTime,
  service: z.string(),
  correlationId: Id.nullable(),
  actorId: Id.nullable(),
  actorRole: ActorRole,
  /** `<entity>.<verb>`, e.g. `student.update`, `payment.reverse`. */
  action: z.string().regex(/^[a-z][a-z-]*\.[a-z][a-z-]*$/),
  entityType: z.string().min(1),
  entityId: z.string().min(1),
  /** Only the fields that changed (all fields on create / delete). */
  changes: z.record(z.string(), FieldChange),
});
export type ChangeRecord = z.infer<typeof ChangeRecord>;

/** Query of `GET /internal/audit` in every business service (called by audit-service). */
export const InternalAuditQuery = z.object({
  correlationId: Id.optional(),
  entityId: z.string().min(1).max(100).optional(),
  actorId: Id.optional(),
  from: IsoDateTime.optional(),
  to: IsoDateTime.optional(),
  limit: z.coerce.number().int().min(1).max(500).default(100),
});
export type InternalAuditQuery = z.infer<typeof InternalAuditQuery>;

export const InternalAuditResponse = z.object({
  service: z.string(),
  records: z.array(ChangeRecord),
});
export type InternalAuditResponse = z.infer<typeof InternalAuditResponse>;
