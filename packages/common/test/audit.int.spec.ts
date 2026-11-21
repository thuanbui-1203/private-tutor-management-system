/**
 * Change records against a real PostgreSQL (docker compose up -d postgres):
 *   pnpm --filter @tms/common test:int
 * Uses its own throwaway database with sql/audit.sql applied.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';
import { queryChanges, recordChange, runWithCorrelationId, type SqlExecutor } from '../src';

const PG_ADMIN =
  process.env.TEST_PG_ADMIN_URL ?? 'postgresql://tms:tms_secret@localhost:5432/postgres';
const TUTOR = { id: '00000000-0000-4000-8000-000000000002', role: 'TUTOR' as const };

describe('audit_log against PostgreSQL', () => {
  const dbName = `common_audit_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Pool;
  let pool: Pool;
  let db: SqlExecutor;

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_ADMIN });
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = new Pool({ connectionString: PG_ADMIN.replace(/\/[^/]*$/, `/${dbName}`) });
    await pool.query(readFileSync(join(__dirname, '../sql/audit.sql'), 'utf8'));
    await pool.query('CREATE TABLE things (id TEXT PRIMARY KEY, status TEXT NOT NULL)');
    db = {
      $executeRawUnsafe: async (sql, ...values) => (await pool.query(sql, values)).rowCount ?? 0,
      $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
        (await pool.query(sql, values)).rows as T,
    };
  });

  afterAll(async () => {
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  /** Runs fn in one transaction on a dedicated client, like Prisma's $transaction. */
  async function transaction<T>(fn: (tx: SqlExecutor) => Promise<T>): Promise<T> {
    const client = await pool.connect();
    const tx: SqlExecutor = {
      $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount ?? 0,
      $queryRawUnsafe: async <R>(sql: string, ...values: unknown[]) =>
        (await client.query(sql, values)).rows as R,
    };
    try {
      await client.query('BEGIN');
      const result = await fn(tx);
      await client.query('COMMIT');
      return result;
    } catch (err) {
      await client.query('ROLLBACK');
      throw err;
    } finally {
      client.release();
    }
  }

  it('commits the record with the change and reads it back by correlation id', async () => {
    const correlationId = randomUUID();
    const id = randomUUID();
    await runWithCorrelationId(correlationId, () =>
      transaction(async (tx) => {
        await tx.$executeRawUnsafe('INSERT INTO things VALUES ($1, $2)', id, 'ACTIVE');
        await recordChange(tx, {
          action: 'thing.create',
          entityType: 'Thing',
          entityId: id,
          after: { status: 'ACTIVE', email: 'x@y.vn' },
          actor: TUTOR,
        });
      }),
    );
    const [record] = await queryChanges(db, 'billing', { correlationId, limit: 10 });
    expect(record).toMatchObject({
      service: 'billing',
      correlationId,
      actorId: TUTOR.id,
      actorRole: 'TUTOR',
      action: 'thing.create',
      entityId: id,
      changes: { status: { to: 'ACTIVE' }, email: { to: '[personal]' } },
    });
    expect(await queryChanges(db, 'billing', { entityId: id, limit: 10 })).toHaveLength(1);
    expect(await queryChanges(db, 'billing', { actorId: randomUUID(), limit: 10 })).toHaveLength(0);
  });

  it('leaves no record when the change rolls back', async () => {
    const id = randomUUID();
    await expect(
      transaction(async (tx) => {
        await recordChange(tx, {
          action: 'thing.create',
          entityType: 'Thing',
          entityId: id,
          after: { status: 'X' },
        });
        await tx.$executeRawUnsafe('INSERT INTO things VALUES ($1, NULL)', id); // violates NOT NULL
      }),
    ).rejects.toThrow();
    expect(await queryChanges(db, 'billing', { entityId: id, limit: 10 })).toHaveLength(0);
  });

  it('cannot be updated, deleted or truncated', async () => {
    await expect(pool.query("UPDATE audit_log SET action = 'x.y'")).rejects.toThrow(/insert-only/);
    await expect(pool.query('DELETE FROM audit_log')).rejects.toThrow(/insert-only/);
    await expect(pool.query('TRUNCATE audit_log')).rejects.toThrow(/insert-only/);
    expect(Number((await pool.query('SELECT count(*) AS n FROM audit_log')).rows[0].n)).toBe(1);
  });

  it('filters by time window, newest first, with a limit', async () => {
    const entityId = randomUUID();
    for (const status of ['A', 'B', 'C']) {
      await transaction((tx) =>
        recordChange(tx, {
          action: 'thing.update',
          entityType: 'Thing',
          entityId,
          after: { status },
        }),
      );
    }
    const all = await queryChanges(db, 'billing', { entityId, limit: 10 });
    expect(all.map((r) => r.changes.status.to)).toEqual(['C', 'B', 'A']);
    expect(await queryChanges(db, 'billing', { entityId, limit: 2 })).toHaveLength(2);
    const future = new Date(Date.now() + 60_000).toISOString();
    expect(await queryChanges(db, 'billing', { entityId, from: future, limit: 10 })).toHaveLength(
      0,
    );
    expect(await queryChanges(db, 'billing', { entityId, to: future, limit: 10 })).toHaveLength(3);
  });
});
