/**
 * Bank details with consent (ADR-0006) and the Admin audit trail (ADR-0005), #57.
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type Role, type TestUser } from './support';

const POLICY = '2026-11-22';
const AN = '11111111-1111-4111-8111-111111111111';
const CORR = '99999999-9999-4999-8999-999999999999';

const users: Partial<Record<Role, TestUser>> = {};
async function as(role: Role, page: Page, stubs: Parameters<typeof stubApi>[1]) {
  users[role] ??= await createUser(role);
  const user = users[role]!;
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(user) }, ...stubs });
  await signIn(page, user);
  return api;
}
const main = (page: Page) => page.getByRole('main');

const account = (over: object = {}) => ({
  bankBin: '970436',
  accountNumberMasked: '••••9012',
  accountName: 'TRAN THI LAN',
  status: 'ACTIVE',
  maskedAt: null,
  consent: { policyVersion: POLICY, grantedAt: '2026-11-22T03:00:00.000Z', withdrawnAt: null },
  ...over,
});
const masked = account({
  status: 'MASKED',
  accountName: null,
  maskedAt: '2026-11-22T05:00:00.000Z',
  consent: {
    policyVersion: POLICY,
    grantedAt: '2026-11-22T03:00:00.000Z',
    withdrawnAt: '2026-11-22T05:00:00.000Z',
  },
});

test('a Tutor cannot save bank details without ticking consent; with it the body carries the consent', async ({
  page,
}) => {
  let saved = false;
  const api = await as('TUTOR', page, {
    'GET /billing/bank-account': () => ({
      body: { policyVersion: POLICY, account: saved ? account() : null },
    }),
    'PUT /billing/bank-account': () => {
      saved = true;
      return { body: account() };
    },
  });
  await page.goto('/tutor/bank-account');
  await expect(main(page).getByText('Chưa lưu tài khoản ngân hàng nào.')).toBeVisible();
  await expect(main(page).getByTestId('consent-text')).toContainText(
    `Phiên bản điều khoản: ${POLICY}`,
  );

  await page.getByLabel('Mã ngân hàng (BIN)').fill('970436');
  await page.getByLabel('Số tài khoản').fill('0123 4567 89012');
  await page.getByLabel('Tên chủ tài khoản').fill('TRAN THI LAN');
  const save = page.getByRole('button', { name: 'Lưu tài khoản' });
  await expect(save).toBeDisabled();
  const consent = page.getByRole('checkbox', { name: /đồng ý cho lưu thông tin ngân hàng/ });
  await expect(consent).not.toBeChecked();
  await consent.check();
  await save.click();

  await expect(main(page).getByRole('status')).toContainText('Đã lưu tài khoản ngân hàng.');
  await expect(main(page).getByTestId('masked-number')).toHaveText('••••9012');
  const [put] = api.find('PUT', '/billing/bank-account');
  expect(put.body).toEqual({
    bankBin: '970436',
    accountNumber: '0123456789012',
    accountName: 'TRAN THI LAN',
    consent: true,
    policyVersion: POLICY,
  });
  // The full number is never shown back after saving.
  await expect(main(page)).not.toContainText('0123456789012');
});

test('the paying Parent withdraws consent after confirming and then only sees the masked number', async ({
  page,
}) => {
  let withdrawn = false;
  const api = await as('PARENT', page, {
    'GET /parents/me/children': {
      body: [
        {
          id: AN,
          tutorId: 't',
          fullName: 'Nguyễn An',
          email: null,
          dob: '2012-05-04',
          school: null,
          grade: 8,
          status: 'ACTIVE',
          parents: [{ id: 'p1', fullName: 'Trần Lan', isPrimary: true }],
          payer: 'PRIMARY_PARENT',
          payerContact: { name: 'Trần Lan', email: 'lan@example.com' },
        },
      ],
    },
    'GET /students/:id/classes': { body: [] },
    'GET /sessions': { body: [] },
    'GET /billing/bank-account': () => ({
      body: { policyVersion: POLICY, account: withdrawn ? masked : account() },
    }),
    'DELETE /billing/bank-account/consent': () => {
      withdrawn = true;
      return { body: { policyVersion: POLICY, account: masked } };
    },
  });
  await expect(page.getByRole('link', { name: 'Tài khoản ngân hàng' })).toBeVisible();
  await page.getByRole('link', { name: 'Tài khoản ngân hàng' }).click();
  await expect(main(page).getByText('Đang dùng (đã đồng ý)')).toBeVisible();
  await expect(main(page).getByTestId('consent-text')).toContainText('hoàn tiền');

  await main(page).getByRole('button', { name: 'Rút lại đồng ý' }).click();
  await expect(page.getByRole('dialog')).toContainText('bị xóa ngay');
  await page.getByRole('dialog').getByRole('button', { name: 'Không' }).click();
  expect(api.find('DELETE', '/billing/bank-account/consent')).toHaveLength(0);

  await main(page).getByRole('button', { name: 'Rút lại đồng ý' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Rút đồng ý' }).click();
  await expect(main(page).getByText('Đã rút đồng ý, chỉ còn bản đã che')).toBeVisible();
  await expect(main(page).getByTestId('masked-number')).toHaveText('••••9012');
  await expect(main(page).getByText('TRAN THI LAN')).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: 'Rút lại đồng ý' })).toHaveCount(0);
  expect(api.find('DELETE', '/billing/bank-account/consent')).toHaveLength(1);
});

test('a Tutor sees Payer accounts: full while consented, masked after withdrawal', async ({
  page,
}) => {
  await as('TUTOR', page, {
    'GET /billing/bank-accounts': {
      body: [
        { ...account(), ownerId: 'o1', ownerRole: 'PARENT', accountNumber: '0123456789012' },
        {
          ...masked,
          ownerId: 'o2',
          ownerRole: 'STUDENT',
          accountNumber: null,
          accountNumberMasked: '••••3333',
        },
      ],
    },
  });
  await page.getByRole('link', { name: 'TK phụ huynh' }).click();
  await expect(main(page).getByRole('row', { name: /TRAN THI LAN/ })).toContainText(
    '0123456789012',
  );
  await expect(main(page).getByRole('row', { name: /••••3333/ })).toContainText('Đã rút đồng ý');
});

test('Admin filters the access log, pages through it and opens the changes of one request', async ({
  page,
}) => {
  const record = (n: number, over: object = {}) => ({
    id: `00000000-0000-4000-8000-00000000000${n}`,
    occurredAt: `2026-11-22T0${n}:00:00.000Z`,
    correlationId: n === 1 ? CORR : `00000000-0000-4000-8000-0000000000a${n}`,
    userId: '44444444-4444-4444-8444-444444444444',
    role: 'TUTOR',
    ip: '10.0.0.7',
    userAgent: 'Chrome',
    method: 'PATCH',
    path: `/students/${AN}`,
    queryKeys: [],
    status: 200,
    durationMs: 41.2,
    service: 'student',
    ...over,
  });
  const api = await as('ADMIN', page, {
    'GET /users': { body: [] },
    'GET /audit/access': (req) =>
      req.query.get('cursor')
        ? { body: { items: [record(2, { method: 'GET', path: '/classes' })], nextCursor: null } }
        : { body: { items: [record(1)], nextCursor: 'next-1' } },
    'GET /audit/changes': {
      body: {
        records: [
          {
            id: 'c1',
            occurredAt: '2026-11-22T01:00:00.000Z',
            service: 'student',
            correlationId: CORR,
            actorId: '44444444-4444-4444-8444-444444444444',
            actorRole: 'TUTOR',
            action: 'student.update',
            entityType: 'Student',
            entityId: AN,
            changes: {
              status: { from: 'ACTIVE', to: 'PAUSED' },
              fullName: { from: '[personal]', to: '[personal]' },
            },
          },
        ],
        unavailable: ['billing'],
      },
    },
  });
  await page.getByRole('link', { name: 'Nhật ký' }).click();
  await expect(main(page).getByRole('button', { name: `PATCH /students/${AN}` })).toBeVisible();

  await page.getByLabel('Mã trạng thái').fill('200');
  await page.getByLabel('Method').selectOption('PATCH');
  await page.getByRole('button', { name: 'Lọc' }).click();
  await expect
    .poll(() => api.find('GET', '/audit/access').at(-1)?.query.toString())
    .toContain('status=200');
  expect(api.find('GET', '/audit/access').at(-1)!.query.get('method')).toBe('PATCH');

  await main(page).getByRole('button', { name: 'Tải thêm' }).click();
  await expect(main(page).getByRole('button', { name: 'GET /classes' })).toBeVisible();
  expect(api.find('GET', '/audit/access').at(-1)!.query.get('cursor')).toBe('next-1');
  await expect(main(page).getByRole('button', { name: 'Tải thêm' })).toHaveCount(0);

  await main(page)
    .getByRole('button', { name: `PATCH /students/${AN}` })
    .click();
  const changes = main(page).getByRole('region', { name: 'Thay đổi dữ liệu' });
  await expect(changes).toContainText('student.update');
  await expect(changes.getByRole('row', { name: /status/ })).toContainText('ACTIVE');
  await expect(changes.getByRole('row', { name: /status/ })).toContainText('PAUSED');
  await expect(changes).toContainText('[personal]');
  await expect(changes).toContainText('Chưa đọc được từ: Học phí');
  expect(api.find('GET', '/audit/changes')[0].query.get('correlationId')).toBe(CORR);
});
