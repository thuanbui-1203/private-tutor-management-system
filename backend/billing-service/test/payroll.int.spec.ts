/**
 * Integration tests for the payroll split (docs/07 §6) against a throwaway database.
 * Run: docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomBytes, randomUUID } from 'node:crypto';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import type { AttendanceStatus } from '@tms/contracts';
import { BANK_POLICY_VERSION } from '../src/bank/bank-accounts.service';
import { CopiesService } from '../src/copies/copies.service';
import { PAYROLL_CONFIG, signFunding, type PayrollConfig } from '../src/payroll/payout-provider';
import { PayrollService } from '../src/payroll/payroll.service';
import { WorkService, type Tx } from '../src/payroll/work.service';
import { PrismaService } from '../src/prisma/prisma.service';
import { as, createTestDb, type TestDb } from './support';

const SECRET = randomBytes(32).toString('hex');
/** A month in the past, so its Sessions are locked. */
const PERIOD = '2026-01';

describe('Billing: payroll split (docs/07 §6)', () => {
  let env: TestDb;
  let app: INestApplication;
  const admin = as('ADMIN');

  beforeAll(async () => {
    env = await createTestDb('billing_payroll_it');
    process.env.BANK_DATA_KEY = randomBytes(32).toString('base64');
    process.env.PAYOUT_MODE = 'sandbox';
    process.env.PAYOUT_WEBHOOK_SECRET = SECRET;
    const { AppModule } = await import('../src/app.module');
    app = (
      await Test.createTestingModule({ imports: [AppModule] }).compile()
    ).createNestApplication();
    await app.init();
  });

  afterAll(async () => {
    await app?.close();
    await env?.close();
    delete process.env.PAYOUT_MODE;
    delete process.env.PAYOUT_WEBHOOK_SECRET;
  });

  beforeEach(async () => {
    await env.db.query(
      'TRUNCATE work_items, payouts, payroll_fundings, payroll_runs, pay_rates, session_attendance, fee_policies, session_calendar CASCADE',
    );
  });

  const http = () => request(app.getHttpServer());
  const prisma = () => app.get(PrismaService);
  const inTx = <T>(fn: (tx: Tx) => Promise<T>) => prisma().$transaction(fn);

  let seq = 0;
  const attend = (
    s: { sessionId: string; classId: string; date: string },
    studentId: string,
    status: AttendanceStatus,
    occurredAt = new Date(Date.UTC(2026, 0, 31) + seq++ * 1000).toISOString(),
  ) => inTx((tx) => app.get(WorkService).onAttendance(tx, { ...s, studentId, status, occurredAt }));

  async function tutorWithClass(accountNumber: string | null = '12345678', rate?: number) {
    const who = as('TUTOR');
    const classId = randomUUID();
    await inTx((tx) =>
      app.get(CopiesService).onClass(
        {
          data: {
            classId,
            tutorId: who['x-user-id'],
            feeType: 'PER_SESSION',
            feeAmount: 100_000,
            chargeAbsent: true,
            effectiveFrom: '2025-01',
          },
        } as never,
        tx as never,
      ),
    );
    if (accountNumber) {
      await http()
        .put('/billing/bank-account')
        .set(who)
        .send({
          bankBin: '970436',
          accountNumber,
          accountName: 'NGUYEN VAN A',
          consent: true,
          policyVersion: BANK_POLICY_VERSION,
        })
        .expect(200);
    }
    if (rate) await setRate(classId, rate);
    return { who, id: who['x-user-id'], classId };
  }
  const setRate = (classId: string, amount: number) =>
    http().put(`/billing/payroll/rates/${classId}`).set(admin).send({ amount }).expect(200);

  const session = (classId: string, date = `${PERIOD}-10`) => ({
    sessionId: randomUUID(),
    classId,
    date,
  });
  /** `n` Sessions each attended by one Student. */
  async function taught(classId: string, n: number) {
    const all = [];
    for (let i = 0; i < n; i++) {
      const s = session(classId, `${PERIOD}-${String(10 + i).padStart(2, '0')}`);
      await attend(s, randomUUID(), 'PRESENT');
      all.push(s);
    }
    return all;
  }
  const draft = async () =>
    (await http().post('/billing/payroll/runs').set(admin).send({ period: PERIOD }).expect(201))
      .body;
  const approve = async (id: string) =>
    (await http().post(`/billing/payroll/runs/${id}/approve`).set(admin).expect(200)).body;
  const tokenOf = (payUrl: string) => payUrl.split('/').pop()!;
  const pay = (token: string, outcome: 'SUCCESS' | 'SHORT' | 'FAIL') =>
    http().post(`/billing/sandbox/payments/${token}`).send({ outcome });
  const run = async (id: string) =>
    (await http().get(`/billing/payroll/runs/${id}`).set(admin).expect(200)).body;
  const notice = (runId: string, amount: number, over: object = {}) => ({
    transactionId: `T-${randomUUID()}`,
    runId,
    amount,
    timestamp: Math.floor(Date.now() / 1000),
    ...over,
  });
  const webhook = (n: ReturnType<typeof notice>, signature = signFunding(n, SECRET)) =>
    http().post('/billing/payroll/webhook').set('x-payroll-signature', signature).send(n);

  // ---------------------------------------------------------------- what is valid work

  it('pays a Session when at least one Student came, and nothing when nobody did', async () => {
    const t = await tutorWithClass('12345678', 150_000);
    const some = session(t.classId);
    await attend(some, randomUUID(), 'ABSENT');
    await attend(some, randomUUID(), 'LATE');
    const nobody = session(t.classId);
    await attend(nobody, randomUUID(), 'ABSENT');
    await attend(nobody, randomUUID(), 'EXCUSED');

    const { body } = await http()
      .get(`/billing/payroll/work?period=${PERIOD}`)
      .set(t.who)
      .expect(200);
    const of = (s: { sessionId: string }) =>
      body.find((w: { sessionId: string }) => w.sessionId === s.sessionId);
    expect(of(some)).toMatchObject({ attended: true, amount: 150_000, status: 'ELIGIBLE' });
    expect(of(nobody)).toMatchObject({ attended: false, amount: 0, status: 'NOT_PAYABLE' });
    expect((await draft()).total).toBe(150_000);
  });

  it('counts a Session once, whatever the number of Students or of deliveries', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const s = session(t.classId);
    const student = randomUUID();
    await attend(s, student, 'PRESENT');
    await attend(s, student, 'PRESENT');
    for (let i = 0; i < 4; i++) await attend(s, randomUUID(), 'PRESENT');
    expect((await draft()).total).toBe(100_000);
  });

  it('ignores an older Attendance event that arrives after a newer one', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const s = session(t.classId);
    const student = randomUUID();
    await attend(s, student, 'ABSENT', '2026-01-10T13:00:00.000Z'); // the correction
    await attend(s, student, 'PRESENT', '2026-01-10T12:00:00.000Z'); // the original, late
    const [item] = await prisma().workItem.findMany();
    expect(item).toMatchObject({ attended: false, amount: 0 });
  });

  it('waits for the 48h correction window, for a rate, and skips cancelled Sessions', async () => {
    const t = await tutorWithClass('12345678');
    const today = new Date().toISOString().slice(0, 10);
    await attend(session(t.classId, today), randomUUID(), 'PRESENT');
    const old = session(t.classId);
    await attend(old, randomUUID(), 'PRESENT');
    const preview = async () =>
      (await http().get(`/billing/payroll/preview?period=${PERIOD}`).set(admin).expect(200)).body;
    expect(await preview()).toMatchObject({ total: 0, classesWithoutRate: [t.classId] });

    await setRate(t.classId, 200_000); // the first rate covers what was already taught
    expect(await preview()).toMatchObject({ total: 200_000, classesWithoutRate: [] });

    await env.db.query(
      `INSERT INTO session_calendar (session_id, class_id, date, status, updated_at)
       VALUES ($1, $2, $3, 'CANCELLED', now())`,
      [old.sessionId, t.classId, old.date],
    );
    expect(await preview()).toMatchObject({ total: 0 });
  });

  it('a later rate starts next month and never changes what was taught', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    await taught(t.classId, 2);
    await setRate(t.classId, 900_000);
    expect((await draft()).total).toBe(200_000);
  });

  // ---------------------------------------------------------------- the split

  it('one payment is split exactly between the Tutors by their valid work', async () => {
    const a = await tutorWithClass('11112222', 150_000);
    const b = await tutorWithClass('33334444', 233_333);
    const c = await tutorWithClass('55556666', 99_999);
    await taught(a.classId, 3);
    await taught(b.classId, 1);
    await taught(c.classId, 2);
    const total = 3 * 150_000 + 233_333 + 2 * 99_999;

    const created = await draft();
    expect(created).toMatchObject({ status: 'DRAFT', total });
    const approved = await approve(created.id);
    expect(approved.status).toBe('AWAITING_FUNDS');
    const { body: link } = await http()
      .get(`/billing/sandbox/payments/${tokenOf(approved.payUrl)}`)
      .expect(200);
    expect(link).toEqual({ period: PERIOD, total, received: 0 });

    const { body: paid } = await pay(tokenOf(approved.payUrl), 'SUCCESS').expect(200);
    expect(paid).toEqual({ status: 'PAID', paid: total });

    const done = await run(created.id);
    expect(done).toMatchObject({ status: 'COMPLETED', received: total });
    const share = (id: string) =>
      done.payouts.find((p: { tutorId: string }) => p.tutorId === id) as {
        amount: number;
        status: string;
        accountNumberMasked: string;
      };
    expect(share(a.id)).toMatchObject({
      amount: 450_000,
      status: 'PAID',
      accountNumberMasked: '••••2222',
    });
    expect(share(b.id).amount).toBe(233_333);
    expect(share(c.id).amount).toBe(199_998);
    expect(done.payouts.reduce((sum: number, p: { amount: number }) => sum + p.amount, 0)).toBe(
      total,
    );
    // Every item is paid; nothing is left for another run.
    await http().post('/billing/payroll/runs').set(admin).send({ period: PERIOD }).expect(422);
    const { body: mine } = await http()
      .get(`/billing/payroll/work?period=${PERIOD}`)
      .set(a.who)
      .expect(200);
    expect(mine.map((w: { status: string }) => w.status)).toEqual(['PAID', 'PAID', 'PAID']);
    expect(JSON.stringify(done)).not.toContain('11112222');
  });

  it('a short payment keeps waiting; the rest completes it', async () => {
    const t = await tutorWithClass('12345678', 100_001);
    await taught(t.classId, 1);
    const { id } = await draft();
    const token = tokenOf((await approve(id)).payUrl);
    expect((await pay(token, 'FAIL').expect(200)).body).toEqual({ status: 'FAILED', paid: 0 });
    expect((await pay(token, 'SHORT').expect(200)).body).toEqual({ status: 'SHORT', paid: 50_000 });
    expect(await run(id)).toMatchObject({ status: 'AWAITING_FUNDS', received: 50_000 });
    expect((await run(id)).payouts[0].status).toBe('PENDING'); // nobody is paid early
    await http().post(`/billing/payroll/runs/${id}/cancel`).set(admin).expect(409);
    expect((await pay(token, 'SUCCESS').expect(200)).body.paid).toBe(50_001);
    expect(await run(id)).toMatchObject({ status: 'COMPLETED', received: 100_001 });
    await pay(token, 'SUCCESS').expect(404); // the link is spent
  });

  it('a repeated webhook pays once; a forged, altered or old one is refused', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    await taught(t.classId, 1);
    const { id } = await draft();
    await approve(id);
    const n = notice(id, 100_000);
    await webhook(n, 'f'.repeat(64)).expect(401);
    await webhook(n, '').expect(401);
    await webhook({ ...n, amount: 999 }, signFunding(n, SECRET)).expect(401);
    const old = notice(id, 100_000, { timestamp: Math.floor(Date.now() / 1000) - 600 });
    await webhook(old).expect(401);
    expect((await run(id)).received).toBe(0);

    const send = jest.spyOn(app.get<PayrollConfig>(PAYROLL_CONFIG).provider, 'send');
    const answers = await Promise.all([webhook(n), webhook(n), webhook(n)]);
    expect(answers.map((r) => r.status)).toEqual([200, 200, 200]);
    expect(answers.filter((r) => !r.body.duplicate)).toHaveLength(1);
    expect(send).toHaveBeenCalledTimes(1);
    send.mockRestore();
    expect(await run(id)).toMatchObject({ status: 'COMPLETED', received: 100_000 });
    // The same transaction id for something else is not a duplicate.
    await webhook({ ...n, amount: 5 }).expect(409);
    // Extra money is kept on record and pays nobody twice.
    await webhook(notice(id, 7_000)).expect(200);
    expect(await run(id)).toMatchObject({ status: 'COMPLETED', received: 107_000 });
  });

  it('one refused account does not stop the others, and can be retried once fixed', async () => {
    const good = await tutorWithClass('12345678', 100_000);
    const bad = await tutorWithClass('99990000', 50_000); // the sandbox refuses …0000
    await taught(good.classId, 1);
    await taught(bad.classId, 1);
    const { id } = await draft();
    await pay(tokenOf((await approve(id)).payUrl), 'SUCCESS').expect(200);
    const partial = await run(id);
    const of = (r: typeof partial, tutorId: string) =>
      r.payouts.find((p: { tutorId: string }) => p.tutorId === tutorId);
    expect(partial.status).toBe('PARTIAL');
    expect(of(partial, good.id).status).toBe('PAID');
    expect(of(partial, bad.id)).toMatchObject({ status: 'FAILED', attempts: 1 });

    const retry = (p: { id: string }) =>
      http().post(`/billing/payroll/runs/${id}/payouts/${p.id}/retry`).set(admin);
    await retry(of(partial, good.id)).expect(409); // never pay a paid one again
    await http()
      .put('/billing/bank-account')
      .set(bad.who)
      .send({
        bankBin: '970436',
        accountNumber: '99991234',
        accountName: 'B',
        consent: true,
        policyVersion: BANK_POLICY_VERSION,
      })
      .expect(200);
    const { body: fixed } = await retry(of(partial, bad.id)).expect(200);
    expect(fixed.status).toBe('COMPLETED');
    expect(of(fixed, bad.id)).toMatchObject({ status: 'PAID', attempts: 2 });
  });

  it('an unknown provider outcome is sent again with the same key, never as a second transfer', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    await taught(t.classId, 1);
    const { id } = await draft();
    await approve(id);
    const keys: string[] = [];
    const send = jest
      .spyOn(app.get<PayrollConfig>(PAYROLL_CONFIG).provider, 'send')
      .mockImplementationOnce((r) => {
        keys.push(r.idempotencyKey);
        return Promise.reject(new Error('timeout'));
      })
      .mockImplementation((r) => {
        keys.push(r.idempotencyKey);
        return Promise.resolve({ ok: true, reference: 'R1' });
      });
    await webhook(notice(id, 100_000)).expect(200);
    expect((await run(id)).payouts[0].status).toBe('PROCESSING');
    expect((await run(id)).status).toBe('SETTLING');
    await app.get(PayrollService).resume(new Date()); // too early
    expect(keys).toHaveLength(1);
    await app.get(PayrollService).resume(new Date(Date.now() + 3 * 60_000));
    send.mockRestore();
    expect(keys).toHaveLength(2);
    expect(keys[0]).toBe(keys[1]);
    expect(await run(id)).toMatchObject({ status: 'COMPLETED' });
  });

  it('a Tutor without a consented account is held out of the total and paid in a later run', async () => {
    const ready = await tutorWithClass('12345678', 100_000);
    const missing = await tutorWithClass(null, 70_000);
    await taught(ready.classId, 1);
    await taught(missing.classId, 1);
    const created = await draft();
    expect(created.total).toBe(100_000);
    expect(created.held).toEqual([
      { tutorId: missing.id, amount: 70_000, sessions: 1, reason: 'NO_BANK_ACCOUNT' },
    ]);
    await pay(tokenOf((await approve(created.id)).payUrl), 'SUCCESS').expect(200);
    await http()
      .put('/billing/bank-account')
      .set(missing.who)
      .send({
        bankBin: '970436',
        accountNumber: '44445555',
        accountName: 'C',
        consent: true,
        policyVersion: BANK_POLICY_VERSION,
      })
      .expect(200);
    expect((await draft()).total).toBe(70_000);
  });

  it('Attendance corrected after the run becomes an adjustment in the next one', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const [first] = await taught(t.classId, 2);
    const student = (
      await prisma().sessionAttendance.findFirstOrThrow({ where: { sessionId: first.sessionId } })
    ).studentId;
    const { id } = await draft();
    await pay(tokenOf((await approve(id)).payUrl), 'SUCCESS').expect(200);

    await attend(first, student, 'ABSENT');
    await http().post('/billing/payroll/runs').set(admin).send({ period: PERIOD }).expect(422); // −100k: held
    await attend(session(t.classId, `${PERIOD}-25`), randomUUID(), 'PRESENT');
    await attend(session(t.classId, `${PERIOD}-26`), randomUUID(), 'PRESENT');
    expect((await draft()).total).toBe(100_000); // 200k − 100k
    expect((await run(id)).total).toBe(200_000); // the paid run is untouched
  });

  it('cancelling gives the work back, and only one payroll is open at a time', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const [s] = await taught(t.classId, 2);
    const first = await draft();
    await http().post('/billing/payroll/runs').set(admin).send({ period: PERIOD }).expect(409);
    // Corrected while in the run: an adjustment waits, then is folded back on cancel.
    const student = (
      await prisma().sessionAttendance.findFirstOrThrow({ where: { sessionId: s.sessionId } })
    ).studentId;
    await attend(s, student, 'ABSENT');
    await http().post(`/billing/payroll/runs/${first.id}/cancel`).set(admin).expect(200);
    expect(await prisma().workItem.count({ where: { kind: 'ADJUSTMENT' } })).toBe(0);
    expect((await draft()).total).toBe(100_000);
  });

  it('two Admins creating a payroll at once get one run', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    await taught(t.classId, 1);
    const create = () => http().post('/billing/payroll/runs').set(admin).send({ period: PERIOD });
    const results = await Promise.all([create(), create(), create()]);
    expect(results.map((r) => r.status).sort()).toEqual([201, 409, 409]);
  });

  // ---------------------------------------------------------------- who may do what

  it('only an Admin runs payrolls and sets rates; a Tutor sees only their own work', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const other = await tutorWithClass('87654321', 100_000);
    await taught(t.classId, 1);
    for (const who of [t.who, as('PARENT'), as('STUDENT')]) {
      await http().post('/billing/payroll/runs').set(who).send({ period: PERIOD }).expect(403);
      await http().get('/billing/payroll/runs').set(who).expect(403);
      await http()
        .put(`/billing/payroll/rates/${t.classId}`)
        .set(who)
        .send({ amount: 9_000_000 })
        .expect(403);
    }
    await http().get(`/billing/payroll/work?period=${PERIOD}`).set(as('PARENT')).expect(403);
    const { body } = await http()
      .get(`/billing/payroll/work?period=${PERIOD}&tutorId=${t.id}`)
      .set(other.who)
      .expect(200);
    expect(body).toEqual([]);
  });

  it('a pay link is replaced by a newer one, expires, and cannot be guessed', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    await taught(t.classId, 1);
    const { id } = await draft();
    const first = tokenOf((await approve(id)).payUrl);
    const { body } = await http()
      .post(`/billing/payroll/runs/${id}/pay-link`)
      .set(admin)
      .expect(200);
    await pay(first, 'SUCCESS').expect(404);
    await pay('guess', 'SUCCESS').expect(404);
    await env.db.query(
      `UPDATE payroll_runs SET pay_token_expires_at = now() - interval '1 second'`,
    );
    await pay(tokenOf(body.payUrl), 'SUCCESS').expect(404);
    const stored = await prisma().payrollRun.findUniqueOrThrow({ where: { id } });
    expect(stored.payTokenHash).not.toContain(tokenOf(body.payUrl));
  });

  it('the database refuses to pay a Session twice', async () => {
    const t = await tutorWithClass('12345678', 100_000);
    const [s] = await taught(t.classId, 1);
    const item = await prisma().workItem.findFirstOrThrow({ where: { sessionId: s.sessionId } });
    await expect(prisma().workItem.create({ data: { ...item, id: randomUUID() } })).rejects.toThrow(
      /Unique constraint/,
    );
  });
});
