/**
 * Integration tests for #19: monthly close, overdue reminders and void-and-replace, with an
 * injected clock and a fake student-service for the Payer check.
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
import { PrismaService } from '../src/prisma/prisma.service';
import { as, createTestDb, type TestDb } from './support';

/** An instant given as Vietnam local time. */
const vn = (local: string) => new Date(`${local}+07:00`);

describe('Billing: monthly close, overdue and void-and-replace (#19)', () => {
  let env: TestDb;
  let app: INestApplication;
  let fakeStudents: Server;
  const access = new Map<string, [string, boolean]>();

  beforeAll(async () => {
    env = await createTestDb('billing_life_it');
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
  const lifecycle = () => app.get(LifecycleService);
  type Handler = (e: never, tx: never) => Promise<void>;
  function handlerFor(type: EventType): Handler {
    const c = app.get(CopiesService);
    const ch = app.get(ChargesService);
    const en = app.get(EnrollmentsService);
    const map: Partial<Record<EventType, Handler>> = {
      ClassCreated: c.onClass.bind(c) as Handler,
      StudentCreated: c.onStudent.bind(c) as Handler,
      StudentUpdated: c.onStudent.bind(c) as Handler,
      AttendanceRecorded: ((e: { data: EventData<'AttendanceRecorded'> }, tx: never) =>
        ch.reconcile(tx, e.data)) as Handler,
      AttendanceCorrected: ((e: { data: EventData<'AttendanceCorrected'> }, tx: never) =>
        ch.reconcile(tx, { ...e.data, status: e.data.newStatus })) as Handler,
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
      chargeAbsent: false,
      effectiveFrom: '2026-01',
    });
  });
  async function student(name = 'Nguyễn An') {
    const studentId = randomUUID();
    await deliver('StudentCreated', {
      studentId,
      tutorId,
      fullName: name,
      payerContact: { name: 'Lan', email: 'lan@example.com' },
    });
    return studentId;
  }
  const attend = (
    studentId: string,
    date: string,
    status: AttendanceStatus,
    sessionId = randomUUID(),
  ) =>
    deliver('AttendanceRecorded', { sessionId, studentId, classId, date, status }).then(
      () => sessionId,
    );
  const invoicesOf = (studentId: string) =>
    prisma().invoice.findMany({
      where: { studentId },
      include: { items: true },
      orderBy: [{ period: 'asc' }, { createdAt: 'asc' }],
    });
  const events = async (type: string, invoiceId: string) =>
    (
      await env.db.query(
        `SELECT payload->'data' AS data FROM outbox_events WHERE event_type = $1 AND payload->'data'->>'invoiceId' = $2 ORDER BY created_at`,
        [type, invoiceId],
      )
    ).rows.map((r) => r.data);

  it('closes the month at 00:00 on the 1st: DRAFT → ISSUED due the 10th, zero → VOID; re-running is harmless', async () => {
    const paying = await student();
    await attend(paying, '2027-02-03', 'PRESENT');
    await attend(paying, '2027-02-10', 'LATE');
    const excused = await student();
    // Charged, then corrected to EXCUSED before the close: the draft drops to 0.
    const wrong = await attend(excused, '2027-02-03', 'PRESENT');
    await deliver('AttendanceCorrected', {
      sessionId: wrong,
      studentId: excused,
      classId,
      date: '2027-02-03',
      oldStatus: 'PRESENT',
      newStatus: 'EXCUSED',
    });
    await attend(excused, '2027-02-05', 'ABSENT'); // not charged in this Class
    const nothing = await student();
    await attend(nothing, '2027-02-05', 'EXCUSED'); // nothing billed: no invoice at all
    await attend(paying, '2027-03-01', 'PRESENT'); // already March: stays a draft

    const first = await lifecycle().closeMonth(vn('2027-03-01T00:00:30'));
    expect(first).toMatchObject({ period: '2027-02' });
    const [feb, mar] = await invoicesOf(paying);
    expect(feb).toMatchObject({ period: '2027-02', status: 'ISSUED', total: 400_000 });
    expect(feb.dueDate!.toISOString().slice(0, 10)).toBe('2027-03-10');
    expect(feb.issuedAt).toEqual(vn('2027-03-01T00:00:30'));
    expect(mar).toMatchObject({ period: '2027-03', status: 'DRAFT' });
    expect(await events('InvoiceIssued', feb.id)).toEqual([
      {
        invoiceId: feb.id,
        kind: 'MONTHLY',
        studentId: paying,
        period: '2027-02',
        total: 400_000,
        dueDate: '2027-03-10',
      },
    ]);
    const [zero] = await invoicesOf(excused);
    expect(zero).toMatchObject({ status: 'VOID', total: 0 }); // BR-BI-02
    expect(await events('InvoiceIssued', zero.id)).toEqual([]);
    expect(await invoicesOf(nothing)).toEqual([]);

    const again = await lifecycle().closeMonth(vn('2027-03-01T00:05:00'));
    expect(again).toMatchObject({ issued: 0, voided: 0 });
    expect(await events('InvoiceIssued', feb.id)).toHaveLength(1);
    expect((await invoicesOf(paying))[0].updatedAt).toEqual(feb.updatedAt);

    // February is closed: a late February charge for a Student with no February invoice
    // goes to March, it does not open a new February draft.
    const late = await student();
    await attend(late, '2027-02-27', 'PRESENT');
    expect(
      (await invoicesOf(late)).map((i) => [i.period, i.status, i.items[0].servicePeriod]),
    ).toEqual([['2027-03', 'DRAFT', '2027-02']]);
  });

  it('two closes at once (two instances, or overlapping ticks) issue each invoice once', async () => {
    const racers = [await student(), await student(), await student()];
    for (const r of racers) await attend(r, '2028-01-12', 'PRESENT');
    await Promise.all([
      lifecycle().closeMonth(vn('2028-02-01T00:02:00')),
      lifecycle().closeMonth(vn('2028-02-01T00:02:00')),
    ]);
    for (const r of racers) {
      const [jan] = await invoicesOf(r);
      expect(jan).toMatchObject({ period: '2028-01', status: 'ISSUED' });
      expect(await events('InvoiceIssued', jan.id)).toHaveLength(1);
    }
  });

  it('a month with more credit than charges carries the balance forward instead of issuing', async () => {
    const studentId = await student();
    const s = await attend(studentId, '2027-04-28', 'PRESENT');
    await lifecycle().closeMonth(vn('2027-05-01T00:01:00')); // April issued: 200,000
    // Corrected after the close: -200,000 lands on May, which has nothing else.
    await deliver('AttendanceCorrected', {
      sessionId: s,
      studentId,
      classId,
      date: '2027-04-28',
      oldStatus: 'PRESENT',
      newStatus: 'EXCUSED',
    });
    await lifecycle().closeMonth(vn('2027-06-01T00:01:00'));
    const [apr, may, jun] = await invoicesOf(studentId);
    expect(apr).toMatchObject({ status: 'ISSUED', total: 200_000 });
    expect(may).toMatchObject({ status: 'VOID', total: 0 });
    expect(may.items.map((i) => i.amount).sort()).toEqual([-200_000, 200_000]);
    expect(jun).toMatchObject({ period: '2027-06', status: 'DRAFT', total: -200_000 });
    expect(jun.items[0].classId).toBeNull();
    // The credit still counts for that Session: changing it back bills +200,000 once.
    await deliver('AttendanceCorrected', {
      sessionId: s,
      studentId,
      classId,
      date: '2027-04-28',
      oldStatus: 'EXCUSED',
      newStatus: 'PRESENT',
    });
    expect((await invoicesOf(studentId))[2].total).toBe(0);
  });

  it('marks overdue the day after the due date and reminds on +1, +5, +10 once each (both kinds)', async () => {
    const studentId = await student();
    await attend(studentId, '2027-07-05', 'PRESENT');
    await lifecycle().closeMonth(vn('2027-08-01T00:01:00')); // due 2027-08-10
    const [jul] = await invoicesOf(studentId);
    const at = (d: string) => lifecycle().markOverdue(vn(`${d}T08:00:00`));
    const reminders = async () =>
      (await events('InvoiceOverdue', jul.id)).map((e) => e.daysOverdue);
    const status = async () =>
      (await prisma().invoice.findUnique({ where: { id: jul.id } }))!.status;

    await at('2027-08-10');
    expect(await status()).toBe('ISSUED');
    await at('2027-08-11');
    expect(await status()).toBe('OVERDUE');
    expect(await reminders()).toEqual([1]);
    await at('2027-08-11'); // re-run the same day
    await at('2027-08-12');
    expect(await reminders()).toEqual([1]);
    await at('2027-08-15');
    await at('2027-08-20');
    await at('2027-09-30');
    expect(await reminders()).toEqual([1, 5, 10]);

    // Downtime: first run 11 days late sends only the latest reminder, never the older ones.
    const enrolled = await student();
    const monthlyClass = randomUUID();
    await deliver('ClassCreated', {
      classId: monthlyClass,
      tutorId,
      feeType: 'MONTHLY',
      feeAmount: 1_000_000,
      chargeAbsent: true,
      effectiveFrom: '2026-01',
    });
    await deliver(
      'StudentEnrolled',
      {
        enrollmentId: randomUUID(),
        classId: monthlyClass,
        studentId: enrolled,
        studentName: 'An',
        feeType: 'MONTHLY',
        status: 'AWAITING_PAYMENT',
        joinedAt: '2027-07-01',
      },
      vn('2027-07-01T10:00:00'),
    ); // ENROLLMENT invoice due 2027-07-08
    const [enrollmentInvoice] = await invoicesOf(enrolled);
    await at('2027-07-19');
    expect(
      (await events('InvoiceOverdue', enrollmentInvoice.id)).map((e) => e.daysOverdue),
    ).toEqual([10]);
    await at('2027-07-30');
    expect(await events('InvoiceOverdue', enrollmentInvoice.id)).toHaveLength(1);
    expect(
      (await prisma().invoice.findUnique({ where: { id: enrollmentInvoice.id } }))!.status,
    ).toBe('OVERDUE');
  });

  it('void-and-replace: same lines, fresh name, linked, at most one live Monthly invoice per month', async () => {
    const studentId = await student('Tên sai');
    const s1 = await attend(studentId, '2027-09-03', 'PRESENT');
    await attend(studentId, '2027-09-10', 'PRESENT');
    await lifecycle().closeMonth(vn('2027-10-01T00:01:00')); // due 2027-10-10
    const [sep] = await invoicesOf(studentId);
    await deliver('StudentUpdated', {
      studentId,
      tutorId,
      fullName: 'Nguyễn Bình',
      payerContact: { name: 'Hà', phone: '0901234567' },
    });

    await http().post(`/billing/invoices/${sep.id}/void`).set(tutor).send({}).expect(400); // reason required
    await http()
      .post(`/billing/invoices/${sep.id}/void`)
      .set(as('TUTOR'))
      .send({ reason: 'x' })
      .expect(404);
    const res = await lifecycle().voidAndReplace(
      me,
      sep.id,
      { reason: 'Sai tên học sinh' },
      vn('2027-10-08T09:00:00'),
    );
    expect(res.voided).toMatchObject({ id: sep.id, status: 'VOID', total: 400_000 });
    expect(res.replacement).toMatchObject({
      status: 'ISSUED',
      replacesInvoiceId: sep.id,
      period: '2027-09',
      total: 400_000,
      studentName: 'Nguyễn Bình',
      payerContact: { name: 'Hà', phone: '0901234567' },
      dueDate: '2027-10-15', // today + 7 is later than the old due date
    });
    expect(res.replacement.items!.map((i) => i.sessionId).sort()).toEqual(
      sep.items.map((i) => i.sessionId).sort(),
    );
    expect(await events('InvoiceIssued', res.replacement.id)).toEqual([
      expect.objectContaining({ kind: 'MONTHLY', total: 400_000, dueDate: '2027-10-15' }),
    ]);
    const oldItems = await prisma().invoiceItem.findMany({ where: { invoiceId: sep.id } });
    expect(oldItems.every((i) => i.superseded)).toBe(true);
    expect((await prisma().invoice.findUnique({ where: { id: sep.id } }))!.voidReason).toBe(
      'Sai tên học sinh',
    );

    // Only one live invoice for September; voiding the voided one again is refused.
    expect(
      (await invoicesOf(studentId)).filter((i) => i.period === '2027-09' && i.status !== 'VOID'),
    ).toHaveLength(1);
    await http()
      .post(`/billing/invoices/${sep.id}/void`)
      .set(tutor)
      .send({ reason: 'x' })
      .expect(409);
    await expect(
      prisma().invoice.create({
        data: {
          kind: 'MONTHLY',
          studentId,
          tutorId,
          studentName: 'x',
          payerContact: {},
          period: '2027-09',
          status: 'ISSUED',
        },
      }),
    ).rejects.toThrow(); // the database refuses a second live one (BR-BI-04)

    // The copied lines are the ones that count: a later correction credits once, not twice.
    await deliver('AttendanceCorrected', {
      sessionId: s1,
      studentId,
      classId,
      date: '2027-09-03',
      oldStatus: 'PRESENT',
      newStatus: 'EXCUSED',
    });
    const oct = (await invoicesOf(studentId)).find((i) => i.period === '2027-10')!;
    expect(oct.items.map((i) => i.amount)).toEqual([-200_000]);

    // A draft cannot be voided; a partly paid invoice must have its payments reversed first.
    await http()
      .post(`/billing/invoices/${oct.id}/void`)
      .set(tutor)
      .send({ reason: 'x' })
      .expect(409);
    await env.db.query(`UPDATE invoices SET status = 'PARTIALLY_PAID' WHERE id = $1`, [
      res.replacement.id,
    ]);
    await http()
      .post(`/billing/invoices/${res.replacement.id}/void`)
      .set(tutor)
      .send({ reason: 'x' })
      .expect(409);
  });

  it('only the Payer, the Tutor and Admin see an Invoice; a secondary Parent gets 404', async () => {
    const studentId = await student();
    await attend(studentId, '2027-11-03', 'PRESENT');
    await lifecycle().closeMonth(vn('2027-12-01T00:01:00'));
    const [nov] = await invoicesOf(studentId);
    const url = `/billing/invoices/${nov.id}`;
    const payer = as('PARENT');
    const secondary = as('PARENT');
    access.set(`${studentId}:${payer['x-user-id']}`, ['primary-parent', true]);
    access.set(`${studentId}:${secondary['x-user-id']}`, ['secondary-parent', false]);

    const res = await http().get(url).set(payer).expect(200);
    expect(res.body).toMatchObject({
      id: nov.id,
      status: 'ISSUED',
      total: 200_000,
      dueDate: '2027-12-10',
    });
    expect(res.body.items).toHaveLength(1);
    await http().get(url).set(secondary).expect(404);
    await http().get(url).set(as('STUDENT')).expect(404);
    await http().get(url).set(tutor).expect(200);
    await http().get(url).set(as('TUTOR')).expect(404);
    await http().get(url).set(as('ADMIN')).expect(200);

    const list = await http()
      .get('/billing/invoices')
      .query({ period: '2027-11', status: 'ISSUED', kind: 'MONTHLY' })
      .set(tutor)
      .expect(200);
    expect(list.body.map((i: { id: string }) => i.id)).toContain(nov.id);
    expect(
      list.body.every(
        (i: { period: string; status: string }) => i.period === '2027-11' && i.status === 'ISSUED',
      ),
    ).toBe(true);
    const others = await http().get('/billing/invoices').set(as('TUTOR')).expect(200);
    expect(others.body).toEqual([]);
    await http().get('/billing/invoices').set(payer).expect(403);
    await http().get('/billing/invoices').query({ status: 'LOST' }).set(tutor).expect(400);
  });
});
