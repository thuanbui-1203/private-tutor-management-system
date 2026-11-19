/**
 * Integration tests for #13 against a throwaway database and, for the Saga round trip,
 * RabbitMQ in a throwaway virtual host (so the running containers never see the messages):
 *   docker compose up -d postgres rabbitmq && pnpm --filter @tms/schedule-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { connect } from 'amqplib';
import request from 'supertest';
import { todayInVietnam } from '@tms/common';
import {
  createEvent,
  EVENTS_EXCHANGE,
  routingKeyOf,
  type EventData,
  type EventType,
} from '@tms/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, addMonths } from '../src/schedules/calendar';
import { RosterService } from '../src/schedules/roster.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { as, createTestDb, type TestDb } from './support';

const RABBIT_API = process.env.TEST_RABBIT_API ?? 'http://localhost:15672/api';
const RABBIT_AUTH = 'Basic ' + Buffer.from('tms:tms_dev').toString('base64');

describe('Schedule: Schedules, Session generation and Roster (#13)', () => {
  let env: TestDb;
  let app: INestApplication;
  // A fresh Tutor per test: Sessions from one test must not overlap the next (BR-SC-01).
  let tutor = as('TUTOR');
  beforeEach(() => {
    tutor = as('TUTOR');
  });

  beforeAll(async () => {
    env = await createTestDb('schedule_it');
    const { AppModule } = await import('../src/app.module');
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
  });

  const http = () => request(app.getHttpServer());
  async function deliver<T extends EventType>(
    type: T,
    data: EventData<T>,
    handler: (e: never, tx: never) => Promise<void>,
  ) {
    const event = createEvent(type, data, { correlationId: randomUUID() });
    await app.get(PrismaService).$transaction((tx) => handler(event as never, tx as never));
  }
  const roster = () => app.get(RosterService);
  async function knownClass(owner = tutor) {
    const classId = randomUUID();
    await deliver(
      'ClassCreated',
      {
        classId,
        tutorId: owner['x-user-id'],
        feeType: 'PER_SESSION',
        feeAmount: 200000,
        chargeAbsent: true,
        effectiveFrom: '2026-11',
      },
      (e, tx) => roster().onClass(e, tx),
    );
    return classId;
  }
  /** A Monday-to-Monday window starting next month, so it crosses no "today" edge. */
  const nextMonth = addMonths(todayInVietnam(), 1).slice(0, 8);
  const schedule = (classId: string, extra: object = {}) => ({
    classId,
    weekday: 1,
    startTime: '19:00',
    endTime: '20:30',
    fromDate: `${nextMonth}01`,
    toDate: `${nextMonth}28`,
    ...extra,
  });
  const sessionCount = async (classId: string) =>
    Number(
      (await env.db.query('SELECT count(*) FROM sessions WHERE class_id = $1', [classId])).rows[0]
        .count,
    );

  it('previews the Sessions it would create, writing nothing', async () => {
    const classId = await knownClass();
    const res = await http()
      .post('/schedules/preview')
      .set(tutor)
      .send(schedule(classId))
      .expect(200);
    expect(res.body.sessions.length).toBeGreaterThanOrEqual(3);
    expect(res.body.sessions.every((s: { startTime: string }) => s.startTime === '19:00')).toBe(
      true,
    );
    expect(res.body.conflicts).toEqual([]);
    expect(await sessionCount(classId)).toBe(0);
  });

  it('creates Sessions across a month boundary in Vietnam time, with SessionScheduled + roster', async () => {
    const classId = await knownClass();
    const studentId = randomUUID();
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId: randomUUID(),
        classId,
        studentId,
        studentName: 'An',
        feeType: 'PER_SESSION',
        status: 'ACTIVE',
        joinedAt: todayInVietnam(),
      },
      (e, tx) => roster().onEnrolled(e, tx),
    );
    // From the 20th of next month to the 15th of the month after: crosses the boundary.
    const from = `${nextMonth}20`;
    const to = `${addMonths(`${nextMonth}01`, 1).slice(0, 8)}15`;
    const res = await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(classId, { weekday: 4, fromDate: from, toDate: to }))
      .expect(201);
    const { rows } = await env.db.query(
      `SELECT to_char(date, 'YYYY-MM-DD') AS date, starts_at, ends_at FROM sessions WHERE class_id = $1 ORDER BY date`,
      [classId],
    );
    expect(rows.length).toBe(res.body.sessionsCreated);
    expect(new Set(rows.map((r) => r.date.slice(0, 7))).size).toBe(2); // two months
    for (const r of rows) {
      expect(new Date(r.date).getUTCDay()).toBe(4); // Thursday
      expect(r.starts_at.toISOString()).toBe(`${r.date}T12:00:00.000Z`); // 19:00 in UTC+7
      expect(r.ends_at.toISOString()).toBe(`${r.date}T13:30:00.000Z`);
    }
    const events = await env.db.query(
      `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = 'SessionScheduled'
        AND payload->'data'->>'classId' = $1`,
      [classId],
    );
    expect(events.rows).toHaveLength(rows.length);
    expect(events.rows[0].data.studentIds).toEqual([studentId]);
  });

  it("refuses a Schedule that overlaps the Tutor's other Sessions, listing the conflicts (BR-SC-01)", async () => {
    const a = await knownClass();
    const b = await knownClass();
    await http().post('/schedules').set(tutor).send(schedule(a)).expect(201);
    const overlapping = schedule(b, { startTime: '20:00', endTime: '21:00' });

    const preview = await http()
      .post('/schedules/preview')
      .set(tutor)
      .send(overlapping)
      .expect(200);
    expect(preview.body.conflicts.length).toBeGreaterThan(0);
    expect(preview.body.conflicts[0].conflictsWith.classId).toBe(a);

    const refused = await http().post('/schedules').set(tutor).send(overlapping).expect(409);
    expect(refused.body.conflicts.length).toBe(preview.body.conflicts.length);
    expect(await sessionCount(b)).toBe(0);

    // Back-to-back is fine: 20:30–21:30 touches but does not overlap 19:00–20:30.
    await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(b, { startTime: '20:30', endTime: '21:30' }))
      .expect(201);
  });

  it('skipConflicts creates only the non-conflicting Sessions', async () => {
    const a = await knownClass();
    const b = await knownClass();
    // a: one single Monday; b: every Monday of the month at an overlapping time.
    await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(a, { toDate: `${nextMonth}07` }))
      .expect(201);
    const res = await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(b, { startTime: '19:30', endTime: '20:00', skipConflicts: true }))
      .expect(201);
    expect(res.body.skipped).toHaveLength(1);
    expect(res.body.sessionsCreated).toBe(await sessionCount(b));
  });

  it("another Tutor's class is 404, a closed one 422, an unknown one 409", async () => {
    const classId = await knownClass();
    await http().post('/schedules').set(as('TUTOR')).send(schedule(classId)).expect(404);
    await http().post('/schedules').set(tutor).send(schedule(randomUUID())).expect(409);
    await deliver('ClassClosed', { classId }, (e, tx) => roster().onClassClosed(e, tx));
    await http().post('/schedules').set(tutor).send(schedule(classId)).expect(422);
    await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(classId, { endTime: '18:00' }))
      .expect(400);
  });

  it('ending a Schedule cancels its future Sessions (SessionCancelled each)', async () => {
    const classId = await knownClass();
    const { body } = await http().post('/schedules').set(tutor).send(schedule(classId)).expect(201);
    const res = await http().delete(`/schedules/${body.schedule.id}`).set(tutor).expect(200);
    expect(res.body.sessionsCancelled).toBe(body.sessionsCreated);
    const cancelled = await env.db.query(
      `SELECT count(*)::int AS n FROM sessions WHERE class_id = $1 AND status = 'CANCELLED'`,
      [classId],
    );
    expect(cancelled.rows[0].n).toBe(body.sessionsCreated);
    const events = await env.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'SessionCancelled'
      AND payload->'data'->>'sessionId' IN (SELECT id::text FROM sessions WHERE class_id = $1)`,
      [classId],
    );
    expect(events.rows[0].n).toBe(body.sessionsCreated);
    await http().delete(`/schedules/${body.schedule.id}`).set(tutor).expect(409);
  });

  it('roster: StudentEnrolled → EnrollmentConfirmed; closed class → EnrollmentSyncFailed; withdrawn leaves', async () => {
    const classId = await knownClass();
    const enrollmentId = randomUUID();
    const studentId = randomUUID();
    const enrolled = {
      enrollmentId,
      classId,
      studentId,
      studentName: 'An',
      feeType: 'MONTHLY',
      status: 'AWAITING_PAYMENT',
      joinedAt: todayInVietnam(),
    } as const;
    await deliver('StudentEnrolled', enrolled, (e, tx) => roster().onEnrolled(e, tx));
    const confirmed = await env.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'EnrollmentConfirmed' AND payload->'data'->>'enrollmentId' = $1`,
      [enrollmentId],
    );
    expect(confirmed.rows[0].n).toBe(1);
    expect(await app.get(SchedulesService).roster(app.get(PrismaService), classId)).toEqual([
      studentId,
    ]);

    await deliver(
      'StudentWithdrawn',
      { enrollmentId, classId, studentId, reason: 'UNPAID' },
      (e, tx) => roster().onWithdrawn(e, tx),
    );
    expect(await app.get(SchedulesService).roster(app.get(PrismaService), classId)).toEqual([]);

    await deliver('ClassClosed', { classId }, (e, tx) => roster().onClassClosed(e, tx));
    const late = { ...enrolled, enrollmentId: randomUUID(), studentId: randomUUID() };
    await deliver('StudentEnrolled', late, (e, tx) => roster().onEnrolled(e, tx));
    const failed = await env.db.query(
      `SELECT count(*)::int AS n FROM outbox_events WHERE event_type = 'EnrollmentSyncFailed' AND payload->'data'->>'enrollmentId' = $1`,
      [late.enrollmentId],
    );
    expect(failed.rows[0].n).toBe(1);
  });

  it('the weekly job extends open Schedules to the 3-month horizon', async () => {
    const classId = await knownClass();
    const { body } = await http()
      .post('/schedules')
      .set(tutor)
      .send(schedule(classId, { weekday: 2, fromDate: todayInVietnam(), toDate: undefined }))
      .expect(201);
    const before = await sessionCount(classId);
    const added = await app.get(SchedulesService).extend(new Date(Date.now() + 35 * 86_400_000));
    expect(added).toBeGreaterThanOrEqual(4);
    expect(await sessionCount(classId)).toBe(before + added);
    expect(await app.get(SchedulesService).extend(new Date(Date.now() + 35 * 86_400_000))).toBe(0); // idempotent
    const s = await env.db.query(
      `SELECT to_char(generated_until, 'YYYY-MM-DD') AS d FROM schedules WHERE id = $1`,
      [body.schedule.id],
    );
    expect(s.rows[0].d > addDays(todayInVietnam(), 90)).toBe(true);
  });
});

