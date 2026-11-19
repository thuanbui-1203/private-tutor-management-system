/**
 * Integration tests against the real broker and database from docker compose:
 *   docker compose up -d postgres rabbitmq && pnpm --filter @tms/common test:int
 * Each run creates its own throwaway database and removes the queues it declared.
 */
import { randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { connect, type Channel, type ChannelModel } from 'amqplib';
import { Pool, type PoolClient } from 'pg';
import {
  deadLetterQueueName,
  EVENTS_EXCHANGE,
  queueName,
  type EventEnvelope,
} from '@tms/contracts';
import {
  enqueueEvent,
  EventConsumer,
  OutboxRelay,
  RabbitConnection,
  type Database,
  type SqlExecutor,
} from '../src';

const PG_ADMIN =
  process.env.TEST_PG_ADMIN_URL ?? 'postgresql://tms:tms_secret@localhost:5432/postgres';
const AMQP_URL = process.env.TEST_AMQP_URL ?? 'amqp://tms:tms_dev@localhost:5672';
const SERVICE = 'academic' as const; // not deployed (BR-SYS-03), so its queues are free for tests
const RETRY_DELAYS = [100, 100, 100];
const quiet = { log: () => undefined, warn: () => undefined, error: () => undefined };
const classId = '00000000-0000-4000-8000-000000000004';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
async function until(check: () => boolean | Promise<boolean>, timeoutMs = 10_000): Promise<void> {
  const start = Date.now();
  while (!(await check())) {
    if (Date.now() - start > timeoutMs) throw new Error('condition not met in time');
    await wait(50);
  }
}

function executorFor(client: Pool | PoolClient): SqlExecutor {
  return {
    $executeRawUnsafe: async (sql, ...values) => (await client.query(sql, values)).rowCount ?? 0,
    $queryRawUnsafe: async <T>(sql: string, ...values: unknown[]) =>
      (await client.query(sql, values)).rows as T,
  };
}

function pgDatabase(pool: Pool): Database {
  return {
    executor: executorFor(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(executorFor(client));
        await client.query('COMMIT');
        return result;
      } catch (err) {
        await client.query('ROLLBACK');
        throw err;
      } finally {
        client.release();
      }
    },
  };
}

