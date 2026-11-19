/**
 * Integration tests for #17: charges from Attendance, Monthly fees and Adjustments.
 * Issued invoices are simulated with an UPDATE (the monthly close is #19).
 *   docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { ChargesService } from '../src/charges/charges.service';
import { CopiesService, NotYetKnownError } from '../src/copies/copies.service';
import { EnrollmentsService } from '../src/enrollments/enrollments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { createTestDb, type TestDb } from './support';

describe('Billing: charges from Attendance and Adjustments (#17)', () => {
  let env: TestDb;
  let app: INestApplication;

  beforeAll(async () => {
    env = await createTestDb('billing_charges_it');
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

  const prisma = () => app.get(PrismaService);
  const charges = () => app.get(ChargesService);
  type Handler = (e: never, tx: never) => Promise<void>;
  const handlerFor = (type: EventType): Handler => {
    const c = app.get(CopiesService);
    const ch = charges();
    const en = app.get(EnrollmentsService);
    const map: Partial<Record<EventType, Handler>> = {
      ClassCreated: c.onClass.bind(c) as Handler,
      ClassUpdated: c.onClass.bind(c) as Handler,
      StudentCreated: c.onStudent.bind(c) as Handler,
      StudentStatusChanged: c.onStudentStatus.bind(c) as Handler,
      SessionScheduled: c.onSessionScheduled.bind(c) as Handler,
      SessionCancelled: c.onSessionCancelled.bind(c) as Handler,
      AttendanceRecorded: ((e: { data: EventData<'AttendanceRecorded'> }, tx: never) =>
        ch.reconcile(tx, e.data)) as Handler,
      AttendanceCorrected: ((e: { data: EventData<'AttendanceCorrected'> }, tx: never) =>
        ch.reconcile(tx, { ...e.data, status: e.data.newStatus })) as Handler,
      StudentEnrolled: ((e: never, tx: never) => en.onEnrolled(e, tx)) as Handler,
      StudentWithdrawn: ((e: never, tx: never) => en.onWithdrawn(e, tx)) as Handler,
    };
    return map[type]!;
  };
  async function deliver<T extends EventType>(type: T, data: EventData<T>, occurredAt?: Date) {
    const event = createEvent(type, data, { correlationId: randomUUID(), occurredAt });
    await prisma().$transaction((tx) => handlerFor(type)(event as never, tx as never));
  }

  const tutorId = randomUUID();
  async function student() {
    const studentId = randomUUID();
    await deliver('StudentCreated', {
      studentId,
      tutorId,
      fullName: 'Nguyễn An',
      payerContact: { name: 'Lan', email: 'lan@example.com' },
    });
    return studentId;
  }
  async function perSessionClass(extra: object = {}) {
    const classId = randomUUID();
    await deliver('ClassCreated', {
      classId,
      tutorId,
      feeType: 'PER_SESSION',
      feeAmount: 200_000,
      chargeAbsent: true,
      effectiveFrom: '2026-01',
      ...extra,
    });
    return classId;
  }
  const attend = (
    studentId: string,
    classId: string,
    date: string,
    status: 'PRESENT' | 'LATE' | 'EXCUSED' | 'ABSENT',
    sessionId = randomUUID(),
  ) =>
    deliver('AttendanceRecorded', { sessionId, studentId, classId, date, status }).then(
      () => sessionId,
    );
  const correct = (
    studentId: string,
    classId: string,
    date: string,
    sessionId: string,
    oldStatus: 'PRESENT' | 'LATE' | 'EXCUSED' | 'ABSENT',
    newStatus: 'PRESENT' | 'LATE' | 'EXCUSED' | 'ABSENT',
  ) =>
    deliver('AttendanceCorrected', { sessionId, studentId, classId, date, oldStatus, newStatus });
  const invoice = (studentId: string, period: string) =>
    prisma().invoice.findFirst({
      where: { studentId, period, kind: 'MONTHLY', status: { not: 'VOID' } },
      include: { items: { orderBy: { createdAt: 'asc' } } },
    });
  const issue = (studentId: string, period: string) =>
    env.db.query(
      `UPDATE invoices SET status = 'ISSUED', issued_at = now() WHERE student_id = $1 AND period = $2 AND kind = 'MONTHLY'`,
      [studentId, period],
    );

  it('charges PRESENT, LATE and ABSENT (if the Class says so), never EXCUSED, on one invoice per month', async () => {
    const studentId = await student();
    const math = await perSessionClass();
    const english = await perSessionClass({ feeAmount: 150_000, chargeAbsent: false });
    await attend(studentId, math, '2026-11-03', 'PRESENT');
    await attend(studentId, math, '2026-11-05', 'LATE');
    await attend(studentId, math, '2026-11-10', 'ABSENT');
    await attend(studentId, math, '2026-11-12', 'EXCUSED');
    await attend(studentId, english, '2026-11-04', 'PRESENT');
    await attend(studentId, english, '2026-11-06', 'ABSENT'); // chargeAbsent = false (BR-BI-08)
    await attend(studentId, english, '2026-12-01', 'PRESENT'); // next month's invoice

    const nov = await invoice(studentId, '2026-11');
    expect(nov).toMatchObject({ status: 'DRAFT', total: 3 * 200_000 + 150_000, tutorId });
    expect(nov!.studentName).toBe('Nguyễn An');
    expect(
      nov!.items.map((i) => [i.classId === math ? 'math' : 'en', i.amount, i.attendanceStatus]),
    ).toEqual([
      ['math', 200_000, 'PRESENT'],
      ['math', 200_000, 'LATE'],
      ['math', 200_000, 'ABSENT'],
      ['en', 150_000, 'PRESENT'],
    ]);
    expect(nov!.items.every((i) => i.type === 'FEE' && i.tutorId === tutorId)).toBe(true);
    expect((await invoice(studentId, '2026-12'))!.total).toBe(150_000);
  });

  it('a duplicate AttendanceRecorded produces one line (BR-BI-01)', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    const sessionId = await attend(studentId, classId, '2026-11-03', 'PRESENT');
    await attend(studentId, classId, '2026-11-03', 'PRESENT', sessionId); // new eventId, same facts
    const nov = await invoice(studentId, '2026-11');
    expect(nov!.items).toHaveLength(1);
    expect(nov!.total).toBe(200_000);
  });

  it('corrections on a DRAFT invoice change the line in place', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    const s = await attend(studentId, classId, '2026-11-03', 'PRESENT');
    await correct(studentId, classId, '2026-11-03', s, 'PRESENT', 'LATE');
    let nov = await invoice(studentId, '2026-11');
    expect(nov!.items).toMatchObject([{ type: 'FEE', amount: 200_000, attendanceStatus: 'LATE' }]);
    await correct(studentId, classId, '2026-11-03', s, 'LATE', 'EXCUSED');
    nov = await invoice(studentId, '2026-11');
    expect(nov!.items).toEqual([]);
    expect(nov!.total).toBe(0);
    await correct(studentId, classId, '2026-11-03', s, 'EXCUSED', 'PRESENT');
    nov = await invoice(studentId, '2026-11');
    expect(nov!.items).toMatchObject([{ type: 'FEE', amount: 200_000 }]);
    expect(nov!.items.filter((i) => i.type === 'ADJUSTMENT')).toEqual([]);
  });

  it('a correction after the close becomes an Adjustment on the next invoice; the issued one is untouched', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    const s = await attend(studentId, classId, '2026-11-30', 'PRESENT');
    await attend(studentId, classId, '2026-11-27', 'PRESENT');
    await issue(studentId, '2026-11'); // 00:00 on 1 Dec
    const before = await invoice(studentId, '2026-11');

    await correct(studentId, classId, '2026-11-30', s, 'PRESENT', 'EXCUSED'); // within 48h
    const after = await invoice(studentId, '2026-11');
    expect(after).toEqual(before); // ADR-0002: never edited, not even updated_at
    const dec = await invoice(studentId, '2026-12');
    expect(dec).toMatchObject({ status: 'DRAFT', total: -200_000 });
    const feeLine = before!.items.find((i) => i.sessionId === s)!;
    expect(dec!.items).toMatchObject([
      {
        type: 'ADJUSTMENT',
        amount: -200_000,
        sessionId: s,
        adjustsItemId: feeLine.id,
        servicePeriod: '2026-11',
        attendanceStatus: 'EXCUSED',
      },
    ]);

    // Changing it back nets to zero with a second Adjustment; a LATE ↔ PRESENT switch bills nothing.
    await correct(studentId, classId, '2026-11-30', s, 'EXCUSED', 'PRESENT');
    await correct(studentId, classId, '2026-11-30', s, 'PRESENT', 'LATE');
    const dec2 = await invoice(studentId, '2026-12');
    expect(dec2!.items.map((i) => i.amount)).toEqual([-200_000, 200_000]);
    expect(dec2!.total).toBe(0);
    expect(await invoice(studentId, '2026-11')).toEqual(before);
  });

  it('Attendance recorded after the close (a MISSED Session) is billed on the next invoice', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    await attend(studentId, classId, '2026-11-02', 'PRESENT');
    await issue(studentId, '2026-11');
    const late = await attend(studentId, classId, '2026-11-30', 'PRESENT');
    const dec = await invoice(studentId, '2026-12');
    expect(dec!.items).toMatchObject([
      { type: 'FEE', sessionId: late, servicePeriod: '2026-11', amount: 200_000 },
    ]);
    expect((await invoice(studentId, '2026-11'))!.items).toHaveLength(1);
  });

  it('Students who are DROPPED are still charged for Sessions they attended (BR-BI-09)', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    await deliver('StudentStatusChanged', { studentId, from: 'ACTIVE', to: 'DROPPED' });
    await attend(studentId, classId, '2026-11-03', 'PRESENT');
    expect((await invoice(studentId, '2026-11'))!.total).toBe(200_000);
  });

  it('uses the fee in force for the Session month, and waits for unknown Classes', async () => {
    const studentId = await student();
    const classId = await perSessionClass();
    await deliver('ClassUpdated', {
      classId,
      tutorId,
      feeType: 'PER_SESSION',
      feeAmount: 250_000,
      chargeAbsent: true,
      effectiveFrom: '2026-12',
    });
    await attend(studentId, classId, '2026-11-30', 'PRESENT');
    await attend(studentId, classId, '2026-12-01', 'PRESENT');
    expect((await invoice(studentId, '2026-11'))!.total).toBe(200_000);
    expect((await invoice(studentId, '2026-12'))!.total).toBe(250_000);
    await expect(attend(studentId, randomUUID(), '2026-11-03', 'PRESENT')).rejects.toBeInstanceOf(
      NotYetKnownError,
    );
  });

  describe('Monthly-fee Classes (BR-BI-05)', () => {
    async function monthlyClass(sessionDates: string[]) {
      const classId = await perSessionClass({ feeType: 'MONTHLY', feeAmount: 1_000_000 });
      const ids: string[] = [];
      for (const d of sessionDates) {
        const sessionId = randomUUID();
        ids.push(sessionId);
        await deliver('SessionScheduled', {
          sessionId,
          classId,
          startAt: `${d}T12:00:00.000Z`,
          studentIds: [],
        });
      }
      return { classId, ids };
    }
    const DEC = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'];
    async function enroll(classId: string, studentId: string, joinedAt: string) {
      const enrollmentId = randomUUID();
      await deliver('StudentEnrolled', {
        enrollmentId,
        classId,
        studentId,
        studentName: 'An',
        feeType: 'MONTHLY',
        status: 'AWAITING_PAYMENT',
        joinedAt,
      });
      return enrollmentId;
    }
    const monthlyLines = async (studentId: string, period: string) =>
      (await invoice(studentId, period))?.items.filter((i) => i.enrollmentId) ?? [];

    it('one flat line per month, unchanged by Attendance, cancellations or Makeup sessions', async () => {
      const { classId, ids } = await monthlyClass(DEC);
      const studentId = await student();
      await enroll(classId, studentId, '2026-10-15');
      await attend(studentId, classId, '2026-12-01', 'PRESENT'); // no per-session charge
      await deliver('SessionCancelled', { sessionId: ids[1], reason: 'Ốm', cancelledBy: tutorId });
      await deliver('SessionScheduled', {
        sessionId: randomUUID(),
        classId,
        startAt: '2026-12-10T12:00:00.000Z',
        studentIds: [],
      });
      expect(await charges().addMonthlyFees('2026-12')).toBeGreaterThanOrEqual(1);
      const lines = await monthlyLines(studentId, '2026-12');
      expect(lines).toMatchObject([
        {
          type: 'FEE',
          amount: 1_000_000,
          servicePeriod: '2026-12',
          description: 'Học phí tháng 12/2026',
        },
      ]);
      expect((await invoice(studentId, '2026-12'))!.items).toHaveLength(1);
      // Running the close step again adds nothing.
      await charges().addMonthlyFees('2026-12');
      expect(await monthlyLines(studentId, '2026-12')).toHaveLength(1);
    });

    it('joining or leaving mid-month is prorated by Session count', async () => {
      const { classId } = await monthlyClass(DEC);
      const joiner = await student();
      await enroll(classId, joiner, '2026-11-20');
      const leaver = await student();
      const leaving = await enroll(classId, leaver, '2026-10-01');
      // Withdrawn on 15 Dec (Vietnam): enrolled for 1 and 8 Dec only = 2 of 5 Sessions; the
      // Session on the day of withdrawal is not theirs (the Roster drops them that day).
      await deliver(
        'StudentWithdrawn',
        { enrollmentId: leaving, classId, studentId: leaver, reason: 'REQUESTED' },
        new Date('2026-12-15T03:00:00Z'),
      );
      const midJoiner = await student();
      await enroll(classId, midJoiner, '2026-12-09'); // 15, 22, 29 = 3 of 5, but the first month
      await charges().addMonthlyFees('2026-12');
      expect((await monthlyLines(joiner, '2026-12'))[0].amount).toBe(1_000_000);
      expect(await monthlyLines(leaver, '2026-12')).toMatchObject([
        { amount: 400_000, description: 'Học phí tháng 12/2026 (2/5 buổi)' },
      ]);
      // December is the mid-month joiner's first month: billed by their Enrollment invoice (#18)
      // when one exists; without one, this run bills the prorated share.
      expect((await monthlyLines(midJoiner, '2026-12'))[0].amount).toBe(600_000);
      // January: the leaver is gone.
      await charges().addMonthlyFees('2027-01');
      expect(await monthlyLines(leaver, '2027-01')).toEqual([]);
    });

    it('skips a month already billed for the Enrollment', async () => {
      const { classId } = await monthlyClass(DEC);
      const studentId = await student();
      const enrollmentId = await enroll(classId, studentId, '2026-12-09');
      // What the Enrollment invoice (#18) records for the first month.
      const enrollmentInvoice = await prisma().invoice.create({
        data: {
          kind: 'ENROLLMENT',
          studentId,
          tutorId,
          enrollmentId,
          studentName: 'An',
          payerContact: { name: 'Lan' },
          period: '2026-12',
          status: 'ISSUED',
        },
      });
      await prisma().invoiceItem.create({
        data: {
          invoiceId: enrollmentInvoice.id,
          type: 'FEE',
          studentId,
          tutorId,
          classId,
          enrollmentId,
          servicePeriod: '2026-12',
          amount: 600_000,
          description: 'Học phí tháng 12/2026 (3/5 buổi)',
        },
      });
      await charges().addMonthlyFees('2026-12');
      expect(await monthlyLines(studentId, '2026-12')).toEqual([]);
      await charges().addMonthlyFees('2027-01');
      expect((await monthlyLines(studentId, '2027-01'))[0].amount).toBe(1_000_000);
    });
  });
});
