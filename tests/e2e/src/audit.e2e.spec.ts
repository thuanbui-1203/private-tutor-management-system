/**
 * #58: the audit trail (ADR-0005) and bank details with consent (ADR-0006), against the
 * real stack through the API gateway.
 */
import { randomUUID } from 'node:crypto';
import { anonymous, eventually, newStudent, newTutor, withClaims } from './support';

const POLICY = '2026-11-22';

describe('End-to-end: audit trail and consent (#58)', () => {
  test('1. A Tutor updates a Student: one Access record and its Change record share the correlation id', async () => {
    const { client: admin } = await withClaims('ADMIN');
    const tutor = await newTutor();
    const tutorId = (await tutor.get('/users/me')).body.id as string;
    const student = await newStudent(tutor);

    const correlationId = randomUUID();
    const r = await tutor.request(
      'PATCH',
      `/students/${student.id}`,
      { grade: 9 },
      { 'x-correlation-id': correlationId },
    );
    expect(r.status).toBe(200);

    const access = await eventually(async () => {
      const page = await admin.get(`/audit/access?correlationId=${correlationId}`);
      expect(page.status).toBe(200);
      expect(page.body.items).toHaveLength(1);
      return page.body.items[0];
    });
    expect(access).toMatchObject({
      userId: tutorId,
      role: 'TUTOR',
      method: 'PATCH',
      path: `/students/${student.id}`,
      status: 200,
      service: 'student',
    });

    const changes = await admin.get(`/audit/changes?correlationId=${correlationId}`);
    expect(changes.status).toBe(200);
    expect(changes.body.unavailable).toEqual([]);
    expect(changes.body.records).toHaveLength(1);
    expect(changes.body.records[0]).toMatchObject({
      service: 'student',
      action: 'student.update',
      actorId: tutorId,
      actorRole: 'TUTOR',
      entityId: student.id,
      changes: { grade: { to: 9 } },
    });

    // Only Admins read the audit trail.
    expect((await tutor.get('/audit/access')).status).toBe(403);
  });

  test('2. A request rejected at the gateway (no token) still leaves an Access record', async () => {
    const { client: admin } = await withClaims('ADMIN');
    const correlationId = randomUUID();
    const r = await anonymous('/users/me', { 'x-correlation-id': correlationId });
    expect(r.status).toBe(401);
    const access = await eventually(async () => {
      const page = await admin.get(`/audit/access?correlationId=${correlationId}`);
      expect(page.body.items).toHaveLength(1);
      return page.body.items[0];
    });
    expect(access).toMatchObject({ userId: null, role: null, status: 401, service: null });
  });

  test('3. A Payer stores a bank account with consent: the Admin sees it, an unrelated Tutor does not, withdrawal leaves it masked', async () => {
    const tutor = await newTutor();
    const { client: admin } = await withClaims('ADMIN');
    const { client: payer, userId: payerId } = await withClaims('PARENT');
    const account = {
      bankBin: '970436',
      accountNumber: '0123456789012',
      accountName: 'TRAN THI LAN',
      policyVersion: POLICY,
    };

    expect((await payer.put('/billing/bank-account', account)).status).toBe(400); // no consent
    const saved = await payer.put('/billing/bank-account', { ...account, consent: true });
    expect(saved.status).toBe(200);
    expect(saved.body).toMatchObject({ accountNumberMasked: '••••9012', status: 'ACTIVE' });
    expect(JSON.stringify(saved.body)).not.toContain(account.accountNumber);

    const mine = (list: { ownerId: string }[]) => list.find((a) => a.ownerId === payerId);
    const unrelated = await tutor.get('/billing/bank-accounts');
    expect(unrelated.status).toBe(200);
    expect(mine(unrelated.body)).toBeUndefined();
    const visible = await admin.get('/billing/bank-accounts');
    expect(mine(visible.body)).toMatchObject({
      accountNumber: account.accountNumber,
      status: 'ACTIVE',
    });

    const withdrawn = await payer.delete('/billing/bank-account/consent');
    expect(withdrawn.status).toBe(200);
    expect(withdrawn.body.account).toMatchObject({ status: 'MASKED', accountName: null });

    const after = await admin.get('/billing/bank-accounts');
    expect(mine(after.body)).toMatchObject({
      accountNumber: null,
      accountNumberMasked: '••••9012',
      status: 'MASKED',
    });
  });
});