describe('outbox + consumer against PostgreSQL and RabbitMQ', () => {
  const dbName = `common_it_${randomUUID().replace(/-/g, '').slice(0, 12)}`;
  let admin: Pool;
  let pool: Pool;
  let db: Database;
  let rabbit: RabbitConnection;
  let inspector: ChannelModel;
  let inspect: Channel;
  const queues = ['ClassClosed', 'ClassUpdated', 'ClassCreated', 'StudentWithdrawn'].flatMap(
    (type) => {
      const q = queueName(SERVICE, type as 'ClassClosed');
      return [q, ...RETRY_DELAYS.map((_, i) => `${q}.retry.${i + 1}`)];
    },
  );

  beforeAll(async () => {
    admin = new Pool({ connectionString: PG_ADMIN });
    await admin.query(`CREATE DATABASE ${dbName}`);
    pool = new Pool({ connectionString: PG_ADMIN.replace(/\/[^/]*$/, `/${dbName}`) });
    await pool.query(readFileSync(join(__dirname, '../sql/messaging.sql'), 'utf8'));
    db = pgDatabase(pool);

    inspector = await connect(AMQP_URL);
    inspect = await inspector.createChannel();
    for (const q of [...queues, deadLetterQueueName(SERVICE)]) await inspect.deleteQueue(q);

    rabbit = new RabbitConnection(AMQP_URL, quiet);
    await rabbit.start();
    await rabbit.waitForConnect();
    await until(() => rabbit.isReady());
  });

  afterAll(async () => {
    await rabbit?.close();
    for (const q of [...queues, deadLetterQueueName(SERVICE)]) await inspect?.deleteQueue(q);
    await inspector?.close();
    await pool?.end();
    await admin?.query(`DROP DATABASE IF EXISTS ${dbName} WITH (FORCE)`);
    await admin?.end();
  });

  const consumer = () =>
    new EventConsumer(SERVICE, db, rabbit, quiet, { retryDelaysMs: RETRY_DELAYS });
  const relay = () => new OutboxRelay(db, rabbit, quiet);
  const count = async (sql: string) => Number((await pool.query(sql)).rows[0].n);

  it('delivers an outbox event exactly once even when the relay publishes it twice', async () => {
    const received: EventEnvelope<'ClassClosed'>[] = [];
    await consumer().subscribe('ClassClosed', async (event) => {
      received.push(event);
    });

    const event = await db.transaction((tx) => enqueueEvent(tx, 'ClassClosed', { classId }));
    expect(await relay().publishBatch()).toBe(1);
    expect(await count('SELECT count(*) AS n FROM outbox_events WHERE published_at IS NULL')).toBe(
      0,
    );

    // Simulate a crash after the broker confirmed but before the row was marked published.
    await pool.query('UPDATE outbox_events SET published_at = NULL WHERE id = $1', [event.eventId]);
    expect(await relay().publishBatch()).toBe(1);

    await until(async () => (await count('SELECT count(*) AS n FROM processed_events')) === 1);
    await wait(500); // give the duplicate time to arrive and be dropped
    expect(received).toHaveLength(1);
    expect(received[0]).toEqual(event);
    const main = await inspect.checkQueue(queueName(SERVICE, 'ClassClosed'));
    expect(main.messageCount).toBe(0); // the duplicate was acked, not left behind
  });

  it('retries a failing handler 3 times (4 attempts), then dead-letters the message', async () => {
    let attempts = 0;
    await consumer().subscribe('ClassUpdated', async () => {
      attempts++;
      throw new Error('handler exploded');
    });

    const event = await db.transaction((tx) =>
      enqueueEvent(tx, 'ClassUpdated', {
        classId,
        tutorId: '00000000-0000-4000-8000-000000000002',
        feeType: 'PER_SESSION',
        feeAmount: 200000,
        chargeAbsent: true,
        effectiveFrom: '2026-12',
      }),
    );
    await relay().publishBatch();

    const dlq = deadLetterQueueName(SERVICE);
    await until(async () => (await inspect.checkQueue(dlq)).messageCount === 1);
    expect(attempts).toBe(1 + RETRY_DELAYS.length);

    const dead = await inspect.get(dlq, { noAck: true });
    expect(dead && JSON.parse(dead.content.toString()).eventId).toBe(event.eventId);
    expect(dead && dead.properties.headers?.['x-error']).toBe('handler exploded');
    expect(dead && dead.properties.headers?.['x-retry-count']).toBe(3);
    // The failed attempts rolled back, so the event is not recorded as processed.
    expect(
      await count(`SELECT count(*) AS n FROM processed_events WHERE event_id = '${event.eventId}'`),
    ).toBe(0);
  });

  it('sends a message that breaks the contract straight to the DLQ without calling the handler', async () => {
    let called = false;
    await consumer().subscribe('StudentWithdrawn', async () => {
      called = true;
    });

    const channel = await rabbit.publishChannel();
    channel.publish(
      EVENTS_EXCHANGE,
      'enrollment.withdrawn',
      Buffer.from(JSON.stringify({ eventType: 'StudentWithdrawn', data: { reason: 'EXPELLED' } })),
    );
    await channel.waitForConfirms();

    const dlq = deadLetterQueueName(SERVICE);
    await until(async () => (await inspect.checkQueue(dlq)).messageCount === 1);
    const dead = await inspect.get(dlq, { noAck: true });
    expect(String(dead && dead.properties.headers?.['x-error'])).toMatch(/contract violation/);
    expect(called).toBe(false);
  });

  it('a handler that fails once is retried and its work committed exactly once', async () => {
    const tutorId = '00000000-0000-4000-8000-000000000002';
    let attempts = 0;
    await pool.query('CREATE TABLE IF NOT EXISTS side_effects (event_id UUID)');
    // Each test subscribes to its own event type, so consumers never compete for a queue.
    await consumer().subscribe('ClassCreated', async (event, tx) => {
      attempts++;
      await tx.$executeRawUnsafe(
        'INSERT INTO side_effects (event_id) VALUES ($1::uuid)',
        event.eventId,
      );
      if (attempts === 1) throw new Error('transient');
    });
    const event = await db.transaction((tx) =>
      enqueueEvent(tx, 'ClassCreated', {
        classId,
        tutorId,
        feeType: 'MONTHLY',
        feeAmount: 1500000,
        chargeAbsent: false,
        effectiveFrom: '2026-12',
      }),
    );
    await relay().publishBatch();

    await until(() => attempts === 2);
    await until(
      async () =>
        (await count(
          `SELECT count(*) AS n FROM processed_events WHERE event_id = '${event.eventId}'`,
        )) === 1,
    );
    // The first attempt's insert rolled back together with its processed_events row.
    expect(await count('SELECT count(*) AS n FROM side_effects')).toBe(1);
  });
});
