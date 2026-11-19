/**
 * Integration tests for #6 against the Firebase Auth emulator (never the real project)
 * and a throwaway database built from this service's migrations:
 *   docker compose up -d postgres && pnpm emulators   # in another terminal
 *   pnpm --filter @tms/identity-service test:int
 */
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Pool } from 'pg';
import request from 'supertest';

const EMULATOR = process.env.TEST_AUTH_EMULATOR ?? '127.0.0.1:9099';
const PROJECT = 'demo-tms'; // demo-* projects only ever exist in the emulator
const PG = process.env.TEST_IDENTITY_PG ?? 'postgresql://identity:identity@localhost:5432';
const dbName = `identity_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;

const identityToolkit = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;

async function emulatorCall(path: string, body: unknown) {
  const res = await fetch(`${identityToolkit}/${path}?key=fake-api-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  const json = await res.json();
  if (!res.ok) throw new Error(`${path}: ${JSON.stringify(json)}`);
  return json as { idToken: string; localId: string };
}

/** What the frontend does with the Firebase SDK: create an account, or sign in. */
const signUp = (email: string) =>
  emulatorCall('accounts:signUp', { email, password: 'secret123', returnSecureToken: true });
const signIn = (email: string) =>
  emulatorCall('accounts:signInWithPassword', {
    email,
    password: 'secret123',
    returnSecureToken: true,
  });

const claimsOf = (idToken: string) =>
  JSON.parse(Buffer.from(idToken.split('.')[1], 'base64url').toString()) as Record<string, unknown>;

describe('Identity: Tutor registration with Firebase Auth (#6)', () => {
  let admin: Pool;
  let db: Pool;
  let app: INestApplication;

  beforeAll(async () => {
    admin = new Pool({ connectionString: `${PG}/identity_db` });
    await admin.query(`CREATE DATABASE ${dbName}`);
    db = new Pool({ connectionString: `${PG}/${dbName}` });
    const migrations = join(__dirname, '../prisma/migrations');
    for (const dir of readdirSync(migrations)
      .filter((d) => /^\d+_/.test(d))
      .sort()) {
      await db.query(readFileSync(join(migrations, dir, 'migration.sql'), 'utf8'));
    }

    process.env.DATABASE_URL = `${PG}/${dbName}`;
    process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = PROJECT;
    delete process.env.RABBITMQ_URL; // the outbox row is enough; no relay here

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await db?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
    await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: 'DELETE',
    });
  });

  const register = (idToken?: string) => {
    const req = request(app.getHttpServer()).post('/auth/register');
    return idToken ? req.set('authorization', `Bearer ${idToken}`) : req;
  };

  it('registers a Tutor: users row, UserRegistered in the outbox, userId + role claims', async () => {
    const email = `Tutor.${randomUUID().slice(0, 8)}@Example.com`;
    const { idToken, localId } = await signUp(email);

    const res = await register(idToken).expect(201);
    expect(res.body).toMatchObject({ email: email.toLowerCase(), role: 'TUTOR', status: 'ACTIVE' });
    const userId: string = res.body.id;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(userId).not.toBe(localId); // our UUID, never the Firebase uid

    const row = await db.query('SELECT firebase_uid, role FROM users WHERE id = $1', [userId]);
    expect(row.rows[0]).toEqual({ firebase_uid: localId, role: 'TUTOR' });

    const outbox = await db.query(
      `SELECT payload FROM outbox_events WHERE event_type = 'UserRegistered' AND payload->'data'->>'userId' = $1`,
      [userId],
    );
    expect(outbox.rows[0].payload.data).toEqual({
      userId,
      email: email.toLowerCase(),
      role: 'TUTOR',
    });

    // A fresh ID token (what the SDK gets after refresh) carries the claims.
    const fresh = await signIn(email);
    expect(claimsOf(fresh.idToken)).toMatchObject({ role: 'TUTOR', userId });
  });

  it('registering twice is a 409, with the old token or with a fresh one', async () => {
    const email = `twice.${randomUUID().slice(0, 8)}@example.com`;
    const { idToken } = await signUp(email);
    await register(idToken).expect(201);

    await register(idToken).expect(409); // old token, no claims yet: the row already exists
    const fresh = await signIn(email);
    await register(fresh.idToken).expect(409); // fresh token already has a role
    const rows = await db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [email]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('rejects a missing or invalid token with 401', async () => {
    await register().expect(401);
    await register('not-a-token').expect(401);
  });

  it('GET /users/me returns the signed-in user from X-User-Id', async () => {
    const { idToken } = await signUp(`me.${randomUUID().slice(0, 8)}@example.com`);
    const { body: created } = await register(idToken).expect(201);

    const me = await request(app.getHttpServer())
      .get('/users/me')
      .set('x-user-id', created.id)
      .set('x-user-role', 'TUTOR')
      .expect(200);
    expect(me.body).toMatchObject({ id: created.id, role: 'TUTOR' });

    await request(app.getHttpServer())
      .get('/users/me')
      .set('x-user-id', randomUUID())
      .set('x-user-role', 'TUTOR')
      .expect(404);
    await request(app.getHttpServer()).get('/users/me').expect(401);
  });
});
