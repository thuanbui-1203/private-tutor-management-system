/**
 * Integration tests for #14 (Session lifecycle) against a throwaway database and a fake
 * student-service. State diagram: docs/diagrams/09-state-lifecycle.puml (Session).
 *   docker compose up -d postgres && pnpm --filter @tms/schedule-service test:int
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { todayInVietnam, type AuthUser } from '@tms/common';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays, toInstant } from '../src/schedules/calendar';
import { RosterService } from '../src/schedules/roster.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { as, createTestDb, type TestDb } from './support';

const HOUR = 3_600_000;

describe('Schedule: Session lifecycle, cancellations and Makeup sessions (#14)', () => {
  let env: TestDb;
  let app: INestApplication;
  let fakeStudents: Server;
  /** `${studentId}:${userId}` → relation. */
  const relations = new Map<string, string>();
  let tutor = as('TUTOR');
  beforeEach(() => {
    tutor = as('TUTOR');
  });

  beforeAll(async () => {
    env = await createTestDb('schedule_sess_it');
    fakeStudents = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const [, , , id] = url.pathname.split('/'); // /internal/students/{id}/access
      const userId = url.searchParams.get('userId')!;
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(
        JSON.stringify({
          studentId: id,
          userId,
          relation: relations.get(`${id}:${userId}`) ?? null,
        }),
      );
    });
    await new Promise<void>((r) => fakeStudents.listen(0, '127.0.0.1', r));
    process.env.STUDENT_SERVICE_URL = `http://127.0.0.1:${(fakeStudents.address() as AddressInfo).port}`;
    const { AppModule } = await import('../src/app.module');
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
    await new Promise((r) => fakeStudents?.close(r));
  });

  const http = () => request(app.getHttpServer());
  const sessions = () => app.get(SessionsService);
  async function deliver<T extends EventType>(
    type: T,
    data: EventData<T>,
    handler: (e: never, tx: never) => Promise<void>,
  ) {
    const event = createEvent(type, data, { correlationId: randomUUID() });
    await app.get(PrismaService).$transaction((tx) => handler(event as never, tx as never));
  }
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
      (e, tx) => app.get(RosterService).onClass(e, tx),
    );
    return classId;
  }
  async function enroll(classId: string, studentId = randomUUID(), joinedAt = todayInVietnam()) {
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId: randomUUID(),
        classId,
        studentId,
        studentName: 'An',
        feeType: 'PER_SESSION',
        status: 'ACTIVE',
        joinedAt,
      },
      (e, tx) => app.get(RosterService).onEnrolled(e, tx),
    );
    return studentId;
  }
  /** A Session at any instant (past ones included), bypassing the API's future-only rule. */
  async function sessionAt(classId: string, startsAt: Date, minutes = 90, owner = tutor) {
    const vn = new Date(startsAt.getTime() + 7 * HOUR).toISOString();
    const end = new Date(startsAt.getTime() + minutes * 60_000 + 7 * HOUR).toISOString();
    const s = await app.get(PrismaService).$transaction((tx) =>
      app.get(SchedulesService).createSession(
        tx,
        { classId, tutorId: owner['x-user-id'] },
        {
          date: vn.slice(0, 10),
          startTime: vn.slice(11, 16),
          endTime: end.slice(11, 16),
          startsAt,
          endsAt: new Date(startsAt.getTime() + minutes * 60_000),
        },
      ),
    );
    return s.id;
  }
  const status = async (id: string) =>
    (await env.db.query('SELECT status FROM sessions WHERE id = $1', [id])).rows[0]?.status;
  const events = async (type: string, key: string, value: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = $1 AND payload->'data'->>$2 = $3`,
        [type, key, value],
      )
    ).rows.map((r) => r.data);
  const inDays = (n: number) => addDays(todayInVietnam(), n);
  const me = () => ({ id: tutor['x-user-id'], role: 'TUTOR' }) as AuthUser;

  it('creates a one-off Session with SessionScheduled + roster; refuses the past and overlaps', async () => {
    const classId = await knownClass();
    const studentId = await enroll(classId);
    const body = { classId, date: inDays(10), startTime: '18:00', endTime: '19:30' };
    const res = await http().post('/sessions').set(tutor).send(body).expect(201);
    expect(res.body).toMatchObject({ status: 'SCHEDULED', date: inDays(10), makeupOf: null });
    expect(res.body.startsAt).toBe(toInstant(inDays(10), '18:00').toISOString());
    const [scheduled] = await events('SessionScheduled', 'sessionId', res.body.id);
    expect(scheduled.studentIds).toEqual([studentId]);

    // BR-SC-01, also across the Tutor's other Classes; back-to-back is fine.
    const other = await knownClass();
    const clash = await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...body, classId: other, startTime: '19:00', endTime: '20:00' })
      .expect(409);
    expect(clash.body.conflicts[0].conflictsWith.sessionId).toBe(res.body.id);
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...body, classId: other, startTime: '19:30', endTime: '20:30' })
      .expect(201);

    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...body, date: inDays(-1) })
      .expect(422);
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...body, startTime: '20:00', endTime: '19:00' })
      .expect(400);
    await http().post('/sessions').set(as('TUTOR')).send(body).expect(404); // not their class
    await http().post('/sessions').set(as('PARENT')).send(body).expect(403);
  });

  it('starts only from 15 minutes before the start until the end', async () => {
    const classId = await knownClass();
    const startsAt = new Date(Date.now() + 10 * 60_000);
    const id = await sessionAt(classId, startsAt);
    const svc = sessions();
    const at = (ms: number) => new Date(startsAt.getTime() + ms);
    await expect(svc.start(me(), id, at(-16 * 60_000))).rejects.toMatchObject({
      status: 422,
    });
    await expect(svc.start(me(), id, at(90 * 60_000))).rejects.toMatchObject({
      status: 422,
    });
    await http().post(`/sessions/${id}/start`).set(as('TUTOR')).expect(404); // someone else's
    const res = await http().post(`/sessions/${id}/start`).set(tutor).expect(200); // now = 10 min early
    expect(res.body.status).toBe('IN_PROGRESS');
    await http().post(`/sessions/${id}/start`).set(tutor).expect(409);
  });

  it('cancels with a reason: SessionCancelled, from SCHEDULED and IN_PROGRESS, not twice', async () => {
    const classId = await knownClass();
    const a = await sessionAt(classId, new Date(Date.now() + 5 * 24 * HOUR));
    await http().post(`/sessions/${a}/cancel`).set(tutor).send({ reason: ' ' }).expect(400);
    const res = await http()
      .post(`/sessions/${a}/cancel`)
      .set(tutor)
      .send({ reason: 'Giáo viên ốm' })
      .expect(200);
    expect(res.body).toMatchObject({ status: 'CANCELLED', cancelReason: 'Giáo viên ốm' });
    expect(await events('SessionCancelled', 'sessionId', a)).toEqual([
      { sessionId: a, reason: 'Giáo viên ốm', cancelledBy: tutor['x-user-id'] },
    ]);
    await http().post(`/sessions/${a}/cancel`).set(tutor).send({ reason: 'x' }).expect(409);
    expect(await events('SessionCancelled', 'sessionId', a)).toHaveLength(1);

    const b = await sessionAt(classId, new Date(Date.now() - 5 * 60_000)); // under way
    await http().post(`/sessions/${b}/start`).set(tutor).expect(200);
    await http().post(`/sessions/${b}/cancel`).set(tutor).send({ reason: 'Mất điện' }).expect(200);
    expect(await status(b)).toBe('CANCELLED');
  });

  it('reschedules: old RESCHEDULED, new Session, exactly one SessionRescheduled and no SessionCancelled', async () => {
    const classId = await knownClass();
    const studentId = await enroll(classId);
    const old = await sessionAt(classId, toInstant(inDays(7), '19:00'));
    const res = await http()
      .post(`/sessions/${old}/reschedule`)
      .set(tutor)
      .send({ date: inDays(8), startTime: '19:15', endTime: '20:45' })
      .expect(200);
    expect(res.body.old).toMatchObject({ id: old, status: 'RESCHEDULED' });
    const moved = res.body.session;
    expect(moved).toMatchObject({ status: 'SCHEDULED', makeupOf: old, date: inDays(8) });
    expect(await status(old)).toBe('RESCHEDULED');

    expect(await events('SessionRescheduled', 'oldSessionId', old)).toEqual([
      {
        oldSessionId: old,
        newSessionId: moved.id,
        classId,
        newStartAt: toInstant(inDays(8), '19:15').toISOString(),
        studentIds: [studentId],
      },
    ]);
    expect(await events('SessionCancelled', 'sessionId', old)).toEqual([]);
    expect(await events('SessionScheduled', 'sessionId', moved.id)).toEqual([]);

    // Only a SCHEDULED Session moves; once moved it cannot move again.
    await http()
      .post(`/sessions/${old}/reschedule`)
      .set(tutor)
      .send({ date: inDays(9), startTime: '19:00', endTime: '20:00' })
      .expect(409);
  });

  it('reschedule passes the overlap check but may overlap the Session it replaces', async () => {
    const classId = await knownClass();
    const a = await sessionAt(classId, toInstant(inDays(7), '19:00'));
    const b = await sessionAt(classId, toInstant(inDays(7), '21:00'), 60);
    // Shift a by 30 minutes: overlaps only itself, which does not count.
    await http()
      .post(`/sessions/${a}/reschedule`)
      .set(tutor)
      .send({ date: inDays(7), startTime: '19:30', endTime: '21:00' })
      .expect(200);
    // Moving b onto the moved a is refused, and b is left untouched.
    const clash = await http()
      .post(`/sessions/${b}/reschedule`)
      .set(tutor)
      .send({ date: inDays(7), startTime: '20:00', endTime: '21:00' })
      .expect(409);
    expect(clash.body.conflicts).toHaveLength(1);
    expect(await status(b)).toBe('SCHEDULED');
    expect(await events('SessionRescheduled', 'oldSessionId', b)).toEqual([]);
    await http()
      .post(`/sessions/${b}/reschedule`)
      .set(tutor)
      .send({ date: inDays(7), startTime: '21:00', endTime: '22:00' })
      .expect(400); // same time
  });

  it('a Makeup session replaces a cancelled Session of the same Class, once', async () => {
    const classId = await knownClass();
    const original = await sessionAt(classId, toInstant(inDays(3), '19:00'));
    const makeup = {
      classId,
      date: inDays(4),
      startTime: '19:00',
      endTime: '20:30',
      makeupOf: original,
    };
    await http().post('/sessions').set(tutor).send(makeup).expect(422); // still SCHEDULED
    await http()
      .post(`/sessions/${original}/cancel`)
      .set(tutor)
      .send({ reason: 'Bận' })
      .expect(200);

    const otherClass = await knownClass();
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...makeup, classId: otherClass })
      .expect(422);
    const res = await http().post('/sessions').set(tutor).send(makeup).expect(201);
    expect(res.body.makeupOf).toBe(original);
    expect(await events('SessionScheduled', 'sessionId', res.body.id)).toHaveLength(1);
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...makeup, date: inDays(5) })
      .expect(409); // already made up

    // Cancelling the makeup frees the original for another one.
    await http()
      .post(`/sessions/${res.body.id}/cancel`)
      .set(tutor)
      .send({ reason: 'Bận' })
      .expect(200);
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ ...makeup, date: inDays(5) })
      .expect(201);
  });

  it('marks Sessions MISSED 24h after their end without Attendance (BR-SC-06), and only those', async () => {
    const classId = await knownClass();
    const now = new Date();
    const stale = await sessionAt(classId, new Date(now.getTime() - 27 * HOUR)); // ended 25.5h ago
    const stuck = await sessionAt(classId, new Date(now.getTime() - 30 * HOUR));
    await env.db.query(`UPDATE sessions SET status = 'IN_PROGRESS' WHERE id = $1`, [stuck]);
    const recent = await sessionAt(classId, new Date(now.getTime() - 20 * HOUR)); // ended 18.5h ago
    const cancelled = await sessionAt(classId, new Date(now.getTime() - 50 * HOUR));
    await env.db.query(`UPDATE sessions SET status = 'CANCELLED' WHERE id = $1`, [cancelled]);

    expect(await sessions().markMissed(now)).toBeGreaterThanOrEqual(2);
    expect(await status(stale)).toBe('MISSED');
    expect(await status(stuck)).toBe('MISSED');
    expect(await status(recent)).toBe('SCHEDULED');
    expect(await status(cancelled)).toBe('CANCELLED');
    expect(await sessions().markMissed(now)).toBe(0); // idempotent

    // MISSED: cannot start or move; can be cancelled ("không dạy") within 48h of the end …
    await http().post(`/sessions/${stale}/start`).set(tutor).expect(409);
    await http()
      .post(`/sessions/${stale}/reschedule`)
      .set(tutor)
      .send({ date: inDays(2), startTime: '19:00', endTime: '20:00' })
      .expect(409);
    await http()
      .post(`/sessions/${stale}/cancel`)
      .set(tutor)
      .send({ reason: 'Không dạy' })
      .expect(200);
    // … and is locked after that (BR-SC-09).
    const old = await sessionAt(classId, new Date(now.getTime() - 60 * HOUR));
    await sessions().markMissed(now);
    await http()
      .post(`/sessions/${old}/cancel`)
      .set(tutor)
      .send({ reason: 'Không dạy' })
      .expect(422);
    // A MISSED Session can be made up.
    await http()
      .post('/sessions')
      .set(tutor)
      .send({ classId, date: inDays(2), startTime: '07:00', endTime: '08:00', makeupOf: old })
      .expect(201);
  });

  it('lists Sessions by role: Tutor own, Parent / Student only while the Student was enrolled', async () => {
    const classId = await knownClass();
    const mine = await sessionAt(classId, toInstant(inDays(2), '19:00'));
    const later = await sessionAt(classId, toInstant(inDays(20), '19:00'));
    const otherTutor = as('TUTOR');
    const theirs = await sessionAt(
      await knownClass(otherTutor),
      toInstant(inDays(2), '19:00'),
      90,
      otherTutor,
    );

    const own = await http()
      .get('/sessions')
      .query({ to: inDays(25) })
      .set(tutor)
      .expect(200);
    expect(own.body.map((s: { id: string }) => s.id)).toEqual([mine, later]);
    const filtered = await http()
      .get('/sessions')
      .query({ from: inDays(1), to: inDays(3), classId })
      .set(tutor)
      .expect(200);
    expect(filtered.body.map((s: { id: string }) => s.id)).toEqual([mine]);
    const admin = await http()
      .get('/sessions')
      .query({ to: inDays(25) })
      .set(as('ADMIN'))
      .expect(200);
    expect(admin.body.map((s: { id: string }) => s.id)).toEqual(
      expect.arrayContaining([mine, theirs]),
    );

    // The Student joined in 10 days: they see the later Session only.
    const studentId = await enroll(classId, randomUUID(), inDays(10));
    const parent = as('PARENT');
    relations.set(`${studentId}:${parent['x-user-id']}`, 'primary-parent');
    const seen = await http()
      .get('/sessions')
      .query({ studentId, to: inDays(25) })
      .set(parent)
      .expect(200);
    expect(seen.body.map((s: { id: string }) => s.id)).toEqual([later]);
    expect(JSON.stringify(seen.body)).not.toContain(studentId); // no roster data (BR-SC-10)

    await http().get('/sessions').set(parent).expect(400); // studentId required
    await http().get('/sessions').query({ studentId }).set(as('PARENT')).expect(404); // not theirs
    await http()
      .get('/sessions')
      .query({ from: inDays(0), to: inDays(120) })
      .set(tutor)
      .expect(400); // range cap
  });
});
