/**
 * Integration tests for #55 (one Access record per request) against the real broker,
 * Redis, the Firebase Auth emulator and a fake downstream service:
 *   docker compose up -d redis rabbitmq && pnpm emulators   # in another terminal
 *   pnpm --filter @tms/api-gateway test:int
 */
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { MetricsService } from '@tms/common';
import { ACCESS_RECORDED, AUDIT_EXCHANGE, type AccessRecord } from '@tms/contracts';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { getApps, initializeApp } from 'firebase-admin/app';
import { getAuth } from 'firebase-admin/auth';
import request from 'supertest';
import { AccessLogPublisher } from '../src/gateway/access-log';

const EMULATOR = process.env.TEST_AUTH_EMULATOR ?? '127.0.0.1:9099';
const PROJECT = 'demo-tms';
const REDIS_URL = process.env.TEST_REDIS_URL ?? 'redis://localhost:6379';
const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://tms:tms_dev@localhost:5672';
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function tutorToken() {
  const email = `acc.${randomUUID().slice(0, 8)}@example.com`;
  const call = async (path: string) => {
    const res = await fetch(
      `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=fake`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ email, password: 'secret123', returnSecureToken: true }),
      },
    );
    return (await res.json()) as { idToken: string; localId: string };
  };
  const { localId } = await call('accounts:signUp');
  const userId = randomUUID();
  const auth = getAuth(getApps()[0] ?? initializeApp({ projectId: PROJECT }));
  await auth.setCustomUserClaims(localId, { userId, role: 'TUTOR' });
  return { userId, idToken: (await call('accounts:signInWithPassword')).idToken };
}