describe('Schedule: StudentEnrolled → EnrollmentConfirmed through RabbitMQ (#13)', () => {
  const vhost = `tms-test-${randomUUID().slice(0, 8)}`;
  const api = (path: string, method: string, body?: object) =>
    fetch(`${RABBIT_API}${path}`, {
      method,
      headers: { authorization: RABBIT_AUTH, 'content-type': 'application/json' },
      body: body && JSON.stringify(body),
    });
  let env: TestDb;
  let app: INestApplication;

  beforeAll(async () => {
    expect((await api(`/vhosts/${vhost}`, 'PUT')).ok).toBe(true);
    expect(
      (await api(`/permissions/${vhost}/tms`, 'PUT', { configure: '.*', write: '.*', read: '.*' }))
        .ok,
    ).toBe(true);
    env = await createTestDb('schedule_mq_it');
    process.env.RABBITMQ_URL = `amqp://tms:tms_dev@localhost:5672/${vhost}`;
    const { AppModule } = await import('../src/app.module');
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    delete process.env.RABBITMQ_URL;
    await env?.close();
    await api(`/vhosts/${vhost}`, 'DELETE');
  });

  it('round-trips through the real broker: outbox relay publishes EnrollmentConfirmed', async () => {
    const conn = await connect(`amqp://tms:tms_dev@localhost:5672/${vhost}`);
    const ch = await conn.createChannel();
    try {
      await ch.assertExchange(EVENTS_EXCHANGE, 'topic', { durable: true });
      const { queue } = await ch.assertQueue('', { exclusive: true });
      await ch.bindQueue(queue, EVENTS_EXCHANGE, routingKeyOf('EnrollmentConfirmed'));
      const confirmed = new Promise<Record<string, string>>((resolve) =>
        ch.consume(queue, (msg) => msg && resolve(JSON.parse(msg.content.toString()).data), {
          noAck: true,
        }),
      );

      // Wait until the schedule service has declared and bound its queue.
      for (let i = 0; i < 50; i++) {
        const q = await api(`/queues/${vhost}/schedule.student-enrolled`, 'GET');
        if (q.ok) break;
        await new Promise((r) => setTimeout(r, 100));
      }
      const data = {
        enrollmentId: randomUUID(),
        classId: randomUUID(),
        studentId: randomUUID(),
        studentName: 'Trần Minh An',
        feeType: 'PER_SESSION' as const,
        status: 'ACTIVE' as const,
        joinedAt: todayInVietnam(),
      };
      const event = createEvent('StudentEnrolled', data, { correlationId: randomUUID() });
      ch.publish(
        EVENTS_EXCHANGE,
        routingKeyOf('StudentEnrolled'),
        Buffer.from(JSON.stringify(event)),
        { persistent: true },
      );

      const reply = await Promise.race([
        confirmed,
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('no EnrollmentConfirmed within 10 s')), 10_000),
        ),
      ]);
      expect(reply).toEqual({
        enrollmentId: data.enrollmentId,
        classId: data.classId,
        studentId: data.studentId,
      });
    } finally {
      await conn.close();
    }
  });
});
