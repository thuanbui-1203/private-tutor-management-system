import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  Controller,
  Get,
  Inject,
  NotFoundException,
  Query,
} from '@nestjs/common';
import {
  ChangeRecord,
  InternalAuditQuery,
  type ActorRole,
  type FieldChange,
  type InternalAuditResponse,
} from '@tms/contracts';
import { Public, type AuthUser } from './auth';
import { currentActor, currentCorrelationId } from './correlation';
import type { SqlExecutor } from './database';
import { TMS_RUNTIME, type TmsRuntime } from './ops';

// Change records (ADR-0005): what changed, who changed it, in which request. Written in
// the caller's transaction, so a change and its record commit or roll back together.

/** Personal data: a Change record says the field changed, never its value (BR-ST-08). */
export const PERSONAL_FIELDS = [
  'fullName',
  'displayName',
  'email',
  'phone',
  'dob',
  'dateOfBirth',
  'address',
  'accountName',
  'payerContact',
  'contact',
  'parents',
  'note',
  'notes',
];

const SECRET =
  /(password|passwd|secret|token|credential|api_?key|private_?key|cvv|_enc$|enc(rypted)?$)/i;
const ACCOUNT_NUMBER = /^(account_?number|account_?no|bank_?account|card_?number|iban)$/i;

export const PERSONAL_MASK = '[personal]';
export const SECRET_MASK = '[secret]';

/** `••••1234` for an account number, so a record still tells two accounts apart. */
export function maskAccountNumber(value: unknown): string {
  const digits = typeof value === 'string' || typeof value === 'number' ? String(value) : '';
  return digits.length >= 4 ? `••••${digits.slice(-4)}` : SECRET_MASK;
}

/** Plain JSON: Dates → ISO strings, Prisma Decimals → strings, bigint → string. */
function toJson(value: unknown): unknown {
  if (value === undefined) return undefined;
  return JSON.parse(
    JSON.stringify(value, (_, v: unknown) => (typeof v === 'bigint' ? v.toString() : v)),
  );
}

/** Masks secrets and personal data at any depth. `personal` names the personal keys. */
export function redact(value: unknown, personal: ReadonlySet<string>, key?: string): unknown {
  if (value === null || value === undefined) return value;
  if (key !== undefined) {
    if (ACCOUNT_NUMBER.test(key)) return maskAccountNumber(value);
    if (SECRET.test(key)) return SECRET_MASK;
    if (personal.has(key)) return PERSONAL_MASK;
  }
  if (Array.isArray(value)) return value.map((v) => redact(v, personal));
  if (typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([k, v]) => [k, redact(v, personal, k)]),
    );
  }
  return value;
}

/** Fields that never carry meaning in a diff. */
const IGNORED = new Set(['updatedAt']);

/**
 * The changed fields between two versions of an entity, already masked. On create
 * (`before` missing) every field of `after` is listed, on delete every field of `before`.
 */
export function diffFields(
  before: object | null | undefined,
  after: object | null | undefined,
  personal: ReadonlySet<string>,
): Record<string, FieldChange> {
  const a = (toJson(before ?? undefined) ?? {}) as Record<string, unknown>;
  const b = (toJson(after ?? undefined) ?? {}) as Record<string, unknown>;
  const changes: Record<string, FieldChange> = {};
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    if (IGNORED.has(key)) continue;
    const from = a[key];
    const to = b[key];
    if (before && after && JSON.stringify(from) === JSON.stringify(to)) continue;
    const change: FieldChange = {};
    if (before && key in a) change.from = redact(from, personal, key);
    if (after && key in b) change.to = redact(to, personal, key);
    changes[key] = change;
  }
  return changes;
}

export interface ChangeInput {
  /** `<entity>.<verb>`, e.g. `student.update`. */
  action: string;
  entityType: string;
  entityId: string;
  before?: object | null;
  after?: object | null;
  /** Extra personal keys for this entity, on top of PERSONAL_FIELDS. */
  personal?: string[];
  /** Defaults to the request's signed-in user, or SYSTEM outside a request. */
  actor?: AuthUser | 'SYSTEM';
}