describe('Access records at the gateway (#55)', () => {
  let app: INestApplication;
  let upstream: Server;
  let broker: ChannelModel;
  let tap: Channel;
  const received: AccessRecord[] = [];
  const spoolDir = mkdtempSync(join(tmpdir(), 'gw-spool-'));

  beforeAll(async () => {
    broker = await connect(AMQP_URL);
    tap = await broker.createChannel();
    await tap.assertExchange(AUDIT_EXCHANGE, 'topic', { durable: true });
    const { queue } = await tap.assertQueue('', { exclusive: true, autoDelete: true });
    await tap.bindQueue(queue, AUDIT_EXCHANGE, ACCESS_RECORDED);
    await tap.consume(queue, (msg) => msg && received.push(JSON.parse(msg.content.toString())), {
      noAck: true,
    });

    upstream = createServer((_req, res) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end('{}');
    });
    await new Promise<void>((r) => upstream.listen(0, '127.0.0.1', r));
    const url = `http://127.0.0.1:${(upstream.address() as AddressInfo).port}`;

    Object.assign(process.env, {
      FIREBASE_AUTH_EMULATOR_HOST: EMULATOR,
      FIREBASE_PROJECT_ID: PROJECT,
      REDIS_URL,
      RABBITMQ_URL: AMQP_URL,
      AUDIT_SPOOL_DIR: spoolDir,
      RATE_LIMIT_PREFIX: `rl-acc-${randomUUID()}`,
      RATE_LIMIT_IP_PER_MINUTE: '6',
      RATE_LIMIT_USER_PER_MINUTE: '100',
      IDENTITY_SERVICE_URL: url,
      STUDENT_SERVICE_URL: url,
    });
    const { AppModule } = await import('../src/app.module');
    const { configureApp } = await import('../src/app.setup');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication({ bodyParser: false });
    configureApp(app);
    await app.init();
    for (let i = 0; i < 100; i++) {
      if (
        (
          app.get(AccessLogPublisher) as unknown as { rabbit: { isReady(): boolean } }
        ).rabbit.isReady()
      )
        break;
      await wait(50);
    }
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => upstream.close(r));
    await broker?.close();
    delete process.env.RABBITMQ_URL;
    delete process.env.AUDIT_SPOOL_DIR;
  });

  const http = () => request(app.getHttpServer());
  async function recordOf(correlationId: string): Promise<AccessRecord> {
    for (let i = 0; i < 100; i++) {
      const found = received.filter((r) => r.correlationId === correlationId);
      if (found.length) {
        await wait(100); // a second record for the same request would arrive by now
        expect(received.filter((r) => r.correlationId === correlationId)).toHaveLength(1);
        return found[0];
      }
      await wait(50);
    }
    throw new Error(`no Access record for ${correlationId}`);
  }

  it('200, 401, 404, 501 and 429 each leave exactly one Access record', async () => {
    const { userId, idToken } = await tutorToken();
    const ok = randomUUID();
    await http()
      .get('/api/students?status=ACTIVE&q=Nguyen')
      .set('authorization', `Bearer ${idToken}`)
      .set('x-correlation-id', ok)
      .set('user-agent', 'jest-agent')
      .expect(200);
    expect(await recordOf(ok)).toMatchObject({
      userId,
      role: 'TUTOR',
      method: 'GET',
      path: '/students',
      queryKeys: ['status', 'q'],
      status: 200,
      service: 'student',
      userAgent: 'jest-agent',
    });

    const unauthenticated = randomUUID();
    await http().get('/api/users/me').set('x-correlation-id', unauthenticated).expect(401);
    expect(await recordOf(unauthenticated)).toMatchObject({
      userId: null,
      role: null,
      status: 401,
      service: null,
    });

    const hidden = randomUUID();
    await http().get('/api/internal/students/x').set('x-correlation-id', hidden).expect(404);
    expect((await recordOf(hidden)).status).toBe(404);

    const outside = randomUUID();
    await http().get('/api/academic/grades').set('x-correlation-id', outside).expect(501);
    expect((await recordOf(outside)).status).toBe(501);

    // 6 per minute per IP (404 and 501 are answered before the limiter): spend the rest.
    let limited: string | undefined;
    for (let i = 0; i < 10 && !limited; i++) {
      const id = randomUUID();
      const { status } = await http().get('/api/users/me').set('x-correlation-id', id);
      if (status === 429) limited = id;
    }
    expect(limited).toBeDefined();
    expect((await recordOf(limited!)).status).toBe(429);
  });

  it('never records a token in the path, query values or the body', async () => {
    const id = randomUUID();
    // The IP budget may be spent by the previous test (then 429): the record is what matters.
    const { status } = await http()
      .post('/api/auth/invitations/SECRET-TOKEN-123/accept?ref=SECRET-QUERY')
      .set('x-correlation-id', id)
      .send({ password: 'SECRET-PASSWORD' });
    const record = await recordOf(id);
    expect(record).toMatchObject({
      path: '/auth/invitations/:token/accept',
      queryKeys: ['ref'],
      status,
    });
    expect(JSON.stringify(record)).not.toMatch(/SECRET/);
  });

  it('spools records while the broker is unreachable and publishes them once it is back', async () => {
    const metrics = new MetricsService();
    process.env.RABBITMQ_URL = 'amqp://tms:tms_dev@127.0.0.1:1';
    const offline = new AccessLogPublisher(metrics);
    process.env.RABBITMQ_URL = AMQP_URL;
    const record: AccessRecord = {
      id: randomUUID(),
      occurredAt: new Date().toISOString(),
      correlationId: randomUUID(),
      userId: null,
      role: null,
      ip: '127.0.0.1',
      userAgent: null,
      method: 'GET',
      path: '/classes',
      queryKeys: [],
      status: 200,
      durationMs: 3,
      service: 'class',
    };
    offline.submit(record);
    await offline.onApplicationShutdown(); // waits for the in-flight publish → spool
    const spooled = readFileSync(join(spoolDir, 'access-spool.jsonl'), 'utf8');
    expect(spooled).toContain(record.id);
    expect(
      await metrics.registry.getSingleMetricAsString('tms_audit_access_records_total'),
    ).toContain('outcome="spooled"} 1');

    const online = app.get(AccessLogPublisher);
    expect(await online.replay()).toBeGreaterThanOrEqual(1);
    expect((await recordOf(record.correlationId)).id).toBe(record.id);
  });
});
