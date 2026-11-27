/**
 * Integration tests for #56 (bank details only with consent, ADR-0006) against a
 * throwaway database. Run: docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomBytes } from 'node:crypto';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import type { INestApplication } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import request from 'supertest';
import { BANK_POLICY_VERSION } from '../src/bank/bank-accounts.service';
import { as, createTestDb, type TestDb } from './support';

const NUMBER = '0123456789012';

describe('Billing: bank details with consent (#56)', () => {
  let env: TestDb;
  let app: INestApplication;
  const tutor = as('TUTOR');
  const parent = as('PARENT');
  /** Fake student-service: tutorId → the users who pay for that Tutor's Students. */
  const payers = new Map<string, string[]>();
  let studentsUp = true;
  let fakeStudents: Server;

  beforeAll(async () => {
    env = await createTestDb('billing_bank_it');
    fakeStudents = createServer((req, res) => {
      const tutorId = req.url!.match(/^\/internal\/tutors\/([^/]+)\/payers$/)?.[1];
      if (!studentsUp || !tutorId) return void res.writeHead(studentsUp ? 404 : 503).end();
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ tutorId, userIds: payers.get(tutorId) ?? [] }));
    });
    await new Promise<void>((r) => fakeStudents.listen(0, '127.0.0.1', r));
    process.env.STUDENT_SERVICE_URL = `http://127.0.0.1:${(fakeStudents.address() as AddressInfo).port}`;
    process.env.BANK_DATA_KEY = randomBytes(32).toString('base64');
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
  const body = (over: object = {}) => ({
    bankBin: '970436',
    accountNumber: NUMBER,
    accountName: 'TRAN THI LAN',
    consent: true,
    policyVersion: BANK_POLICY_VERSION,
    ...over,
  });
  const rowsOf = async (userId: string) => ({
    accounts: (await env.db.query('SELECT * FROM bank_accounts WHERE owner_id = $1', [userId]))
      .rows,
    consents: (await env.db.query('SELECT * FROM consents WHERE user_id = $1', [userId])).rows,
    audit: (
      await env.db.query(
        'SELECT action, changes FROM audit_log WHERE actor_id = $1 ORDER BY occurred_at',
        [userId],
      )
    ).rows,
  });

  it('stores nothing without explicit consent to the current policy', async () => {
    const who = as('PARENT');
    const withoutConsent: Record<string, unknown> = body();
    delete withoutConsent.consent;
    await http().put('/billing/bank-account').set(who).send(withoutConsent).expect(400);
    await http()
      .put('/billing/bank-account')
      .set(who)
      .send(body({ consent: false }))
      .expect(400);
    await http()
      .put('/billing/bank-account')
      .set(who)
      .send(body({ policyVersion: '2000-01-01' }))
      .expect(400);
    const rows = await rowsOf(who['x-user-id']);
    expect(rows.accounts).toHaveLength(0);
    expect(rows.consents).toHaveLength(0);
    expect(rows.audit).toHaveLength(0);
    const { body: mine } = await http().get('/billing/bank-account').set(who).expect(200);
    expect(mine).toEqual({ policyVersion: BANK_POLICY_VERSION, account: null });
  });

  it('with consent: ciphertext in the database, masked to the owner, never in a Change record', async () => {
    const { body: saved } = await http()
      .put('/billing/bank-account')
      .set(tutor)
      .send(body())
      .expect(200);
    expect(saved).toMatchObject({
      bankBin: '970436',
      accountNumberMasked: '••••9012',
      status: 'ACTIVE',
      consent: { policyVersion: BANK_POLICY_VERSION, withdrawnAt: null },
    });
    expect(JSON.stringify(saved)).not.toContain(NUMBER);

    const rows = await rowsOf(tutor['x-user-id']);
    expect(rows.accounts[0]).toMatchObject({ owner_role: 'TUTOR', account_last4: '9012' });
    expect(rows.accounts[0].account_number_enc).toMatch(/^v1\./);
    expect(JSON.stringify(rows)).not.toContain(NUMBER);
    expect(rows.audit.map((r) => r.action)).toEqual(['consent.grant', 'bank-account.save']);
    expect(rows.audit[1].changes).toMatchObject({
      accountNumber: { to: '••••9012' },
      accountName: { to: '[personal]' },
    });

    // Saving again reuses the active consent.
    await http()
      .put('/billing/bank-account')
      .set(tutor)
      .send(body({ accountNumber: '99887766' }))
      .expect(200);
    expect((await rowsOf(tutor['x-user-id'])).consents).toHaveLength(1);
  });

  it('Tutors see the full number of a Payer only while consent is active; withdrawal masks and erases', async () => {
    const ownerId = parent['x-user-id'];
    const find = (list: { ownerId: string }[]) => list.find((a) => a.ownerId === ownerId);
    payers.set(tutor['x-user-id'], [ownerId]);
    await http().put('/billing/bank-account').set(parent).send(body()).expect(200);
    await http().get('/billing/bank-accounts').set(parent).expect(403);
    const before = await http().get('/billing/bank-accounts').set(tutor).expect(200);
    expect(find(before.body)).toMatchObject({
      ownerRole: 'PARENT',
      accountNumber: NUMBER,
      accountName: 'TRAN THI LAN',
      status: 'ACTIVE',
    });
    // Receiving accounts of Tutors are not in the Payer list.
    expect(before.body.map((a: { ownerId: string }) => a.ownerId)).not.toContain(
      tutor['x-user-id'],
    );

    const { body: withdrawn } = await http()
      .delete('/billing/bank-account/consent')
      .set(parent)
      .expect(200);
    expect(withdrawn.account).toMatchObject({
      status: 'MASKED',
      accountNumberMasked: '••••9012',
      accountName: null,
    });
    expect(withdrawn.account.consent.withdrawnAt).not.toBeNull();

    const rows = await rowsOf(ownerId);
    expect(rows.accounts[0]).toMatchObject({
      account_number_enc: null,
      account_name: null,
      account_last4: '9012',
      bank_bin: '970436',
    });
    expect(rows.accounts[0].masked_at).not.toBeNull();
    expect(rows.consents[0].withdrawn_at).not.toBeNull(); // kept as evidence
    expect(rows.audit.map((r) => r.action)).toEqual([
      'consent.grant',
      'bank-account.save',
      'consent.withdraw',
      'bank-account.mask',
    ]);

    const after = await http().get('/billing/bank-accounts').set(tutor).expect(200);
    expect(find(after.body)).toMatchObject({
      accountNumber: null,
      accountNumberMasked: '••••9012',
      status: 'MASKED',
    });
    await http().delete('/billing/bank-account/consent').set(parent).expect(404);
  });

  it('a Tutor sees only the Payers of their own Students; an Admin sees all; unverifiable → 503', async () => {
    const payer = as('PARENT');
    const stranger = as('TUTOR');
    const ids = async (who: ReturnType<typeof as>) => {
      const { body: list } = await http().get('/billing/bank-accounts').set(who).expect(200);
      return list.map((a: { ownerId: string }) => a.ownerId);
    };
    await http().put('/billing/bank-account').set(payer).send(body()).expect(200);
    // A Tutor who just signed up teaches nobody, so they see nobody's account.
    expect(await ids(stranger)).toEqual([]);
    payers.set(stranger['x-user-id'], [payer['x-user-id']]);
    expect(await ids(stranger)).toEqual([payer['x-user-id']]);
    expect(await ids(as('ADMIN'))).toContain(payer['x-user-id']);

    studentsUp = false;
    try {
      const res = await http().get('/billing/bank-accounts').set(stranger).expect(503);
      expect(JSON.stringify(res.body)).not.toContain(NUMBER);
    } finally {
      studentsUp = true;
    }
  });

  it('only banks that take NAPAS transfers, from the list the picker shows', async () => {
    const { body: banks } = await http().get('/billing/banks').set(parent).expect(200);
    expect(banks).toContainEqual(
      expect.objectContaining({ bin: '970436', shortName: 'Vietcombank' }),
    );
    expect(banks.length).toBeGreaterThan(40);
    await http()
      .put('/billing/bank-account')
      .set(as('PARENT'))
      .send(body({ bankBin: '123456' }))
      .expect(400);
  });

  it('the database refuses a plain number, or a number left behind after masking', async () => {
    const owner = as('PARENT');
    const id = owner['x-user-id'];
    await http().put('/billing/bank-account').set(owner).send(body()).expect(200);
    await expect(
      env.db.query('UPDATE bank_accounts SET account_number_enc = $2 WHERE owner_id = $1', [
        id,
        NUMBER,
      ]),
    ).rejects.toThrow(/bank_accounts_ciphertext_only/);
    await expect(
      env.db.query('UPDATE bank_accounts SET masked_at = now() WHERE owner_id = $1', [id]),
    ).rejects.toThrow(/bank_accounts_masked_xor_number/);
  });
});
