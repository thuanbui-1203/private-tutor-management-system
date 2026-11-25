/**
 * Shared setup for Identity's integration tests: the Firebase Auth emulator (project
 * demo-tms, which exists only in the emulator) and a throwaway database built from
 * this service's real migrations.
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export const EMULATOR = process.env.TEST_AUTH_EMULATOR ?? '127.0.0.1:9099';
export const PROJECT = 'demo-tms';
const PG = process.env.TEST_IDENTITY_PG ?? 'postgresql://identity:identity@localhost:5432';
const toolkit = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;

export const uniqueEmail = (prefix: string) => `${prefix}.${randomUUID().slice(0, 8)}@example.com`;

async function emulatorCall(path: string, body: unknown) {
  const res = await fetch(`${toolkit}/${path}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json as { idToken: string; localId: string };
}

/** What the frontend does with the Firebase SDK: Google sign-in (the emulator's fake Google). */
export const signIn = (email: string, emailVerified = true) => {
  const google = JSON.stringify({ sub: `google-${email}`, email, email_verified: emailVerified });
  return emulatorCall('accounts:signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(google)}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
    returnIdpCredential: true,
  });
};
/** The first sign-in of a new person. */
export const signUp = (email: string) => signIn(email);
/** An account that did not come through Google. */
export const signUpWithPassword = (email: string) =>
  emulatorCall('accounts:signUp', { email, password: 'secret123', returnSecureToken: true });

export const claimsOf = (idToken: string) =>
  JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

export interface TestEnv {
  db: Pool;
  close(): Promise<void>;
}

/** Creates the database, applies every migration, and points the app's env at it. */
export async function createTestEnv(prefix: string): Promise<TestEnv> {
  const name = `${prefix}_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  const admin = new Pool({ connectionString: `${PG}/identity_db` });
  await admin.query(`CREATE DATABASE ${name}`);
  const db = new Pool({ connectionString: `${PG}/${name}` });
  const migrations = join(__dirname, '../prisma/migrations');
  for (const dir of readdirSync(migrations)
    .filter((d) => /^\d+_/.test(d))
    .sort()) {
    await db.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
  }

  process.env.DATABASE_URL = `${PG}/${name}`;
  process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR;
  process.env.FIREBASE_PROJECT_ID = PROJECT;
  delete process.env.RABBITMQ_URL; // outbox rows are asserted directly; no relay here
  delete process.env.CLASS_SERVICE_URL;

  return {
    db,
    async close() {
      await db.end();
      await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
      await admin.end();
    },
  };
}

export async function clearEmulatorAccounts(): Promise<void> {
  await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/accounts`, { method: 'DELETE' });
}
