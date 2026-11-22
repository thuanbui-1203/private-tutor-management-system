/**
 * Integration tests for #54 (audit-service) against a throwaway database and the real broker:
 *   docker compose up -d postgres rabbitmq && pnpm --filter @tms/audit-service test:int
 * (On an older data volume, create the role first: infra/postgres/add-audit-db.sql.)
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { connect, type ChannelModel, type ConsumeMessage } from 'amqplib';
import request from 'supertest';
import {
  ACCESS_RECORDED,
  AUDIT_EXCHANGE,
  type AccessRecord,
  type ChangeRecord,
} from '@tms/contracts';
import { TMS_RUNTIME, type TmsRuntime } from '@tms/common';
import { AccessLogConsumer } from '../src/access/access-log.consumer';
import { AccessLogStore } from '../src/access/access-log.store';
import { as, createTestDb, type TestDb } from './support';

const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://tms:tms_dev@localhost:5672';
const admin = as('ADMIN');
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function record(over: Partial<AccessRecord> = {}): AccessRecord {
  return {
    id: randomUUID(),
    occurredAt: new Date().toISOString(),
    correlationId: randomUUID(),
    userId: null,
    role: null,
    ip: '10.0.0.1',
    userAgent: 'jest',
    method: 'GET',
    path: '/students',
    queryKeys: [],
    status: 200,
    durationMs: 12.5,
    service: 'student',
    ...over,
  };
}

const message = (body: unknown) =>
  ({ content: Buffer.from(JSON.stringify(body)) }) as ConsumeMessage;
const fakeChannel = () => ({ ack: jest.fn(), nack: jest.fn() });

/** A fake business service answering GET /internal/audit with fixed records. */
function fakeService(name: string, records: ChangeRecord[]): Promise<Server> {
  const server = createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ service: name, records, query: req.url }));
  });
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)));
}

const change = (service: string, occurredAt: string, correlationId: string): ChangeRecord => ({
  id: randomUUID(),
  occurredAt,
  service,
  correlationId,
  actorId: randomUUID(),
  actorRole: 'TUTOR',
  action: 'student.update',
  entityType: 'Student',
  entityId: randomUUID(),
  changes: { status: { from: 'ACTIVE', to: 'PAUSED' } },
});