/**
 * Writes a Change record into `audit_log` with `tx`, the transaction of the change
 * itself. Throws (and so rolls the change back) when the record is invalid.
 */
export async function recordChange(tx: SqlExecutor, input: ChangeInput): Promise<ChangeRecord> {
  const actor = input.actor ?? currentActor() ?? 'SYSTEM';
  const personal = new Set([...PERSONAL_FIELDS, ...(input.personal ?? [])]);
  const record = ChangeRecord.parse({
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    service: '',
    correlationId: currentCorrelationId() ?? null,
    actorId: actor === 'SYSTEM' ? null : actor.id,
    actorRole: (actor === 'SYSTEM' ? 'SYSTEM' : actor.role) satisfies ActorRole,
    action: input.action,
    entityType: input.entityType,
    entityId: input.entityId,
    changes: diffFields(input.before, input.after, personal),
  });
  await tx.$executeRawUnsafe(
    `INSERT INTO audit_log
       (id, occurred_at, correlation_id, actor_id, actor_role, action, entity_type, entity_id, changes)
     VALUES ($1::uuid, $2::timestamptz, $3::uuid, $4::uuid, $5, $6, $7, $8, $9::jsonb)`,
    record.id,
    record.occurredAt,
    record.correlationId,
    record.actorId,
    record.actorRole,
    record.action,
    record.entityType,
    record.entityId,
    JSON.stringify(record.changes),
  );
  return record;
}

interface AuditRow {
  id: string;
  occurred_at: Date | string;
  correlation_id: string | null;
  actor_id: string | null;
  actor_role: ActorRole;
  action: string;
  entity_type: string;
  entity_id: string;
  changes: Record<string, FieldChange>;
}

/** Reads this service's Change records, newest first. */
export async function queryChanges(
  db: SqlExecutor,
  service: string,
  q: InternalAuditQuery,
): Promise<ChangeRecord[]> {
  const rows = await db.$queryRawUnsafe<AuditRow[]>(
    `SELECT id, occurred_at, correlation_id, actor_id, actor_role, action, entity_type, entity_id, changes
       FROM audit_log
      WHERE ($1::uuid IS NULL OR correlation_id = $1::uuid)
        AND ($2::text IS NULL OR entity_id = $2::text)
        AND ($3::uuid IS NULL OR actor_id = $3::uuid)
        AND ($4::timestamptz IS NULL OR occurred_at >= $4::timestamptz)
        AND ($5::timestamptz IS NULL OR occurred_at < $5::timestamptz)
      ORDER BY occurred_at DESC, id DESC
      LIMIT $6`,
    q.correlationId ?? null,
    q.entityId ?? null,
    q.actorId ?? null,
    q.from ?? null,
    q.to ?? null,
    q.limit,
  );
  return rows.map((r) => ({
    id: r.id,
    occurredAt: new Date(r.occurred_at).toISOString(),
    service,
    correlationId: r.correlation_id,
    actorId: r.actor_id,
    actorRole: r.actor_role,
    action: r.action,
    entityType: r.entity_type,
    entityId: r.entity_id,
    changes: r.changes,
  }));
}

/** `GET /internal/audit`: audit-service reads each service's Change records here. */
@Public()
@Controller('internal/audit')
export class AuditController {
  constructor(@Inject(TMS_RUNTIME) private readonly runtime: TmsRuntime) {}

  @Get()
  async list(@Query() query: Record<string, unknown>): Promise<InternalAuditResponse> {
    const db = this.runtime.database;
    if (!db) throw new NotFoundException();
    const parsed = InternalAuditQuery.safeParse(query);
    if (!parsed.success) throw new BadRequestException(parsed.error.issues);
    const service = this.runtime.service;
    return { service, records: await queryChanges(db.executor, service, parsed.data) };
  }
}
