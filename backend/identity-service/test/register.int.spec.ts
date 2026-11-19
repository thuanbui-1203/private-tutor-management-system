/**
 * Integration tests for #6 against the Firebase Auth emulator (never the real project):
 *   docker compose up -d postgres && pnpm emulators   # in another terminal
 *   pnpm --filter @tms/identity-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import {
  claimsOf,
  clearEmulatorAccounts,
  createTestEnv,
  signIn,
  signUp,
  uniqueEmail,
  type TestEnv,
} from './support';

describe('Identity: Tutor registration with Firebase Auth (#6)', () => {
  let env: TestEnv;
  let app: INestApplication;

  beforeAll(async () => {
    env = await createTestEnv('identity_it');
    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
    await clearEmulatorAccounts();
  });

  const register = (idToken?: string) => {
    const req = request(app.getHttpServer()).post('/auth/register');
    return idToken ? req.set('authorization', `Bearer ${idToken}`) : req;
  };

  it('registers a Tutor: users row, UserRegistered in the outbox, userId + role claims', async () => {
    const email = uniqueEmail('Tutor').replace('example', 'Example');
    const { idToken, localId } = await signUp(email);

    const res = await register(idToken).expect(201);
    expect(res.body).toMatchObject({ email: email.toLowerCase(), role: 'TUTOR', status: 'ACTIVE' });
    const userId: string = res.body.id;
    expect(userId).toMatch(/^[0-9a-f-]{36}$/);
    expect(userId).not.toBe(localId); // our UUID, never the Firebase uid

    const row = await env.db.query('SELECT firebase_uid, role FROM users WHERE id = $1', [userId]);
    expect(row.rows[0]).toEqual({ firebase_uid: localId, role: 'TUTOR' });

    const outbox = await env.db.query(
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
    const email = uniqueEmail('twice');
    const { idToken } = await signUp(email);
    await register(idToken).expect(201);

    await register(idToken).expect(409); // old token, no claims yet: the row already exists
    const fresh = await signIn(email);
    await register(fresh.idToken).expect(409); // fresh token already has a role
    const rows = await env.db.query('SELECT count(*)::int AS n FROM users WHERE email = $1', [
      email,
    ]);
    expect(rows.rows[0].n).toBe(1);
  });

  it('rejects a missing or invalid token with 401', async () => {
    await register().expect(401);
    await register('not-a-token').expect(401);
  });

  it('GET /users/me returns the signed-in user from X-User-Id', async () => {
    const { idToken } = await signUp(uniqueEmail('me'));
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
