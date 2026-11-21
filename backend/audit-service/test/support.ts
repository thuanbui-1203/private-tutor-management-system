/** Shared setup for audit-service integration tests: a throwaway database from the real migrations. */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

const PG = process.env.TEST_AUDIT_PG ?? 'postgresql://audit:audit@localhost:5432';

export const as = (role: string, id: string = randomUUID()) => ({
  'x-user-id': id,
  'x-user-role': role,
});

export interface TestDb {
  db: Pool;
  close(): Promise<void>;
}

/** Creates the database, applies every migration and points DATABASE_URL at it. */
export async function createTestDb(prefix: string): Promise<TestDb> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: `${PG}/audit_db` });
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Pool({ connectionString: `${PG}/${name}` });
  const migrations = join(__dirname, '../prisma/migrations');
  for (const dir of readdirSync(migrations)
    .filter((d) => /^\d+_/.test(d))
    .sort()) {
    await db.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
  }
  process.env.DATABASE_URL = `${PG}/${name}`;
  delete process.env.RABBITMQ_URL;
  delete process.env.STUDENT_SERVICE_URL;
  return {
    db,
    async close() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}
