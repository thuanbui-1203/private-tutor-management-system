/**
 * Integration tests for #18: Enrollment invoices (BR-BI-06, BR-CL-07, diagram 07), with a
 * fake student-service for the Payer check.
 *   docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { createEvent, type EventData, type EventType } from '@tms/contracts';
import { ChargesService } from '../src/charges/charges.service';
import { CopiesService } from '../src/copies/copies.service';
import { EnrollmentsService } from '../src/enrollments/enrollments.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { as, createTestDb, type TestDb } from './support';

describe('Billing: Enrollment invoices (#18)', () => {
  let env: TestDb;
  let app: INestApplication;
  let fakeStudents: Server;
  /** `${studentId}:${userId}` → [relation, isPayer]. */
  const access = new Map<string, [string, boolean]>();

  beforeAll(async () => {
    env = await createTestDb('billing_enr_it');
    fakeStudents = createServer((req, res) => {
      const url = new URL(req.url!, 'http://x');
      const [, , , id] = url.pathname.split('/');
      const userId = url.searchParams.get('userId')!;
      const [relation, isPayer] = access.get(`${id}:${userId}`) ?? [null, false];
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ studentId: id, userId, relation, isPayer }));
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
  const prisma = () => app.get(PrismaService);
  type Handler = (e: never, tx: never) => Promise<void>;
  function handlerFor(type: EventType): Handler {
    const c = app.get(CopiesService);
    const en = app.get(EnrollmentsService);
    const map: Partial<Record<EventType, Handler>> = {
      ClassCreated: c.onClass.bind(c) as Handler,
      StudentCreated: c.onStudent.bind(c) as Handler,
      SessionScheduled: c.onSessionScheduled.bind(c) as Handler,
      StudentEnrolled: en.onEnrolled.bind(en) as Handler,
      StudentWithdrawn: en.onWithdrawn.bind(en) as Handler,
    };
    return map[type]!;
  }
  async function deliver<T extends EventType>(type: T, data: EventData<T>, occurredAt?: Date) {
    const event = createEvent(type, data, { correlationId: randomUUID(), occurredAt });
    await prisma().$transaction((tx) => handlerFor(type)(event as never, tx as never));
  }

  const tutor = as('TUTOR');
  const tutorId = tutor['x-user-id'];
  const DEC = ['2026-12-01', '2026-12-08', '2026-12-15', '2026-12-22', '2026-12-29'];
  async function setup(feeType: 'MONTHLY' | 'PER_SESSION' = 'MONTHLY', sessions = DEC) {
    const classId = randomUUID();
    await deliver('ClassCreated', {
      classId,
      tutorId,
      feeType,
      feeAmount: 1_000_000,
      chargeAbsent: true,
      effectiveFrom: '2026-01',
    });
    for (const d of sessions) {
      await deliver('SessionScheduled', {
        sessionId: randomUUID(),
        classId,
        startAt: `${d}T12:00:00.000Z`,
        studentIds: [],
      });
    }
    const studentId = randomUUID();
    await deliver('StudentCreated', {
      studentId,
      tutorId,
      fullName: 'Nguyễn An',
      payerContact: { name: 'Lan', email: 'lan@example.com' },
    });
    return { classId, studentId };
  }
  async function enroll(
    classId: string,
    studentId: string,
    joinedAt: string,
    feeType: 'MONTHLY' | 'PER_SESSION' = 'MONTHLY',
    enrollmentId = randomUUID(),
  ) {
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId,
        classId,
        studentId,
        studentName: 'Nguyễn An',
        feeType,
        status: feeType === 'MONTHLY' ? 'AWAITING_PAYMENT' : 'ACTIVE',
        joinedAt,
      },
      new Date(`${joinedAt}T03:00:00Z`), // 10:00 in Vietnam
    );
    return enrollmentId;
  }
  const enrollmentInvoices = (enrollmentId: string) =>
    prisma().invoice.findMany({
      where: { enrollmentId, kind: 'ENROLLMENT' },
      include: { items: true },
    });
  const issued = async (enrollmentId: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = 'InvoiceIssued' AND payload->'data'->>'enrollmentId' = $1`,
        [enrollmentId],
      )
    ).rows.map((r) => r.data);
  const monthly = (studentId: string, period: string) =>
    prisma().invoice.findFirst({
      where: { studentId, period, kind: 'MONTHLY' },
      include: { items: true },
    });

  it('joining on the 1st: the full fee, ISSUED at once, due in 7 days, InvoiceIssued', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-01');
    const [invoice] = await enrollmentInvoices(enrollmentId);
    expect(invoice).toMatchObject({
      kind: 'ENROLLMENT',
      status: 'ISSUED',
      period: '2026-12',
      total: 1_000_000,
      tutorId,
      studentName: 'Nguyễn An',
    });
    expect(invoice.dueDate!.toISOString().slice(0, 10)).toBe('2026-12-08');
    expect(invoice.items).toMatchObject([
      { type: 'FEE', enrollmentId, servicePeriod: '2026-12', amount: 1_000_000 },
    ]);
    expect(await issued(enrollmentId)).toEqual([
      {
        invoiceId: invoice.id,
        kind: 'ENROLLMENT',
        studentId,
        enrollmentId,
        period: '2026-12',
        total: 1_000_000,
        dueDate: '2026-12-08',
      },
    ]);
    // A redelivered StudentEnrolled does not issue a second one.
    await enroll(classId, studentId, '2026-12-01', 'MONTHLY', enrollmentId);
    expect(await enrollmentInvoices(enrollmentId)).toHaveLength(1);
    expect(await issued(enrollmentId)).toHaveLength(1);
  });

  it('joining mid-month is prorated by Sessions; the Monthly invoice does not bill that month again', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-09'); // 15, 22, 29 of 5
    const [invoice] = await enrollmentInvoices(enrollmentId);
    expect(invoice.total).toBe(600_000);
    expect(invoice.items[0].description).toBe('Học phí tháng 12/2026 (3/5 buổi) (ghi danh)');
    const charges = app.get(ChargesService);
    await charges.addMonthlyFees('2026-12');
    expect((await monthly(studentId, '2026-12'))?.items ?? []).toEqual([]);
    await charges.addMonthlyFees('2027-01');
    expect((await monthly(studentId, '2027-01'))!.items).toMatchObject([
      { enrollmentId, servicePeriod: '2027-01', amount: 1_000_000 },
    ]);
  });

  it('joining after the last Session of the month bills the next month in full', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-30');
    const [invoice] = await enrollmentInvoices(enrollmentId);
    expect(invoice).toMatchObject({ period: '2027-01', total: 1_000_000 });
    await app.get(ChargesService).addMonthlyFees('2026-12');
    await app.get(ChargesService).addMonthlyFees('2027-01');
    expect(await monthly(studentId, '2026-12')).toBeNull();
    expect(await monthly(studentId, '2027-01')).toBeNull(); // January already paid in advance
  });

  it('a brand-new Class with no Sessions yet is prorated by calendar days', async () => {
    const { classId, studentId } = await setup('MONTHLY', []);
    const enrollmentId = await enroll(classId, studentId, '2026-12-17'); // 15 of 31 days
    const [invoice] = await enrollmentInvoices(enrollmentId);
    expect(invoice.total).toBe(Math.round((1_000_000 * 15) / 31));
    expect(invoice.items[0].description).toContain('(15/31 ngày)');
  });

  it('Per-session Classes get no Enrollment invoice', async () => {
    const { classId, studentId } = await setup('PER_SESSION');
    const enrollmentId = await enroll(classId, studentId, '2026-12-09', 'PER_SESSION');
    expect(await enrollmentInvoices(enrollmentId)).toEqual([]);
    expect(await issued(enrollmentId)).toEqual([]);
    expect(await prisma().enrollmentCopy.findUnique({ where: { enrollmentId } })).toMatchObject({
      feeType: 'PER_SESSION',
    });
  });

  it('withdrawal after 3 days: a negative Adjustment on the next invoice, the Enrollment invoice untouched', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-01');
    const [before] = await enrollmentInvoices(enrollmentId);
    const withdraw = () =>
      deliver(
        'StudentWithdrawn',
        { enrollmentId, classId, studentId, reason: 'UNPAID' },
        new Date('2026-12-04T03:00:00Z'),
      );
    await withdraw(); // enrolled for 1 Dec only: 1 of 5 Sessions = 200,000 of 1,000,000
    expect(await enrollmentInvoices(enrollmentId)).toEqual([before]);
    const dec = await monthly(studentId, '2026-12');
    expect(dec).toMatchObject({ status: 'DRAFT', total: -800_000 });
    expect(dec!.items).toMatchObject([
      {
        type: 'ADJUSTMENT',
        amount: -800_000,
        enrollmentId,
        adjustsItemId: before.items[0].id,
        servicePeriod: '2026-12',
      },
    ]);
    await withdraw(); // a second delivery credits nothing more
    expect((await monthly(studentId, '2026-12'))!.items).toHaveLength(1);
    // And no Monthly line for December either: it was billed (and credited) through the Enrollment.
    await app.get(ChargesService).addMonthlyFees('2026-12');
    expect((await monthly(studentId, '2026-12'))!.total).toBe(-800_000);
  });

  it('withdrawing after the paid month is over credits nothing', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-01');
    await deliver(
      'StudentWithdrawn',
      { enrollmentId, classId, studentId, reason: 'REQUESTED' },
      new Date('2027-01-05T03:00:00Z'),
    );
    expect(await monthly(studentId, '2026-12')).toBeNull();
  });

  it('GET /billing/enrollments/{id}/invoice: Tutor, Admin and the Payer only', async () => {
    const { classId, studentId } = await setup();
    const enrollmentId = await enroll(classId, studentId, '2026-12-09');
    const url = `/billing/enrollments/${enrollmentId}/invoice`;
    const res = await http().get(url).set(tutor).expect(200);
    expect(res.body).toMatchObject({
      kind: 'ENROLLMENT',
      enrollmentId,
      total: 600_000,
      dueDate: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/),
    });
    expect(res.body.items).toHaveLength(1);
    await http().get(url).set(as('ADMIN')).expect(200);
    await http().get(url).set(as('TUTOR')).expect(404);

    const payer = as('PARENT');
    const secondary = as('PARENT');
    const kid = as('STUDENT');
    access.set(`${studentId}:${payer['x-user-id']}`, ['primary-parent', true]);
    access.set(`${studentId}:${secondary['x-user-id']}`, ['secondary-parent', false]);
    access.set(`${studentId}:${kid['x-user-id']}`, ['self', false]); // a minor: not the Payer
    await http().get(url).set(payer).expect(200);
    await http().get(url).set(secondary).expect(404);
    await http().get(url).set(kid).expect(404);
    await http().get(`/billing/enrollments/${randomUUID()}/invoice`).set(tutor).expect(404);
  });
});
