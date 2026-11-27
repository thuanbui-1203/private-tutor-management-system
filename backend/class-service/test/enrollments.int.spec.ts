/**
 * Integration tests for #12 (enrollment Saga, Class side) against a throwaway database
 * and a fake student-service. Follows docs/diagrams/07-sequence-enrollment-saga.puml.
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { EnrollmentsService } from '../src/enrollments/enrollments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { as, createTestDb, type TestDb } from './support';

const DAY = 86_400_000;

describe('Class: enrollment Saga, Class side (#12)', () => {
  let env: TestDb;
  let app: INestApplication;
  let fakeStudents: Server;
  let studentServiceUp = true;
  /** studentId → what student-service knows. */
  const known = new Map<string, { tutorId: string; status: string; fullName: string }>();
  /** `${studentId}:${userId}` → relation. */
  const relations = new Map<string, string>();
  const tutor = as('TUTOR');

  beforeAll(async () => {
    env = await createTestDb('class_enr_it');
    fakeStudents = createServer((req, res) => {
      if (!studentServiceUp) return void res.writeHead(503).end();
      const url = new URL(req.url!, 'http://x');
      const [, , , id, sub] = url.pathname.split('/'); // /internal/students/{id}[/access]
      const json = (status: number, body?: unknown) => {
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(body === undefined ? '{}' : JSON.stringify(body));
      };
      const s = known.get(id);
      if (!s) return json(404);
      if (sub === 'access') {
        const userId = url.searchParams.get('userId')!;
        return json(200, {
          studentId: id,
          userId,
          relation: relations.get(`${id}:${userId}`) ?? null,
        });
      }
      json(200, { id, ...s, payerContact: { name: 'Lan', phone: '0901234567' } });
    });
    await new Promise<void>((r) => fakeStudents.listen(0, '127.0.0.1', r));
    process.env.STUDENT_SERVICE_URL = `http://127.0.0.1:${(fakeStudents.address() as AddressInfo).port}`;

    const { AppModule } = await import('../src/app.module');
    const moduleRef = await Test.createTestingModule({ imports: [AppModule] }).compile();
    app = moduleRef.createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await new Promise((r) => fakeStudents?.close(r));
    await env?.close();
  });

  const http = () => request(app.getHttpServer());
  const service = () => app.get(EnrollmentsService);
  const studentOf = (owner = tutor, status = 'ACTIVE') => {
    const id = randomUUID();
    known.set(id, { tutorId: owner['x-user-id'], status, fullName: `Học sinh ${id.slice(0, 4)}` });
    return id;
  };
  const newClass = async (body: object = {}, owner = tutor) =>
    (
      await http()
        .post('/classes')
        .set(owner)
        .send({
          name: 'Toán 9',
          subject: 'Toán',
          type: 'GROUP',
          maxStudents: 6,
          feeType: 'PER_SESSION',
          feeAmount: 200000,
          ...body,
        })
        .expect(201)
    ).body.id as string;
  const enroll = (classId: string, studentId: string, who = tutor) =>
    http().post(`/classes/${classId}/enrollments`).set(who).send({ studentId });
  const row = async (id: string) =>
    (await env.db.query('SELECT * FROM enrollments WHERE id = $1', [id])).rows[0];
  const eventsOf = async (enrollmentId: string, type: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = $2
          AND payload->'data'->>'enrollmentId' = $1 ORDER BY created_at`,
        [enrollmentId, type],
      )
    ).rows.map((r) => r.data);
  /** Runs an event handler the way the consumer does: inside one transaction. */
  async function deliver<T extends EventType>(
    type: T,
    data: EventData<T>,
    handler: (e: never, tx: never) => Promise<void>,
  ) {
    const event = createEvent(type, data, { correlationId: randomUUID() });
    await app.get(PrismaService).$transaction((tx) => handler(event as never, tx as never));
  }

  it("PER_SESSION: 201 ACTIVE and StudentEnrolled with the Student's name", async () => {
    const classId = await newClass();
    const studentId = studentOf();
    const res = await enroll(classId, studentId).expect(201);
    expect(res.body).toMatchObject({ status: 'ACTIVE', paymentDeadline: null });
    const [event] = await eventsOf(res.body.id, 'StudentEnrolled');
    expect(event).toMatchObject({
      classId,
      studentId,
      feeType: 'PER_SESSION',
      status: 'ACTIVE',
      studentName: known.get(studentId)!.fullName,
    });
  });

  it('MONTHLY: 201 AWAITING_PAYMENT with a 7-day deadline (BR-CL-07)', async () => {
    const classId = await newClass({ feeType: 'MONTHLY', feeAmount: 1500000 });
    const res = await enroll(classId, studentOf()).expect(201);
    expect(res.body.status).toBe('AWAITING_PAYMENT');
    const days = (Date.parse(res.body.paymentDeadline) - Date.now()) / DAY;
    expect(days).toBeGreaterThan(6.99);
    expect(days).toBeLessThanOrEqual(7);
    expect((await eventsOf(res.body.id, 'StudentEnrolled'))[0]).toMatchObject({
      status: 'AWAITING_PAYMENT',
      feeType: 'MONTHLY',
    });
  });

  it('rejects an invalid Student with 422', async () => {
    const classId = await newClass();
    await enroll(classId, randomUUID()).expect(422); // unknown
    await enroll(classId, studentOf(as('TUTOR'))).expect(422); // another Tutor's
    await enroll(classId, studentOf(tutor, 'PAUSED')).expect(422);
  });

  it("refuses a duplicate, a closed class, a full class, and someone else's class", async () => {
    const classId = await newClass({ type: 'ONE_ON_ONE', maxStudents: undefined });
    const first = studentOf();
    await enroll(classId, first).expect(201);
    await enroll(classId, first).expect(409); // BR-CL-03
    await enroll(classId, studentOf()).expect(409); // ONE_ON_ONE has one seat (BR-CL-01)
    await enroll(classId, studentOf(), as('TUTOR')).expect(404);

    const closed = await newClass();
    await http().post(`/classes/${closed}/close`).set(tutor).expect(200);
    await enroll(closed, studentOf()).expect(409);
  });

  it('concurrent enrollments for the last seat: exactly one succeeds', async () => {
    const classId = await newClass({ maxStudents: 2 });
    await enroll(classId, studentOf()).expect(201);
    // Smoke test: requests are staggered by the student-service call, so this rarely hits
    // the race; the row lock itself is proven by the next test.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => enroll(classId, studentOf())),
    );
    expect(results.filter((r) => r.status === 201)).toHaveLength(1);
    expect(results.filter((r) => r.status === 409)).toHaveLength(7);
    const taken = await env.db.query(
      `SELECT count(*)::int AS n FROM enrollments WHERE class_id = $1 AND status IN ('ACTIVE','AWAITING_PAYMENT','PENDING')`,
      [classId],
    );
    expect(taken.rows[0].n).toBe(2);
  });

  it('waits for a concurrent seat-taker and then sees the class full (row lock)', async () => {
    const classId = await newClass({ maxStudents: 2 });
    await enroll(classId, studentOf()).expect(201);
    // Another transaction locks the class row and takes the last seat, uncommitted.
    const other = await env.db.connect();
    try {
      await other.query('BEGIN');
      await other.query('SELECT id FROM classes WHERE id = $1 FOR UPDATE', [classId]);
      await other.query(
        `INSERT INTO enrollments (id, class_id, student_id, student_name, status, updated_at)
         VALUES ($1, $2, $3, 'Học sinh', 'ACTIVE', now())`,
        [randomUUID(), classId, randomUUID()],
      );
      let settled = false;
      const pending = enroll(classId, studentOf()).then((res) => {
        settled = true;
        return res;
      });
      await new Promise((r) => setTimeout(r, 400));
      expect(settled).toBe(false); // blocked on the lock, not counting stale seats
      await other.query('COMMIT');
      expect((await pending).status).toBe(409);
    } finally {
      other.release();
    }
  });

  it('student-service down: 202 PENDING holding a seat, later reconciled', async () => {
    const classId = await newClass({ feeType: 'MONTHLY', feeAmount: 1500000 });
    const studentId = studentOf();
    studentServiceUp = false;
    const res = await enroll(classId, studentId).expect(202);
    studentServiceUp = true;
    expect(res.body.status).toBe('PENDING');
    expect(await eventsOf(res.body.id, 'StudentEnrolled')).toHaveLength(0);

    await service().reconcilePending();
    expect((await row(res.body.id)).status).toBe('AWAITING_PAYMENT');
    expect(await eventsOf(res.body.id, 'StudentEnrolled')).toHaveLength(1);
  });

  it('a PENDING enrollment that cannot be confirmed for a day is rejected', async () => {
    const classId = await newClass();
    studentServiceUp = false;
    const res = await enroll(classId, studentOf()).expect(202);
    await service().reconcilePending(new Date(Date.now() + 2 * DAY));
    studentServiceUp = true;
    expect((await row(res.body.id)).status).toBe('REJECTED');
  });

  it('EnrollmentConfirmed records the roster confirmation, idempotently', async () => {
    const classId = await newClass();
    const studentId = studentOf();
    const { body } = await enroll(classId, studentId).expect(201);
    const data = { enrollmentId: body.id, classId, studentId };
    await deliver('EnrollmentConfirmed', data, (e, tx) => service().onConfirmed(e, tx));
    const confirmed = (await row(body.id)).roster_confirmed_at;
    expect(confirmed).not.toBeNull();
    await deliver('EnrollmentConfirmed', data, (e, tx) => service().onConfirmed(e, tx));
    expect((await row(body.id)).roster_confirmed_at).toEqual(confirmed);
  });

  it('EnrollmentSyncFailed compensates: REJECTED, seat released, StudentWithdrawn SYNC_FAILED', async () => {
    const classId = await newClass({ type: 'ONE_ON_ONE', maxStudents: undefined });
    const studentId = studentOf();
    const { body } = await enroll(classId, studentId).expect(201);
    await deliver(
      'EnrollmentSyncFailed',
      { enrollmentId: body.id, classId, studentId, error: 'roster' },
      (e, tx) => service().onSyncFailed(e, tx),
    );
    expect(await row(body.id)).toMatchObject({
      status: 'REJECTED',
      withdraw_reason: 'SYNC_FAILED',
    });
    expect((await eventsOf(body.id, 'StudentWithdrawn'))[0].reason).toBe('SYNC_FAILED');
    await enroll(classId, studentOf()).expect(201); // the seat is free again
  });

  it('PaymentReceived for a paid Enrollment invoice activates; anything else does not', async () => {
    const classId = await newClass({ feeType: 'MONTHLY', feeAmount: 1500000 });
    const { body } = await enroll(classId, studentOf()).expect(201);
    const pay = (extra: object) =>
      deliver(
        'PaymentReceived',
        {
          invoiceId: randomUUID(),
          amount: 100000,
          method: 'CASH',
          invoiceKind: 'ENROLLMENT',
          enrollmentId: body.id,
          invoiceStatus: 'PARTIALLY_PAID',
          ...extra,
        } as EventData<'PaymentReceived'>,
        (e, tx) => service().onPayment(e, tx),
      );
    await pay({});
    expect((await row(body.id)).status).toBe('AWAITING_PAYMENT');
    await pay({ invoiceKind: 'MONTHLY', enrollmentId: undefined, invoiceStatus: 'PAID' });
    expect((await row(body.id)).status).toBe('AWAITING_PAYMENT');
    await pay({ invoiceStatus: 'PAID' });
    expect(await row(body.id)).toMatchObject({ status: 'ACTIVE', payment_deadline: null });
  });

  it('StudentStatusChanged pauses, resumes and withdraws (BR-ST-03)', async () => {
    const studentId = studentOf();
    const a = (await enroll(await newClass(), studentId).expect(201)).body.id;
    const b = (await enroll(await newClass(), studentId).expect(201)).body.id;
    const status = (from: string, to: string) =>
      deliver(
        'StudentStatusChanged',
        { studentId, from, to } as EventData<'StudentStatusChanged'>,
        (e, tx) => service().onStudentStatus(e, tx),
      );
    await status('ACTIVE', 'PAUSED');
    expect([(await row(a)).status, (await row(b)).status]).toEqual(['PAUSED', 'PAUSED']);
    await status('PAUSED', 'ACTIVE');
    expect([(await row(a)).status, (await row(b)).status]).toEqual(['ACTIVE', 'ACTIVE']);
    await status('ACTIVE', 'DROPPED');
    expect(await row(a)).toMatchObject({ status: 'WITHDRAWN', withdraw_reason: 'STUDENT_STATUS' });
    expect(await eventsOf(b, 'StudentWithdrawn')).toHaveLength(1);
  });

  it('withdraws enrollments unpaid after 7 days (UNPAID), not before', async () => {
    const classId = await newClass({ feeType: 'MONTHLY', feeAmount: 1500000 });
    const { body } = await enroll(classId, studentOf()).expect(201);
    await service().expireUnpaid(new Date(Date.now() + 6 * DAY));
    expect((await row(body.id)).status).toBe('AWAITING_PAYMENT');
    await service().expireUnpaid(new Date(Date.now() + 8 * DAY));
    expect(await row(body.id)).toMatchObject({ status: 'WITHDRAWN', withdraw_reason: 'UNPAID' });
    expect((await eventsOf(body.id, 'StudentWithdrawn'))[0].reason).toBe('UNPAID');
  });

  it('pauses, resumes and withdraws on request; re-enrolling a withdrawn Student is allowed', async () => {
    const classId = await newClass();
    const studentId = studentOf();
    const { body } = await enroll(classId, studentId).expect(201);
    const change = (to: string) =>
      http().patch(`/classes/${classId}/enrollments/${body.id}`).set(tutor).send({ status: to });
    await change('ACTIVE').expect(409);
    await change('PAUSED').expect(200);
    await change('ACTIVE').expect(200);
    await change('WITHDRAWN').expect(200);
    expect((await row(body.id)).withdraw_reason).toBe('REQUESTED');
    await change('PAUSED').expect(409);
    const again = await enroll(classId, studentId).expect(201);
    expect(again.body.id).toBe(body.id);
  });

  it('GET /students/{id}/classes: the Tutor, linked Parents and the Student; others 404', async () => {
    const studentId = studentOf();
    const classId = await newClass();
    await enroll(classId, studentId).expect(201);
    const parent = as('PARENT');
    relations.set(`${studentId}:${parent['x-user-id']}`, 'secondary-parent');

    const mine = await http().get(`/students/${studentId}/classes`).set(tutor).expect(200);
    expect(mine.body.map((c: { class: { id: string } }) => c.class.id)).toEqual([classId]);
    await http().get(`/students/${studentId}/classes`).set(parent).expect(200);
    await http().get(`/students/${studentId}/classes`).set(as('PARENT')).expect(404);
    await http().get(`/students/${studentId}/classes`).set(as('TUTOR')).expect(404);
  });

  it('only a VERIFIED Tutor takes Students (BR-TU-01); the newest status wins', async () => {
    const owner = as('TUTOR');
    const classId = await newClass({}, owner);
    const status = (to: 'VERIFIED' | 'SUSPENDED', at: string) => {
      const event = createEvent(
        'TutorStatusChanged',
        { tutorId: owner['x-user-id'], from: to === 'VERIFIED' ? 'SUBMITTED' : 'VERIFIED', to },
        { correlationId: randomUUID(), occurredAt: new Date(at) },
      );
      const service = app.get(EnrollmentsService);
      return app
        .get(PrismaService)
        .$transaction((tx) => service.onTutorStatus(event as never, tx as never));
    };
    process.env.REQUIRE_VERIFIED_TUTOR = 'true';
    try {
      const refused = await enroll(classId, studentOf(owner), owner).expect(422);
      expect(refused.body.code).toBe('TUTOR_NOT_VERIFIED');
      await status('VERIFIED', '2026-11-27T10:00:00Z');
      await status('SUSPENDED', '2026-11-27T09:00:00Z'); // older, arriving late: ignored
      await enroll(classId, studentOf(owner), owner).expect(201);
      await status('SUSPENDED', '2026-11-27T11:00:00Z');
      await enroll(classId, studentOf(owner), owner).expect(422);
    } finally {
      process.env.REQUIRE_VERIFIED_TUTOR = 'false';
    }
  });
});
