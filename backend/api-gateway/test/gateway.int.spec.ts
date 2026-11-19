/**
 * Integration tests for #8 against the Firebase Auth emulator, Redis, and fake
 * downstream services:
 *   docker compose up -d redis && pnpm emulators   # in another terminal
 *   pnpm --filter @tms/api-gateway test:int
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import request from 'supertest';

const EMULATOR = process.env.TEST_AUTH_EMULATOR ?? '127.0.0.1:9099';
const PROJECT = 'demo-tms';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const SERVICES = ['identity', 'student', 'class', 'schedule', 'billing'] as const;
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

interface Seen {
  service: string;
  method: string;
  path: string;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

async function emulator(path: string, body: unknown) {
  const res = await fetch(`http://${EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=fake`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`${path}: ${await res.text()}`);
  return (await res.json()) as { idToken: string; localId: string };
}

/** An unsigned token like the emulator issues, with arbitrary claims (forged / expired). */
function craftToken(claims: Record<string, unknown>) {
  const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
  const now = Math.floor(Date.now() / 1000);
  return `${b64({ alg: 'none', typ: 'JWT' })}.${b64({
    iss: `https://securetoken.google.com/${PROJECT}`,
    aud: PROJECT,
    auth_time: now,
    iat: now,
    exp: now + 3600,
    sub: 'no-such-user',
    user_id: 'no-such-user',
    ...claims,
  })}.`;
}

describe('API gateway (#8)', () => {
  const seen: Seen[] = [];
  const upstreams: Server[] = [];
  const firebaseAuth = () => getAuth(getApps()[0] ?? initializeApp({ projectId: PROJECT }));

  async function bootGateway(env: Record<string, string>) {
    Object.assign(process.env, env);
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    return app;
  }

  /** An emulator account with (optionally) the userId + role claims Identity would set. */
  async function account(claims?: { role: string }) {
    const email = `gw.${randomUUID().slice(0, 8)}@example.com`;
    const created = await emulator('accounts:signUp', {
      email,
      password: 'secret123',
      returnSecureToken: true,
    });
    const userId = randomUUID();
    if (claims)
      await firebaseAuth().setCustomUserClaims(created.localId, { userId, role: claims.role });
    const { idToken } = await emulator('accounts:signInWithPassword', {
      email,
      password: 'secret123',
      returnSecureToken: true,
    });
    return { uid: created.localId, userId, idToken };
  }

  let app: INestApplication;

  beforeAll(async () => {
    process.env.FIREBASE_AUTH_EMULATOR_HOST = EMULATOR;
    process.env.FIREBASE_PROJECT_ID = PROJECT;
    const urls: Record<string, string> = {};
    for (const service of SERVICES) {
      const server = createServer((req, res) => {
        let body = '';
        req.on('data', (c) => (body += c));
        req.on('end', () => {
          seen.push({ service, method: req.method!, path: req.url!, headers: req.headers, body });
          res.writeHead(200, { 'content-type': 'application/json', 'x-upstream': service });
          res.end(JSON.stringify({ service }));
        });
      });
      await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
      upstreams.push(server);
      urls[`${service.toUpperCase()}_SERVICE_URL`] =
        `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    }
    app = await bootGateway({
      ...urls,
      REDIS_URL,
      RATE_LIMIT_PREFIX: `rl-test-${randomUUID()}`,
      RATE_LIMIT_IP_PER_MINUTE: '1000',
      RATE_LIMIT_USER_PER_MINUTE: '1000',
    });
  });

  afterAll(async () => {
    await app?.close();
    for (const s of upstreams) await new Promise((r) => s.close(r));
    await fetch(`http://${EMULATOR}/emulator/v1/projects/${PROJECT}/accounts`, {
      method: 'DELETE',
    });
  });

  const http = () => request(app.getHttpServer());
  const last = () => seen[seen.length - 1];

  it('rejects a missing, junk, forged or expired token with 401', async () => {
    const before = seen.length;
    await http().get('/api/users/me').expect(401);
    await http().get('/api/users/me').set('authorization', 'Bearer junk').expect(401);
    const forged = craftToken({ userId: randomUUID(), role: 'ADMIN' }); // account does not exist
    await http().get('/api/users/me').set('authorization', `Bearer ${forged}`).expect(401);
    const { uid } = await account({ role: 'TUTOR' });
    const now = Math.floor(Date.now() / 1000);
    const expired = craftToken({
      sub: uid,
      user_id: uid,
      iat: now - 7200,
      auth_time: now - 7200,
      exp: now - 3600,
    });
    await http().get('/api/users/me').set('authorization', `Bearer ${expired}`).expect(401);
    expect(seen.length).toBe(before); // nothing reached a service
  });

  it('rejects a revoked token with 401', async () => {
    const user = await account({ role: 'TUTOR' });
    await http().get('/api/users/me').set('authorization', `Bearer ${user.idToken}`).expect(200);
    await wait(1100); // revocation is compared in whole seconds
    await firebaseAuth().revokeRefreshTokens(user.uid);
    await http().get('/api/users/me').set('authorization', `Bearer ${user.idToken}`).expect(401);
  });

  it('forwards the userId claim (not the Firebase uid) and overwrites spoofed identity headers', async () => {
    const user = await account({ role: 'TUTOR' });
    const correlationId = randomUUID();
    const res = await http()
      .get('/api/students?status=ACTIVE')
      .set('authorization', `Bearer ${user.idToken}`)
      .set('x-user-id', randomUUID())
      .set('x-user-role', 'ADMIN')
      .set('x-correlation-id', correlationId)
      .expect(200);
    expect(res.headers['x-upstream']).toBe('student');
    expect(res.headers['x-correlation-id']).toBe(correlationId);
    const got = last();
    expect(got).toMatchObject({ service: 'student', path: '/students?status=ACTIVE' });
    expect(got.headers['x-user-id']).toBe(user.userId);
    expect(got.headers['x-user-id']).not.toBe(user.uid);
    expect(got.headers['x-user-role']).toBe('TUTOR');
    expect(got.headers['x-correlation-id']).toBe(correlationId);
    expect(got.headers.authorization).toBeUndefined(); // services rely on X-User-*, not the token
  });

  it('requires the role claims, except on register (which gets the token, not X-User-*)', async () => {
    const fresh = await account(); // signed up in Firebase, not registered with Identity yet
    await http().get('/api/users/me').set('authorization', `Bearer ${fresh.idToken}`).expect(403);
    await http()
      .post('/api/auth/register')
      .set('authorization', `Bearer ${fresh.idToken}`)
      .expect(200);
    expect(last()).toMatchObject({ service: 'identity', method: 'POST', path: '/auth/register' });
    expect(last().headers.authorization).toBe(`Bearer ${fresh.idToken}`);
    expect(last().headers['x-user-id']).toBeUndefined();
  });

  it('lets invitation accept through without a token, body intact', async () => {
    await http()
      .post('/api/auth/invitations/tok123/accept')
      .set('x-user-id', randomUUID()) // spoofing attempt on a public route
      .send({ password: 'long-enough-1' })
      .expect(200);
    expect(last()).toMatchObject({ service: 'identity', path: '/auth/invitations/tok123/accept' });
    expect(JSON.parse(last().body)).toEqual({ password: 'long-enough-1' });
    expect(last().headers['x-user-id']).toBeUndefined();
  });

  it('routes path exceptions to the owning service', async () => {
    const { idToken } = await account({ role: 'PARENT' });
    const auth = { authorization: `Bearer ${idToken}` };
    expect((await http().get('/api/students/1/classes').set(auth)).headers['x-upstream']).toBe(
      'class',
    );
    expect((await http().get('/api/students/1/attendance').set(auth)).headers['x-upstream']).toBe(
      'schedule',
    );
    expect((await http().get('/api/billing/invoices').set(auth)).headers['x-upstream']).toBe(
      'billing',
    );
  });

  it('hides /internal, answers 501 outside the MVP and 404 for unknown paths', async () => {
    const { idToken } = await account({ role: 'ADMIN' });
    const auth = { authorization: `Bearer ${idToken}` };
    await http().get('/api/internal/students/1').set(auth).expect(404);
    await http().post('/api/internal/invitations').expect(404);
    await http().get('/api/academic/grades').set(auth).expect(501);
    await http().get('/api/nope').set(auth).expect(404);
  });

  it('answers 502 when the service is down', async () => {
    const { idToken } = await account({ role: 'TUTOR' });
    const billing = upstreams[SERVICES.indexOf('billing')];
    await new Promise((r) => billing.close(r));
    await http().get('/api/billing/invoices').set('authorization', `Bearer ${idToken}`).expect(502);
  });

  it('answers CORS preflight for the frontend origin', async () => {
    const res = await http()
      .options('/api/users/me')
      .set('origin', 'http://localhost:5173')
      .set('access-control-request-method', 'GET');
    expect(res.headers['access-control-allow-origin']).toBe('http://localhost:5173');
  });
});

describe('API gateway rate limiting (#8)', () => {
  it('returns 429 with Retry-After once an IP exceeds its per-minute budget', async () => {
    Object.assign(process.env, {
      REDIS_URL,
      RATE_LIMIT_PREFIX: `rl-test-${randomUUID()}`,
      RATE_LIMIT_IP_PER_MINUTE: '3',
    });
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    const app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    try {
      const statuses: number[] = [];
      for (let i = 0; i < 4; i++)
        statuses.push((await request(app.getHttpServer()).get('/api/users/me')).status);
      expect(statuses).toEqual([401, 401, 401, 429]);
      const limited = await request(app.getHttpServer()).get('/api/users/me');
      expect(Number(limited.headers['retry-after'])).toBeGreaterThan(0);
    } finally {
      await app.close();
    }
  });
});
