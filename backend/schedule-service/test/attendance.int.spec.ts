/**
 * Integration tests for #15 (Attendance) against a throwaway database and a fake
 * student-service. Sequence: docs/diagrams/08-sequence-attendance-billing.puml (Schedule side).
 *   docker compose up -d postgres && pnpm --filter @tms/schedule-service test:int
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { AuthUser } from '@tms/common';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { AttendanceService } from '../src/attendance/attendance.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { addDays } from '../src/schedules/calendar';
import { RosterService } from '../src/schedules/roster.service';
import { SchedulesService } from '../src/schedules/schedules.service';
import { SessionsService } from '../src/sessions/sessions.service';
import { as, createTestDb, type TestDb } from './support';

const HOUR = 3_600_000;

describe('Schedule: Attendance (#15)', () => {
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
    env = await createTestDb('schedule_att_it');
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
  const attendance = () => app.get(AttendanceService);
  const me = () => ({ id: tutor['x-user-id'], role: 'TUTOR' }) as AuthUser;
  async function deliver<T extends EventType>(
    type: T,
    data: EventData<T>,
    handler: (e: never, tx: never) => Promise<void>,
  ) {
    const event = createEvent(type, data, { correlationId: randomUUID() });
    await app.get(PrismaService).$transaction((tx) => handler(event as never, tx as never));
  }
  async function knownClass() {
    const classId = randomUUID();
    await deliver(
      'ClassCreated',
      {
        classId,
        tutorId: tutor['x-user-id'],
        feeType: 'PER_SESSION',
        feeAmount: 200000,
        chargeAbsent: true,
        effectiveFrom: '2026-11',
      },
      (e, tx) => app.get(RosterService).onClass(e, tx),
    );
    return classId;
  }
  async function enroll(classId: string, studentName: string, joinedAt: string) {
    const studentId = randomUUID();
    const enrollmentId = randomUUID();
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId,
        classId,
        studentId,
        studentName,
        feeType: 'PER_SESSION',
        status: 'ACTIVE',
        joinedAt,
      },
      (e, tx) => app.get(RosterService).onEnrolled(e, tx),
    );
    return { studentId, enrollmentId };
  }
  /** A Session starting at `startsAt` (any instant), bypassing the API's future-only rule. */
  async function sessionAt(classId: string, startsAt: Date, minutes = 90) {
    const local = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString();
    const endsAt = new Date(startsAt.getTime() + minutes * 60_000);
    const s = await app.get(PrismaService).$transaction((tx) =>
      app.get(SchedulesService).createSession(
        tx,
        { classId, tutorId: tutor['x-user-id'] },
        {
          date: local(startsAt).slice(0, 10),
          startTime: local(startsAt).slice(11, 16),
          endTime: local(endsAt).slice(11, 16),
          startsAt,
          endsAt,
        },
      ),
    );
    return { id: s.id, date: local(startsAt).slice(0, 10), endsAt };
  }
  /** A Group Class with An and Bình on the Roster, plus one who joined later and one who left. */
  async function groupClass(sessionStart: Date) {
    const classId = await knownClass();
    const session = await sessionAt(classId, sessionStart);
    const an = await enroll(classId, 'An', addDays(session.date, -30));
    const binh = await enroll(classId, 'Bình', addDays(session.date, -30));
    await enroll(classId, 'Chi (joins later)', addDays(session.date, 1));
    const dung = await enroll(classId, 'Dũng (left)', addDays(session.date, -30));
    await env.db.query(`UPDATE class_roster_view SET left_at = $2 WHERE student_id = $1`, [
      dung.studentId,
      addDays(session.date, -1),
    ]);
    return { classId, session, an: an.studentId, binh: binh.studentId, dung: dung.studentId };
  }
  const status = async (id: string) =>
    (await env.db.query('SELECT status FROM sessions WHERE id = $1', [id])).rows[0]?.status;
  const events = async (type: string, sessionId: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = $1 AND payload->'data'->>'sessionId' = $2 ORDER BY created_at`,
        [type, sessionId],
      )
    ).rows.map((r) => r.data);
  const put = (id: string, records: object[]) =>
    http().put(`/sessions/${id}/attendance`).set(tutor).send({ records });

  it('refuses attendance before the Session starts, and for cancelled ones (409, BR-SC-02)', async () => {
    const classId = await knownClass();
    const future = await sessionAt(classId, new Date(Date.now() + 2 * HOUR));
    await put(future.id, []).expect(409);
    const cancelled = await sessionAt(classId, new Date(Date.now() - 30 * 60_000));
    await http()
      .post(`/sessions/${cancelled.id}/cancel`)
      .set(tutor)
      .send({ reason: 'Ốm' })
      .expect(200);
    await put(cancelled.id, []).expect(409);
    expect(await events('AttendanceRecorded', cancelled.id)).toEqual([]);
  });

  it('records the whole Roster of the day, rejects missing / extra Students', async () => {
    const g = await groupClass(new Date(Date.now() - 30 * 60_000));
    const sheet = await http().get(`/sessions/${g.session.id}/attendance`).set(tutor).expect(200);
    expect(sheet.body.students.map((s: { studentName: string }) => s.studentName)).toEqual([
      'An',
      'Bình',
    ]); // not the later joiner, not the one who had left
    expect(sheet.body.students.every((s: { status: null }) => s.status === null)).toBe(true);

    const missing = await put(g.session.id, [{ studentId: g.an, status: 'PRESENT' }]).expect(422);
    expect(missing.body.missing).toEqual([g.binh]);
    const extra = await put(g.session.id, [
      { studentId: g.an, status: 'PRESENT' },
      { studentId: g.binh, status: 'PRESENT' },
      { studentId: g.dung, status: 'PRESENT' },
    ]).expect(422);
    expect(extra.body.unknown).toEqual([g.dung]);
    await put(g.session.id, [
      { studentId: g.an, status: 'PRESENT' },
      { studentId: g.an, status: 'LATE' },
    ]).expect(400);
    await put(g.session.id, [
      { studentId: g.an, status: 'HERE' },
      { studentId: g.binh, status: 'PRESENT' },
    ]).expect(400);

    // Session not started by the Tutor but already under way: recording is fine (SCHEDULED → COMPLETED).
    const ok = await put(g.session.id, [
      { studentId: g.an, status: 'PRESENT' },
      { studentId: g.binh, status: 'EXCUSED', note: 'Báo ốm' }, // BR-SC-08: no 24h check
    ]).expect(200);
    expect(ok.body.session.status).toBe('COMPLETED');
    expect(await status(g.session.id)).toBe('COMPLETED');
    const recorded = await events('AttendanceRecorded', g.session.id);
    expect(recorded).toHaveLength(2);
    expect(recorded).toEqual(
      expect.arrayContaining([
        {
          sessionId: g.session.id,
          studentId: g.an,
          classId: g.classId,
          status: 'PRESENT',
          date: g.session.date,
        },
        {
          sessionId: g.session.id,
          studentId: g.binh,
          classId: g.classId,
          status: 'EXCUSED',
          date: g.session.date,
        },
      ]),
    );
    await http()
      .put(`/sessions/${g.session.id}/attendance`)
      .set(as('TUTOR'))
      .send({ records: [] })
      .expect(404);
    await http()
      .put(`/sessions/${g.session.id}/attendance`)
      .set(as('PARENT'))
      .send({ records: [] })
      .expect(403);
  });

  it('corrections until 48h after the end: at 47h AttendanceCorrected for changes only, at 49h 409', async () => {
    const g = await groupClass(new Date(Date.now() - 2 * HOUR));
    await put(g.session.id, [
      { studentId: g.an, status: 'PRESENT' },
      { studentId: g.binh, status: 'ABSENT' },
    ]).expect(200);
    const end = g.session.endsAt.getTime();
    const at = (h: number) => new Date(end + h * HOUR);

    const res = await attendance().record(
      me(),
      g.session.id,
      {
        records: [
          { studentId: g.an, status: 'PRESENT', note: 'Làm bài tốt' }, // note only: no event
          { studentId: g.binh, status: 'EXCUSED' },
        ],
      },
      at(47),
    );
    expect(res.corrected).toBe(true);
    expect(await events('AttendanceCorrected', g.session.id)).toEqual([
      {
        sessionId: g.session.id,
        studentId: g.binh,
        classId: g.classId,
        date: g.session.date,
        oldStatus: 'ABSENT',
        newStatus: 'EXCUSED',
      },
    ]);
    expect(await events('AttendanceRecorded', g.session.id)).toHaveLength(2); // no new ones

    await expect(
      attendance().record(
        me(),
        g.session.id,
        {
          records: [
            { studentId: g.an, status: 'ABSENT' },
            { studentId: g.binh, status: 'ABSENT' },
          ],
        },
        at(49),
      ),
    ).rejects.toMatchObject({ status: 409 });
    expect(await events('AttendanceCorrected', g.session.id)).toHaveLength(1);
  });

  it('a MISSED Session can be recorded until 48h after its end, then it is locked (BR-SC-09)', async () => {
    const g = await groupClass(new Date(Date.now() - 30 * HOUR)); // ended 28.5h ago
    await app.get(SessionsService).markMissed();
    expect(await status(g.session.id)).toBe('MISSED');
    await put(g.session.id, [
      { studentId: g.an, status: 'PRESENT' },
      { studentId: g.binh, status: 'LATE' },
    ]).expect(200);
    expect(await status(g.session.id)).toBe('COMPLETED');
    expect(await events('AttendanceRecorded', g.session.id)).toHaveLength(2);

    const locked = await groupClass(new Date(Date.now() - 52 * HOUR)); // ended 50.5h ago
    await app.get(SessionsService).markMissed();
    expect(await status(locked.session.id)).toBe('MISSED');
    await put(locked.session.id, [
      { studentId: locked.an, status: 'PRESENT' },
      { studentId: locked.binh, status: 'PRESENT' },
    ]).expect(409);
    expect(await status(locked.session.id)).toBe('MISSED');
    expect(await events('AttendanceRecorded', locked.session.id)).toEqual([]);
  });

  it("a Parent in a Group Class sees only their child's Attendance (BR-SC-10)", async () => {
    const g = await groupClass(new Date(Date.now() - 3 * HOUR));
    await put(g.session.id, [
      { studentId: g.an, status: 'LATE', note: 'Trễ 10 phút' },
      { studentId: g.binh, status: 'ABSENT', note: 'Không báo' },
    ]).expect(200);
    const month = g.session.date.slice(0, 7);
    const parent = as('PARENT');
    relations.set(`${g.an}:${parent['x-user-id']}`, 'primary-parent');

    const res = await http()
      .get(`/students/${g.an}/attendance`)
      .query({ month })
      .set(parent)
      .expect(200);
    expect(res.body).toMatchObject({
      studentId: g.an,
      month,
      summary: { PRESENT: 0, LATE: 1, EXCUSED: 0, ABSENT: 0 },
    });
    expect(res.body.records).toEqual([
      expect.objectContaining({ sessionId: g.session.id, status: 'LATE', note: 'Trễ 10 phút' }),
    ]);
    const body = JSON.stringify(res.body);
    expect(body).not.toContain(g.binh);
    expect(body).not.toContain('Không báo');

    // Not their child → 404; the Student themself can see it; another month is empty.
    await http().get(`/students/${g.binh}/attendance`).query({ month }).set(parent).expect(404);
    const self = as('STUDENT');
    relations.set(`${g.an}:${self['x-user-id']}`, 'self');
    await http().get(`/students/${g.an}/attendance`).query({ month }).set(self).expect(200);
    const other = await http()
      .get(`/students/${g.an}/attendance`)
      .query({ month: '2020-01' })
      .set(parent)
      .expect(200);
    expect(other.body.records).toEqual([]);
    await http()
      .get(`/students/${g.an}/attendance`)
      .query({ month: '2026-13' })
      .set(parent)
      .expect(400);

    // The Tutor sees their own Sessions; another Tutor gets 404, not an empty list.
    const mine = await http()
      .get(`/students/${g.binh}/attendance`)
      .query({ month })
      .set(tutor)
      .expect(200);
    expect(mine.body.records[0]).toMatchObject({ status: 'ABSENT', note: 'Không báo' });
    await http()
      .get(`/students/${g.binh}/attendance`)
      .query({ month })
      .set(as('TUTOR'))
      .expect(404);
  });
});
