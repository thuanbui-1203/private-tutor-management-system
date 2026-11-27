/**
 * Payroll (docs/07 §6) against the real stack: Attendance travels through RabbitMQ to billing,
 * the owner pays one QR, and the money is split between the Tutors.
 */
import {
  anonymous,
  eventually,
  hook,
  newClass,
  newStudent,
  newTutor,
  withClaims,
  type Client,
} from './support';

const GATEWAY = process.env.E2E_GATEWAY ?? 'http://127.0.0.1:28080/api';

/** A Tutor with a bank account who taught `n` Sessions, each attended by `status`. */
async function taught(
  admin: Client,
  rate: number,
  statuses: ('PRESENT' | 'ABSENT')[],
  accountNumber: string,
) {
  const tutor = await newTutor();
  const id = (await tutor.get('/users/me')).body.id as string;
  const student = await newStudent(tutor);
  const cls = await newClass(tutor, 'PER_SESSION', 250_000);
  await eventually(async () => {
    const r = await tutor.post(`/classes/${cls.id}/enrollments`, { studentId: student.id });
    if (r.status !== 201) throw new Error(`enroll: ${r.status}`);
  });
  const account = await tutor.put('/billing/bank-account', {
    bankBin: '970436',
    accountNumber,
    accountName: 'NGUYEN VAN A',
    consent: true,
    policyVersion: '2026-11-22',
  });
  expect(account.status).toBe(200);
  expect((await admin.put(`/billing/payroll/rates/${cls.id}`, { amount: rate })).status).toBe(200);

  let period = '';
  for (const [i, status] of statuses.entries()) {
    const session = await eventually(async () =>
      hook<{ id: string; date: string }>('schedule', 'sessions', {
        classId: cls.id,
        startsAt: new Date(Date.now() - (i + 1) * 60_000).toISOString(),
        minutes: 15,
      }),
    );
    period = session.date.slice(0, 7);
    await eventually(async () => {
      const sheet = await tutor.get(`/sessions/${session.id}/attendance`);
      expect(sheet.body.students).toHaveLength(1);
      const r = await tutor.put(`/sessions/${session.id}/attendance`, {
        records: [{ studentId: student.id, status }],
      });
      expect(r.status).toBe(200);
    });
  }
  await eventually(async () => {
    const work = await tutor.get(`/billing/payroll/work?period=${period}`);
    expect(work.body).toHaveLength(statuses.length);
  });
  return { tutor, id, period };
}

describe('End-to-end: payroll split', () => {
  test('one scanned payment is split between Tutors by valid work; an empty Session is not paid', async () => {
    const { client: admin } = await withClaims('ADMIN');
    const a = await taught(admin, 150_000, ['PRESENT', 'PRESENT'], '11112222');
    const b = await taught(admin, 200_000, ['PRESENT', 'ABSENT'], '33334444');

    // A Tutor cannot run payrolls, and nobody can without signing in.
    expect((await a.tutor.post('/billing/payroll/runs', { period: a.period })).status).toBe(403);
    expect((await anonymous('/billing/payroll/runs')).status).toBe(401);

    const run = await admin.post('/billing/payroll/runs', { period: a.period });
    expect(run.status).toBe(201);
    expect(run.body.total).toBe(2 * 150_000 + 200_000);

    const approved = await admin.post(`/billing/payroll/runs/${run.body.id}/approve`);
    expect(approved.status).toBe(200);
    const token = (approved.body.payUrl as string).split('/').pop()!;

    // The phone that scanned the QR is not signed in.
    const pay = await fetch(`${GATEWAY}/billing/sandbox/payments/${token}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ outcome: 'SUCCESS' }),
    });
    expect(pay.status).toBe(200);

    const done = await admin.get(`/billing/payroll/runs/${run.body.id}`);
    expect(done.body).toMatchObject({ status: 'COMPLETED', received: 500_000 });
    const share = (id: string) =>
      (done.body.payouts as { tutorId: string; amount: number; status: string }[]).find(
        (p) => p.tutorId === id,
      );
    expect(share(a.id)).toMatchObject({ amount: 300_000, status: 'PAID' });
    expect(share(b.id)).toMatchObject({ amount: 200_000, status: 'PAID' });

    const work = await b.tutor.get(`/billing/payroll/work?period=${b.period}`);
    expect(work.body.map((w: { status: string }) => w.status).sort()).toEqual([
      'NOT_PAYABLE',
      'PAID',
    ]);
    // A forged provider notice is refused at the public endpoint.
    const forged = await fetch(`${GATEWAY}/billing/payroll/webhook`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-payroll-signature': 'f'.repeat(64) },
      body: JSON.stringify({
        transactionId: 'X1',
        runId: run.body.id,
        amount: 1,
        timestamp: Math.floor(Date.now() / 1000),
      }),
    });
    expect(forged.status).toBe(401);
  });
});
