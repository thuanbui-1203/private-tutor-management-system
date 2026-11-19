/**
 * Integration tests for #16: Billing's local copies of Classes, Students and Sessions.
 *   docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { CopiesService, NotYetKnownError } from '../src/copies/copies.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDb, type TestDb } from './support';

describe('Billing: local copies (#16)', () => {
  let env: TestDb;
  let app: INestApplication;

  beforeAll(async () => {
    env = await createTestDb('billing_copies_it');
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

  const copies = () => app.get(CopiesService);
  const prisma = () => app.get(PrismaService);
  type Handler = (e: never, tx: never) => Promise<void>;
  const HANDLERS: Partial<Record<EventType, (c: CopiesService) => Handler>> = {
    ClassCreated: (c) => c.onClass.bind(c) as Handler,
    ClassUpdated: (c) => c.onClass.bind(c) as Handler,
    StudentCreated: (c) => c.onStudent.bind(c) as Handler,
    StudentUpdated: (c) => c.onStudent.bind(c) as Handler,
    StudentStatusChanged: (c) => c.onStudentStatus.bind(c) as Handler,
    SessionScheduled: (c) => c.onSessionScheduled.bind(c) as Handler,
    SessionCancelled: (c) => c.onSessionCancelled.bind(c) as Handler,
    SessionRescheduled: (c) => c.onSessionRescheduled.bind(c) as Handler,
  };
  async function deliver<T extends EventType>(type: T, data: EventData<T>) {
    const event = createEvent(type, data, { correlationId: randomUUID() });
    const handler = HANDLERS[type]!(copies());
    await prisma().$transaction((tx) => handler(event as never, tx as never));
    return event;
  }
  const classEvent = (classId: string, extra: object = {}) => ({
    classId,
    tutorId: tutorId,
    feeType: 'MONTHLY' as const,
    feeAmount: 1_200_000,
    chargeAbsent: true,
    effectiveFrom: '2026-11',
    ...extra,
  });
  const tutorId = randomUUID();
  /** 19:00 in Vietnam on `date` (12:00Z). */
  const at = (date: string) => `${date}T12:00:00.000Z`;
  const calendar = async (sessionId: string) =>
    (
      await env.db.query(
        `SELECT to_char(date, 'YYYY-MM-DD') AS date, status FROM session_calendar WHERE session_id = $1`,
        [sessionId],
      )
    ).rows[0];

  it('keeps the fee history: a change made in November applies to December, not November', async () => {
    const classId = randomUUID();
    await deliver('ClassCreated', classEvent(classId));
    await deliver(
      'ClassUpdated',
      classEvent(classId, { feeAmount: 1_500_000, chargeAbsent: false, effectiveFrom: '2026-12' }),
    );
    const fee = async (period: string) =>
      (await copies().policyFor(prisma(), classId, period))?.feeAmount ?? null;
    expect(await fee('2026-10')).toBeNull(); // before the Class existed
    expect(await fee('2026-11')).toBe(1_200_000);
    expect(await fee('2026-12')).toBe(1_500_000);
    expect(await fee('2027-03')).toBe(1_500_000);
    expect((await copies().policyFor(prisma(), classId, '2026-11'))?.chargeAbsent).toBe(true);
    expect(await copies().policyFor(prisma(), classId, '2026-12')).toMatchObject({
      chargeAbsent: false,
      tutorId,
      feeType: 'MONTHLY',
    });
    // A second change for the same period replaces it (the latest decision wins).
    await deliver(
      'ClassUpdated',
      classEvent(classId, { feeAmount: 1_400_000, effectiveFrom: '2026-12' }),
    );
    expect(await fee('2026-12')).toBe(1_400_000);
    expect(await fee('2026-11')).toBe(1_200_000);
  });

  it('copies Students and their status; a status that overtakes StudentCreated is retried', async () => {
    const studentId = randomUUID();
    await expect(
      deliver('StudentStatusChanged', { studentId, from: 'ACTIVE', to: 'PAUSED' }),
    ).rejects.toBeInstanceOf(NotYetKnownError);
    const created = {
      studentId,
      tutorId,
      fullName: 'Nguyễn An',
      payerContact: { name: 'Lan', email: 'lan@example.com' },
    };
    await deliver('StudentCreated', created);
    await deliver('StudentStatusChanged', { studentId, from: 'ACTIVE', to: 'DROPPED' });
    await deliver('StudentUpdated', { ...created, fullName: 'Nguyễn Văn An' });
    expect(await prisma().studentSnapshot.findUnique({ where: { studentId } })).toMatchObject({
      fullName: 'Nguyễn Văn An',
      payerContact: { name: 'Lan', email: 'lan@example.com' },
      status: 'DROPPED', // an update does not reset the status
    });
  });

  it('dates Sessions in Vietnam time (19:00Z on the 30th is the 1st locally)', async () => {
    const sessionId = randomUUID();
    await deliver('SessionScheduled', {
      sessionId,
      classId: randomUUID(),
      startAt: '2026-11-30T18:00:00.000Z',
      studentIds: [],
    });
    expect(await calendar(sessionId)).toEqual({ date: '2026-12-01', status: 'SCHEDULED' });
  });

  it('countSessions counts a rescheduled Session once, skips cancelled ones, counts makeups', async () => {
    const classId = randomUUID();
    const ids = [1, 2, 3, 4].map(() => randomUUID());
    const dates = ['2026-12-03', '2026-12-10', '2026-12-17', '2026-12-24'];
    for (const [i, sessionId] of ids.entries()) {
      await deliver('SessionScheduled', {
        sessionId,
        classId,
        startAt: at(dates[i]),
        studentIds: [],
      });
    }
    const count = (from = '2026-12-01', to = '2026-12-31') =>
      copies().countSessions(prisma(), classId, from, to);
    expect(await count()).toBe(4);
    expect(await count('2026-12-10', '2026-12-17')).toBe(2); // inclusive bounds

    // Moved within the month: still 4, and the old date is gone.
    const moved = randomUUID();
    await deliver('SessionRescheduled', {
      oldSessionId: ids[0],
      newSessionId: moved,
      classId,
      newStartAt: at('2026-12-05'),
      studentIds: [],
    });
    expect(await count()).toBe(4);
    expect(await count('2026-12-03', '2026-12-03')).toBe(0);
    expect(await calendar(ids[0])).toEqual({ date: '2026-12-03', status: 'RESCHEDULED' });

    // Moved into January: December loses it.
    await deliver('SessionRescheduled', {
      oldSessionId: ids[3],
      newSessionId: randomUUID(),
      classId,
      newStartAt: at('2027-01-02'),
      studentIds: [],
    });
    expect(await count()).toBe(3);

    // Cancelled: not counted; its Makeup is.
    await deliver('SessionCancelled', { sessionId: ids[1], reason: 'Ốm', cancelledBy: tutorId });
    expect(await count()).toBe(2);
    await deliver('SessionScheduled', {
      sessionId: randomUUID(),
      classId,
      startAt: at('2026-12-12'),
      studentIds: [],
    });
    expect(await count()).toBe(3);

    // A late redelivery of the original SessionScheduled does not bring a cancelled one back.
    await deliver('SessionScheduled', {
      sessionId: ids[1],
      classId,
      startAt: at(dates[1]),
      studentIds: [],
    });
    expect(await calendar(ids[1])).toEqual({ date: '2026-12-10', status: 'CANCELLED' });
    expect(await count()).toBe(3);

    await expect(
      deliver('SessionCancelled', { sessionId: randomUUID(), reason: 'x', cancelledBy: tutorId }),
    ).rejects.toBeInstanceOf(NotYetKnownError);
  });

  it('replaying every event leaves the copies unchanged', async () => {
    const classId = randomUUID();
    const studentId = randomUUID();
    const s1 = randomUUID();
    const s2 = randomUUID();
    const s3 = randomUUID();
    const events: [EventType, object][] = [
      ['ClassCreated', classEvent(classId)],
      ['ClassUpdated', classEvent(classId, { feeAmount: 900_000, effectiveFrom: '2027-01' })],
      [
        'StudentCreated',
        { studentId, tutorId, fullName: 'Bình', payerContact: { name: 'Hà', phone: '0901234567' } },
      ],
      [
        'StudentUpdated',
        {
          studentId,
          tutorId,
          fullName: 'Trần Bình',
          payerContact: { name: 'Hà', phone: '0901234567' },
        },
      ],
      ['StudentStatusChanged', { studentId, from: 'ACTIVE', to: 'PAUSED' }],
      [
        'SessionScheduled',
        { sessionId: s1, classId, startAt: at('2026-12-01'), studentIds: [studentId] },
      ],
      [
        'SessionScheduled',
        { sessionId: s2, classId, startAt: at('2026-12-08'), studentIds: [studentId] },
      ],
      ['SessionCancelled', { sessionId: s2, reason: 'Bận', cancelledBy: tutorId }],
      [
        'SessionRescheduled',
        {
          oldSessionId: s1,
          newSessionId: s3,
          classId,
          newStartAt: at('2026-12-02'),
          studentIds: [studentId],
        },
      ],
    ];
    const snapshot = async () => ({
      fees: (
        await env.db.query(
          'SELECT class_id, effective_from, tutor_id, fee_type, fee_amount, charge_absent FROM fee_policies WHERE class_id = $1 ORDER BY effective_from',
          [classId],
        )
      ).rows,
      student: (
        await env.db.query(
          'SELECT student_id, full_name, payer_contact, status FROM student_snapshots WHERE student_id = $1',
          [studentId],
        )
      ).rows,
      calendar: (
        await env.db.query(
          `SELECT session_id, to_char(date, 'YYYY-MM-DD') AS date, status FROM session_calendar WHERE class_id = $1 ORDER BY session_id`,
          [classId],
        )
      ).rows,
    });
    const envelopes = events.map(([type, data]) =>
      createEvent(type, data as never, { correlationId: randomUUID() }),
    );
    const run = async () => {
      for (const e of envelopes) {
        const handler = HANDLERS[e.eventType]!(copies());
        await prisma().$transaction((tx) => handler(e as never, tx as never));
      }
    };
    await run();
    const first = await snapshot();
    expect(first.calendar).toHaveLength(3);
    await run(); // the same envelopes again, in order
    expect(await snapshot()).toEqual(first);
  });
});
