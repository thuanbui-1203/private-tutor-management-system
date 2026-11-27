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
  signUpWithPassword,
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

  const register = (idToken?: string, role = 'TUTOR') => {
    const req = request(app.getHttpServer()).post('/auth/register').send({ role });
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
      selfRegistered: true,
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

  it.each(['PARENT', 'STUDENT'])('a %s can create their own account', async (role) => {
    const email = uniqueEmail(role.toLowerCase());
    const { idToken } = await signUp(email);
    const { body } = await register(idToken, role).expect(201);
    expect(body).toMatchObject({ role, status: 'ACTIVE' });
    expect(claimsOf((await signIn(email)).idToken)).toMatchObject({ role, userId: body.id });
  });

  it('nobody can choose ADMIN; only an e-mail in ADMIN_EMAILS becomes one', async () => {
    const { idToken } = await signUp(uniqueEmail('wannabe'));
    await register(idToken, 'ADMIN').expect(400);

    const boss = uniqueEmail('boss');
    process.env.ADMIN_EMAILS = `someone@example.com, ${boss.toUpperCase()}`;
    try {
      const { body } = await register((await signUp(boss)).idToken, 'STUDENT').expect(201);
      expect(body.role).toBe('ADMIN');
      const { body: other } = await register(idToken, 'TUTOR').expect(201);
      expect(other.role).toBe('TUTOR');
    } finally {
      delete process.env.ADMIN_EMAILS;
    }
  });

  it('refuses an unverified e-mail, from a password account or from Google', async () => {
    await register((await signUpWithPassword(uniqueEmail('password'))).idToken).expect(401);
    const unverified = await signIn(uniqueEmail('unverified'), false);
    await register(unverified.idToken).expect(401);
  });

  it('registers a password account once its e-mail is verified', async () => {
    const email = uniqueEmail('verified-password');
    const { idToken } = await signUpWithPassword(email, true);
    const { body } = await register(idToken, 'PARENT').expect(201);
    expect(body).toMatchObject({ email, role: 'PARENT', status: 'ACTIVE' });
  });

  it('a seeded Admin gets their account at the first Google sign-in, with the role it has', async () => {
    const email = uniqueEmail('seeded');
    const { rows } = await env.db.query(
      `INSERT INTO users (id, email, role, status, updated_at)
       VALUES (gen_random_uuid(), $1, 'ADMIN', 'ACTIVE', now()) RETURNING id`,
      [email],
    );
    const { idToken, localId } = await signUp(email);
    const { body } = await register(idToken, 'STUDENT').expect(201);
    expect(body).toMatchObject({ id: rows[0].id, role: 'ADMIN' });
    const linked = await env.db.query('SELECT firebase_uid FROM users WHERE id = $1', [rows[0].id]);
    expect(linked.rows[0].firebase_uid).toBe(localId);
    expect(claimsOf((await signIn(email)).idToken)).toMatchObject({
      role: 'ADMIN',
      userId: rows[0].id,
    });
  });

  it.each([
    ['DISABLED', 403],
    ['PENDING', 409],
  ])('a %s user cannot come back in by registering again', async (status, code) => {
    const email = uniqueEmail(status.toLowerCase());
    await env.db.query(
      `INSERT INTO users (id, email, role, status, updated_at)
       VALUES (gen_random_uuid(), $1, 'PARENT', $2::"UserStatus", now())`,
      [email, status],
    );
    await register((await signUp(email)).idToken, 'PARENT').expect(code);
    expect(claimsOf((await signIn(email)).idToken).role).toBeUndefined();
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
