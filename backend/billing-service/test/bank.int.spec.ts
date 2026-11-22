/**
 * Integration tests for #56 (bank details only with consent, ADR-0006) against a
 * throwaway database. Run: docker compose up -d postgres && pnpm --filter @tms/billing-service test:int
 */
import { randomBytes } from 'node:crypto';
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

  beforeAll(async () => {
    env = await createTestDb('billing_bank_it');
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