describe('audit-service (#54)', () => {
  let env: TestDb;
  let app: INestApplication;
  let broker: ChannelModel;
  const servers: Server[] = [];
  const correlationId = randomUUID();
  const identityChange = change('identity', '2026-11-22T01:00:00.000Z', correlationId);
  const studentChange = change('student', '2026-11-22T02:00:00.000Z', correlationId);

  beforeAll(async () => {
    env = await createTestDb('audit_it');
    process.env.RABBITMQ_URL = AMQP_URL;
    servers.push(await fakeService('identity', [identityChange]));
    servers.push(await fakeService('student', [studentChange]));
    const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;
    process.env.IDENTITY_SERVICE_URL = url(servers[0]);
    process.env.STUDENT_SERVICE_URL = url(servers[1]);
    // Nothing listens on port 1: class, schedule and billing are "down".
    for (const s of ['CLASS', 'SCHEDULE', 'BILLING'])
      process.env[`${s}_SERVICE_URL`] = 'http://127.0.0.1:1';

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
    await app.get<TmsRuntime>(TMS_RUNTIME).rabbit?.waitForConnect();
    broker = await connect(AMQP_URL);
  });

  afterAll(async () => {
    await broker?.close();
    await app?.close();
    for (const s of servers) s.close();
    await env?.close();
  });

  const http = () => request(app.getHttpServer());
  const count = async (id: string) =>
    Number(
      (await env.db.query('SELECT count(*) AS n FROM access_log WHERE id = $1', [id])).rows[0].n,
    );

  it('stores an Access record published on tms.audit', async () => {
    const r = record({ path: '/billing/invoices' });
    const channel = await broker.createConfirmChannel();
    await channel.assertExchange(AUDIT_EXCHANGE, 'topic', { durable: true });
    channel.publish(AUDIT_EXCHANGE, ACCESS_RECORDED, Buffer.from(JSON.stringify(r)), {
      persistent: true,
    });
    await channel.waitForConfirms();
    await channel.close();
    for (let i = 0; i < 100 && (await count(r.id)) === 0; i++) await wait(50);
    expect(await count(r.id)).toBe(1);
  });

  it('a duplicate delivery stores one row; an invalid record is dead-lettered, not stored', async () => {
    const consumer = app.get(AccessLogConsumer);
    const r = record();
    const ch = fakeChannel();
    await consumer.handle(ch, message(r));
    await consumer.handle(ch, message(r));
    expect(ch.ack).toHaveBeenCalledTimes(2);
    expect(await count(r.id)).toBe(1);

    const bad = fakeChannel();
    await consumer.handle(bad, message({ ...record(), status: 'two hundred' }));
    await consumer.handle(bad, { content: Buffer.from('not json') } as ConsumeMessage);
    expect(bad.nack.mock.calls).toEqual([
      [expect.anything(), false, false],
      [expect.anything(), false, false],
    ]);
    expect(bad.ack).not.toHaveBeenCalled();
  });

  it('GET /audit/access filters and pages newest first, for Admins only', async () => {
    const store = app.get(AccessLogStore);
    const userId = randomUUID();
    const base = Date.parse('2026-06-01T00:00:00Z');
    for (let i = 0; i < 5; i++) {
      await store.insert(
        record({
          userId,
          role: 'TUTOR',
          occurredAt: new Date(base + i * 1000).toISOString(),
          status: i === 4 ? 404 : 200,
        }),
      );
    }
    const first = await http().get(`/audit/access?userId=${userId}&limit=2`).set(admin).expect(200);
    expect(first.body.items.map((r: AccessRecord) => r.occurredAt)).toEqual([
      new Date(base + 4000).toISOString(),
      new Date(base + 3000).toISOString(),
    ]);
    const second = await http()
      .get(`/audit/access?userId=${userId}&limit=2&cursor=${first.body.nextCursor}`)
      .set(admin)
      .expect(200);
    const third = await http()
      .get(`/audit/access?userId=${userId}&limit=2&cursor=${second.body.nextCursor}`)
      .set(admin)
      .expect(200);
    expect(second.body.items).toHaveLength(2);
    expect(third.body.items).toHaveLength(1);
    expect(third.body.nextCursor).toBeNull();

    const notFound = await http()
      .get(`/audit/access?userId=${userId}&status=404`)
      .set(admin)
      .expect(200);
    expect(notFound.body.items).toHaveLength(1);
    const window = await http()
      .get(
        `/audit/access?userId=${userId}&from=${new Date(base + 1000).toISOString()}&to=${new Date(base + 3000).toISOString()}`,
      )
      .set(admin)
      .expect(200);
    expect(window.body.items).toHaveLength(2);

    await http().get('/audit/access').set(as('TUTOR')).expect(403);
    await http().get('/audit/access').expect(401);
    await http().get('/audit/access?userId=nope').set(admin).expect(400);
  });

  it('Access records cannot be changed or deleted, except by the retention purge', async () => {
    const old = record({ occurredAt: '2020-01-01T00:00:00.000Z' });
    const recent = record();
    const store = app.get(AccessLogStore);
    await store.insert(old);
    await store.insert(recent);
    await expect(
      env.db.query('UPDATE access_log SET status = 500 WHERE id = $1', [recent.id]),
    ).rejects.toThrow(/insert-only/);
    await expect(env.db.query('DELETE FROM access_log WHERE id = $1', [recent.id])).rejects.toThrow(
      /insert-only/,
    );
    await expect(env.db.query('TRUNCATE access_log')).rejects.toThrow(/insert-only/);

    expect(await store.purgeOlderThan(new Date('2021-01-01T00:00:00Z'))).toBeGreaterThanOrEqual(1);
    expect(await count(old.id)).toBe(0);
    expect(await count(recent.id)).toBe(1);
  });

  it('GET /audit/changes merges every service newest first and names those that did not answer', async () => {
    const { body } = await http()
      .get(`/audit/changes?correlationId=${correlationId}`)
      .set(admin)
      .expect(200);
    expect(body.records.map((r: ChangeRecord) => r.service)).toEqual(['student', 'identity']);
    expect(body.unavailable.sort()).toEqual(['billing', 'class', 'schedule']);
    await http().get('/audit/changes').set(as('PARENT')).expect(403);
  });
});
