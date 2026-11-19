/**
 * Integration tests for #20: Payments, Reversals, balances, revenue, VietQR and the internal
 * open-invoices check, with a fake student-service for the Payer check.
 *   docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomUUID } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { AuthUser } from '@tms/common';
import { createEvent, type AttendanceStatus, type EventData, type EventType } from '@tms/contracts';
import { ChargesService } from '../src/charges/charges.service';
import { CopiesService } from '../src/copies/copies.service';
import { EnrollmentsService } from '../src/enrollments/enrollments.service';
import { LifecycleService } from '../src/invoices/lifecycle.service';
import { PaymentsService } from '../src/payments/payments.service';
import { crc16 } from '../src/payments/vietqr';
import { PrismaService } from '../src/prisma/prisma.service';
import { as, createTestDb, type TestDb } from './support';

const vn = (local: string) => new Date(`${local}+07:00`);

describe('Billing: Payments, Reversals and reports (#20)', () => {
  let env: TestDb;
  let app: INestApplication;
  let fakeStudents: Server;
  const access = new Map<string, [string, boolean]>();

  beforeAll(async () => {
    env = await createTestDb('billing_pay_it');
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
  const payments = () => app.get(PaymentsService);
  type Handler = (e: never, tx: never) => Promise<void>;
  function handlerFor(type: EventType): Handler {
    const c = app.get(CopiesService);
    const ch = app.get(ChargesService);
    const en = app.get(EnrollmentsService);
    const map: Partial<Record<EventType, Handler>> = {
      ClassCreated: c.onClass.bind(c) as Handler,
      StudentCreated: c.onStudent.bind(c) as Handler,
      AttendanceRecorded: ((e: { data: EventData<'AttendanceRecorded'> }, tx: never) =>
        ch.reconcile(tx, e.data)) as Handler,
      StudentEnrolled: en.onEnrolled.bind(en) as Handler,
    };
    return map[type]!;
  }
  async function deliver<T extends EventType>(type: T, data: EventData<T>, occurredAt?: Date) {
    const event = createEvent(type, data, { correlationId: randomUUID(), occurredAt });
    await prisma().$transaction((tx) => handlerFor(type)(event as never, tx as never));
  }

  const tutor = as('TUTOR');
  const tutorId = tutor['x-user-id'];
  const me = { id: tutorId, role: 'TUTOR' } as AuthUser;
  let classId: string;
  beforeAll(async () => {
    classId = randomUUID();
    await deliver('ClassCreated', {
      classId,
      tutorId,
      feeType: 'PER_SESSION',
      feeAmount: 200_000,
      chargeAbsent: true,
      effectiveFrom: '2026-01',
    });
  });
  async function student(owner = tutorId) {
    const studentId = randomUUID();
    await deliver('StudentCreated', {
      studentId,
      tutorId: owner,
      fullName: 'Nguyễn An',
      payerContact: { name: 'Lan', email: 'lan@example.com' },
    });
    return studentId;
  }
  const attend = (
    studentId: string,
    date: string,
    status: AttendanceStatus = 'PRESENT',
    cls = classId,
  ) =>
    deliver('AttendanceRecorded', {
      sessionId: randomUUID(),
      studentId,
      classId: cls,
      date,
      status,
    });
  /** An ISSUED Monthly invoice of `sessions × 200,000` for `period`, due the 10th of the next month. */
  async function issued(period: string, sessions = 2, studentId?: string) {
    const s = studentId ?? (await student());
    for (let i = 1; i <= sessions; i++)
      await attend(s, `${period}-${String(i + 1).padStart(2, '0')}`);
    const [y, m] = period.split('-').map(Number);
    const next = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    await app.get(LifecycleService).closeMonth(vn(`${next}-01T00:01:00`));
    const invoice = await prisma().invoice.findFirstOrThrow({
      where: { studentId: s, period, kind: 'MONTHLY' },
    });
    return { studentId: s, invoice };
  }
  const pay = (invoiceId: string, amount: number, who: Record<string, string> = tutor) =>
    http()
      .post(`/billing/invoices/${invoiceId}/payments`)
      .set(who)
      .send({ amount, method: 'BANK_TRANSFER' });
  const status = async (id: string) =>
    (await prisma().invoice.findUniqueOrThrow({ where: { id } })).status;
  const received = async (invoiceId: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = 'PaymentReceived' AND payload->'data'->>'invoiceId' = $1 ORDER BY created_at`,
        [invoiceId],
      )
    ).rows.map((r) => r.data);

  it('rejects an overpayment; partial then full payment; PaymentReceived each time', async () => {
    const { invoice } = await issued('2028-03'); // 400,000
    const over = await pay(invoice.id, 400_001).expect(422);
    expect(over.body.outstanding).toBe(400_000);
    await pay(invoice.id, 0).expect(400);
    const first = await pay(invoice.id, 150_000).expect(201);
    expect(first.body).toMatchObject({ invoiceStatus: 'PARTIALLY_PAID', outstanding: 250_000 });
    await pay(invoice.id, 250_001).expect(422);
    const second = await pay(invoice.id, 250_000).expect(201);
    expect(second.body).toMatchObject({ invoiceStatus: 'PAID', outstanding: 0 });
    expect(await status(invoice.id)).toBe('PAID');
    await pay(invoice.id, 1).expect(409); // nothing left to take
    expect(await received(invoice.id)).toEqual([
      {
        invoiceId: invoice.id,
        invoiceKind: 'MONTHLY',
        amount: 150_000,
        method: 'BANK_TRANSFER',
        invoiceStatus: 'PARTIALLY_PAID',
      },
      {
        invoiceId: invoice.id,
        invoiceKind: 'MONTHLY',
        amount: 250_000,
        method: 'BANK_TRANSFER',
        invoiceStatus: 'PAID',
      },
    ]);
    // Only the Tutor of the Student or Admin record money; never on a draft.
    await pay(invoice.id, 1, as('TUTOR')).expect(404);
    await pay(invoice.id, 1, as('PARENT')).expect(403);
    const draftOwner = await student();
    await attend(draftOwner, '2028-09-02');
    const draft = await prisma().invoice.findFirstOrThrow({ where: { studentId: draftOwner } });
    await pay(draft.id, 1).expect(409);
    await http()
      .post(`/billing/invoices/${invoice.id}/payments`)
      .set(tutor)
      .send({ amount: 1, method: 'CASH', paidAt: '2099-01-01T00:00:00Z' })
      .expect(422);
  });

  it('a Reversal of a full payment returns the Invoice to ISSUED, or OVERDUE once past due', async () => {
    const { invoice } = await issued('2028-04'); // due 2028-05-10
    const p = await payments().record(
      me,
      invoice.id,
      { amount: 400_000, method: 'CASH' },
      vn('2028-05-05T10:00:00'),
    );
    expect(p.invoiceStatus).toBe('PAID');
    const r = await payments().reverse(
      me,
      p.payment.id,
      { reason: 'Ghi nhầm hóa đơn' },
      vn('2028-05-06T10:00:00'),
    );
    expect(r.invoiceStatus).toBe('ISSUED');
    await expect(
      payments().reverse(me, p.payment.id, { reason: 'again' }, vn('2028-05-06T11:00:00')),
    ).rejects.toMatchObject({ status: 409 });
    await expect(
      payments().reverse(me, r.reversal.id, { reason: 'undo' }, vn('2028-05-06T11:00:00')),
    ).rejects.toMatchObject({ status: 409 });

    const late = await issued('2028-05'); // due 2028-06-10
    const lp = await payments().record(
      me,
      late.invoice.id,
      { amount: 400_000, method: 'MOMO' },
      vn('2028-06-09T10:00:00'),
    );
    const lr = await payments().reverse(
      me,
      lp.payment.id,
      { reason: 'Chuyển khoản bị hoàn' },
      vn('2028-06-15T10:00:00'),
    );
    expect(lr.invoiceStatus).toBe('OVERDUE');

    // Two payments, one reversed: back to PARTIALLY_PAID; paying while overdue stays OVERDUE.
    const two = await issued('2028-06'); // due 2028-07-10
    const a = await payments().record(
      me,
      two.invoice.id,
      { amount: 100_000, method: 'CASH' },
      vn('2028-07-01T10:00:00'),
    );
    await payments().record(
      me,
      two.invoice.id,
      { amount: 300_000, method: 'CASH' },
      vn('2028-07-02T10:00:00'),
    );
    expect(
      (await payments().reverse(me, a.payment.id, { reason: 'x' }, vn('2028-07-03T10:00:00')))
        .invoiceStatus,
    ).toBe('PARTIALLY_PAID');
    const stillLate = await payments().record(
      me,
      late.invoice.id,
      { amount: 100_000, method: 'CASH' },
      vn('2028-06-20T10:00:00'),
    );
    expect(stillLate.invoiceStatus).toBe('OVERDUE');
    expect((await received(late.invoice.id)).at(-1).invoiceStatus).toBe('PARTIALLY_PAID');
  });

  it('payments cannot be updated or deleted, only reversed', async () => {
    const { invoice } = await issued('2028-07');
    const p = await pay(invoice.id, 100_000).expect(201);
    await expect(
      env.db.query('UPDATE payments SET amount = 1 WHERE id = $1', [p.body.payment.id]),
    ).rejects.toThrow(/insert-only/);
    await expect(
      env.db.query('DELETE FROM payments WHERE id = $1', [p.body.payment.id]),
    ).rejects.toThrow(/insert-only/);
    const { rows } = await env.db.query('SELECT amount FROM payments WHERE id = $1', [
      p.body.payment.id,
    ]);
    expect(rows[0].amount).toBe(100_000);
  });

  it('paying an Enrollment invoice in full publishes PaymentReceived PAID with the enrollmentId', async () => {
    const monthly = randomUUID();
    await deliver('ClassCreated', {
      classId: monthly,
      tutorId,
      feeType: 'MONTHLY',
      feeAmount: 1_000_000,
      chargeAbsent: true,
      effectiveFrom: '2026-01',
    });
    const studentId = await student();
    const enrollmentId = randomUUID();
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId,
        classId: monthly,
        studentId,
        studentName: 'An',
        feeType: 'MONTHLY',
        status: 'AWAITING_PAYMENT',
        joinedAt: '2028-08-01',
      },
      vn('2028-08-01T10:00:00'),
    );
    const invoice = await prisma().invoice.findFirstOrThrow({ where: { enrollmentId } });
    await pay(invoice.id, 400_000).expect(201);
    await pay(invoice.id, 600_000).expect(201);
    expect((await received(invoice.id)).at(-1)).toEqual({
      invoiceId: invoice.id,
      invoiceKind: 'ENROLLMENT',
      enrollmentId,
      amount: 600_000,
      method: 'BANK_TRANSFER',
      invoiceStatus: 'PAID',
    });
  });

  it('balance: what is still owed, for the Tutor and the Payer only', async () => {
    const studentId = await student();
    const a = await issued('2028-10', 2, studentId); // 400,000
    const b = await issued('2028-11', 1, studentId); // 200,000
    await pay(a.invoice.id, 150_000).expect(201);
    await pay(b.invoice.id, 200_000).expect(201); // paid off: no longer listed
    await attend(studentId, '2028-12-03'); // a draft, not owed yet
    const payer = as('PARENT');
    const secondary = as('PARENT');
    access.set(`${studentId}:${payer['x-user-id']}`, ['primary-parent', true]);
    access.set(`${studentId}:${secondary['x-user-id']}`, ['secondary-parent', false]);
    const res = await http().get(`/billing/students/${studentId}/balance`).set(payer).expect(200);
    expect(res.body).toMatchObject({ studentId, outstanding: 250_000 });
    expect(res.body.invoices).toEqual([
      expect.objectContaining({
        invoiceId: a.invoice.id,
        total: 400_000,
        paid: 150_000,
        outstanding: 250_000,
      }),
    ]);
    await http().get(`/billing/students/${studentId}/balance`).set(tutor).expect(200);
    await http().get(`/billing/students/${studentId}/balance`).set(secondary).expect(404);
    await http().get(`/billing/students/${studentId}/balance`).set(as('TUTOR')).expect(404);
    await http().get(`/billing/students/${randomUUID()}/balance`).set(tutor).expect(404);
  });

  it('revenue: billed by month of service, collected by month received; a Tutor sees only their own', async () => {
    // Two Tutors of their own, so other tests' Students do not show up in the numbers.
    async function tutorWithStudent(fee: number, sessions: string[]) {
      const t = as('TUTOR');
      const cls = randomUUID();
      await deliver('ClassCreated', {
        classId: cls,
        tutorId: t['x-user-id'],
        feeType: 'PER_SESSION',
        feeAmount: fee,
        chargeAbsent: true,
        effectiveFrom: '2026-01',
      });
      const s = await student(t['x-user-id']);
      for (const d of sessions) await attend(s, d, 'PRESENT', cls);
      return { headers: t, actor: { id: t['x-user-id'], role: 'TUTOR' } as AuthUser, studentId: s };
    }
    const mine = await tutorWithStudent(200_000, ['2029-01-05', '2029-01-12']); // 400,000
    const theirs = await tutorWithStudent(300_000, ['2029-01-06']); // 300,000
    await app.get(LifecycleService).closeMonth(vn('2029-02-01T00:01:00'));
    const invoiceOf = (studentId: string) =>
      prisma().invoice.findFirstOrThrow({ where: { studentId, period: '2029-01' } });
    const myInvoice = await invoiceOf(mine.studentId);
    const theirInvoice = await invoiceOf(theirs.studentId);
    const p = await payments().record(
      mine.actor,
      myInvoice.id,
      { amount: 300_000, method: 'CASH' },
      vn('2029-02-03T10:00:00'),
    );
    await payments().reverse(mine.actor, p.payment.id, { reason: 'x' }, vn('2029-03-01T09:00:00'));
    await payments().record(
      mine.actor,
      myInvoice.id,
      { amount: 100_000, method: 'CASH' },
      vn('2029-03-01T10:00:00'),
    );
    await payments().record(
      theirs.actor,
      theirInvoice.id,
      { amount: 300_000, method: 'CASH' },
      vn('2029-02-04T10:00:00'),
    );

    const report = await http()
      .get('/billing/reports/revenue')
      .query({ from: '2029-01', to: '2029-03' })
      .set(mine.headers)
      .expect(200);
    expect(report.body.months).toEqual([
      { period: '2029-01', billed: 400_000, collected: 0 },
      { period: '2029-02', billed: 0, collected: 300_000 },
      { period: '2029-03', billed: 0, collected: -300_000 + 100_000 },
    ]);
    const all = await http()
      .get('/billing/reports/revenue')
      .query({ from: '2029-01', to: '2029-03' })
      .set(as('ADMIN'))
      .expect(200);
    expect(all.body.months[0].billed).toBeGreaterThanOrEqual(700_000);
    expect(all.body.months[1].collected).toBeGreaterThanOrEqual(600_000);
    await http()
      .get('/billing/reports/revenue')
      .query({ from: '2029-03', to: '2029-01' })
      .set(tutor)
      .expect(400);
  });

  it('VietQR payload for what is still owed', async () => {
    const { invoice } = await issued('2029-05');
    await pay(invoice.id, 100_000).expect(201);
    delete process.env.BILLING_BANK_BIN;
    await http().get(`/billing/invoices/${invoice.id}/qr`).set(tutor).expect(503);
    process.env.BILLING_BANK_BIN = '970436';
    process.env.BILLING_BANK_ACCOUNT = '0011001234567';
    process.env.BILLING_BANK_ACCOUNT_NAME = 'NGUYEN VAN GIAO';
    const res = await http().get(`/billing/invoices/${invoice.id}/qr`).set(tutor).expect(200);
    const code = `TMS ${invoice.id.slice(0, 8).toUpperCase()}`;
    expect(res.body).toMatchObject({ amount: 300_000, bankBin: '970436', description: code });
    const payload: string = res.body.payload;
    expect(payload).toContain('0010A000000727');
    expect(payload).toContain('0006970436');
    expect(payload).toContain('01130011001234567');
    expect(payload).toContain('5303704');
    expect(payload).toContain('5406300000');
    expect(payload).toContain('5802VN');
    expect(payload).toContain(`08${String(code.length).padStart(2, '0')}${code}`);
    expect(payload.slice(-8, -4)).toBe('6304');
    expect(payload.slice(-4)).toBe(crc16(payload.slice(0, -4)));
    expect(crc16('123456789')).toBe('29B1'); // CRC-16/CCITT-FALSE check value
    await pay(invoice.id, 300_000).expect(201);
    await http().get(`/billing/invoices/${invoice.id}/qr`).set(tutor).expect(409); // paid
  });

  it('GET /internal/students/{id}/open-invoices lists what is not yet PAID or VOID', async () => {
    const studentId = await student();
    const paid = await issued('2029-07', 1, studentId);
    await pay(paid.invoice.id, 200_000).expect(201);
    const open = await issued('2029-08', 1, studentId);
    await attend(studentId, '2029-09-04'); // a non-empty draft
    const res = await http().get(`/internal/students/${studentId}/open-invoices`).expect(200);
    const draft = await prisma().invoice.findFirstOrThrow({
      where: { studentId, period: '2029-09' },
    });
    expect(res.body).toEqual({ studentId, invoiceIds: [open.invoice.id, draft.id] });
    expect(
      (await http().get(`/internal/students/${randomUUID()}/open-invoices`).expect(200)).body
        .invoiceIds,
    ).toEqual([]);
  });
});
