/**
 * Paying Tutors (docs/07 §6): the Admin's payroll screen, the simulated bank page the owner's
 * phone opens, and the Tutor's own work.
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type Role, type TestUser } from './support';

const RUN = '33333333-3333-4333-8333-333333333333';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const T1 = '11111111-1111-4111-8111-111111111111';
const T2 = '12121212-1212-4212-8212-121212121212';
const TOKEN = 'abc-DEF_123';

const users: Partial<Record<Role, TestUser>> = {};
async function as(role: Role, page: Page, stubs: Parameters<typeof stubApi>[1]) {
  users[role] ??= await createUser(role);
  const user = users[role]!;
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(user) }, ...stubs });
  await signIn(page, user);
  return api;
}
const main = (page: Page) => page.getByRole('main');

const tutor = (id: string, email: string) => ({
  id,
  email,
  role: 'TUTOR',
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
});
const payout = (tutorId: string, amount: number, over: object = {}) => ({
  id: `p-${tutorId.slice(0, 2)}`,
  runId: RUN,
  tutorId,
  amount,
  status: 'PENDING',
  attempts: 0,
  bankBin: null,
  accountNumberMasked: null,
  providerRef: null,
  failureReason: null,
  paidAt: null,
  ...over,
});
const run = (over: object = {}) => ({
  id: RUN,
  period: '2026-10',
  status: 'DRAFT',
  total: 500_000,
  received: 0,
  approvedAt: null,
  fundedAt: null,
  completedAt: null,
  createdAt: '2026-11-03T02:00:00.000Z',
  payouts: [payout(T1, 300_000), payout(T2, 200_000)],
  ...over,
});
const cls = {
  id: CLASS_ID,
  tutorId: T1,
  name: 'Toán 9',
  subject: 'Toán',
  type: 'GROUP',
  maxStudents: 6,
  feeType: 'PER_SESSION',
  feeAmount: 250_000,
  chargeAbsent: true,
  feeEffectiveFrom: '2026-11',
  status: 'OPEN',
};
const base = {
  'GET /users': { body: [tutor(T1, 'an@example.com'), tutor(T2, 'binh@example.com')] },
  'GET /classes': { body: [cls] },
  'GET /billing/payroll/rates': { body: [] },
  'GET /billing/payroll/preview': {
    body: {
      period: '2026-10',
      total: 500_000,
      tutors: [
        { tutorId: T1, amount: 300_000, sessions: 2 },
        { tutorId: T2, amount: 200_000, sessions: 1 },
      ],
      held: [],
      classesWithoutRate: [],
      canPay: true,
    },
  },
};

test('Admin sets a rate, creates a run, approves it and follows the split until everyone is paid', async ({
  page,
}) => {
  let state = run();
  let created = false;
  const api = await as('ADMIN', page, {
    ...base,
    'PUT /billing/payroll/rates/:id': {
      body: { classId: CLASS_ID, effectiveFrom: '2000-01', amount: 150_000 },
    },
    'GET /billing/payroll/runs': () => ({ body: created ? [state] : [] }),
    'POST /billing/payroll/runs': () => {
      created = true;
      return { status: 201, body: { ...state, held: [] } };
    },
    'GET /billing/payroll/runs/:id': () => ({ body: state }),
    'POST /billing/payroll/runs/:id/approve': () => {
      state = run({ status: 'AWAITING_FUNDS' });
      return { body: { ...state, payUrl: `http://localhost:5174/sandbox/pay/${TOKEN}` } };
    },
  });
  await page.getByRole('link', { name: 'Trả công' }).click();

  await main(page).getByLabel('Lớp', { exact: true }).selectOption(CLASS_ID);
  await main(page).getByLabel('Tiền công mỗi buổi').fill('150000');
  await main(page).getByRole('button', { name: 'Lưu mức công' }).click();
  await expect(main(page).getByText('Đã lưu, áp dụng ngay.')).toBeVisible();
  expect(api.find('PUT', `/billing/payroll/rates/${CLASS_ID}`)[0].body).toEqual({
    amount: 150_000,
  });

  await expect(main(page).getByRole('row', { name: /an@example.com/ })).toContainText('300.000');
  await expect(main(page).getByTestId('preview-total')).toContainText('500.000');
  await main(page).getByRole('button', { name: 'Tạo kỳ chi trả' }).click();

  const detail = main(page).getByRole('region', { name: 'Chi tiết kỳ chi trả' });
  await detail.getByRole('button', { name: 'Duyệt và hiện mã thanh toán' }).click();
  await expect(detail.getByRole('img', { name: 'Mã thanh toán' }).locator('svg')).toBeVisible();
  await expect(detail).toContainText('quét mã không chuyển tiền thật');

  // The owner pays on the phone: this screen notices on its own.
  const paid = { status: 'PAID', accountNumberMasked: '••••2222' };
  state = run({
    status: 'COMPLETED',
    received: 500_000,
    payouts: [payout(T1, 300_000, paid), payout(T2, 200_000, paid)],
  });
  await expect(detail.getByText('Đã trả đủ')).toBeVisible({ timeout: 10_000 });
  await expect(detail.getByText('Đã nhận', { exact: true })).toHaveCount(2);
  await expect(detail.getByRole('img', { name: 'Mã thanh toán' })).toHaveCount(0);
  expect(api.unmatched).toEqual([]);
});

test('a failed payout shows its reason and can be sent again', async ({ page }) => {
  let state = run({
    status: 'PARTIAL',
    received: 500_000,
    payouts: [
      payout(T1, 300_000, { status: 'PAID' }),
      payout(T2, 200_000, { status: 'FAILED', failureReason: 'tài khoản bị từ chối' }),
    ],
  });
  const api = await as('ADMIN', page, {
    ...base,
    'GET /billing/payroll/runs': () => ({ body: [state] }),
    'GET /billing/payroll/runs/:id': () => ({ body: state }),
    'POST /billing/payroll/runs/:id/payouts/:pid/retry': () => {
      state = run({
        status: 'COMPLETED',
        received: 500_000,
        payouts: [payout(T1, 300_000, { status: 'PAID' }), payout(T2, 200_000, { status: 'PAID' })],
      });
      return { body: state };
    },
  });
  await page.getByRole('link', { name: 'Trả công' }).click();
  await main(page).getByRole('button', { name: 'Chi tiết' }).click();
  const detail = main(page).getByRole('region', { name: 'Chi tiết kỳ chi trả' });
  await expect(detail.getByRole('row', { name: /binh@example.com/ })).toContainText(
    'tài khoản bị từ chối',
  );
  await detail.getByRole('button', { name: 'Chuyển lại' }).click();
  await expect(detail.getByText('Đã trả đủ')).toBeVisible();
  expect(api.find('POST', `/billing/payroll/runs/${RUN}/payouts/p-12/retry`)).toHaveLength(1);
});

test('the simulated bank page works without signing in and sends no ID token', async ({ page }) => {
  let received = 0;
  const api = await stubApi(page, {
    'GET /billing/sandbox/payments/:token': () => ({
      body: { period: '2026-10', total: 500_000, received },
    }),
    'POST /billing/sandbox/payments/:token': ({ body }) => {
      const { outcome } = body as { outcome: string };
      if (outcome === 'SHORT') {
        received = 250_000;
        return { body: { status: 'SHORT', paid: 250_000 } };
      }
      return { body: { status: 'PAID', paid: 250_000 } };
    },
  });
  await page.goto(`/sandbox/pay/${TOKEN}`);
  await expect(main(page).getByText('Không có tiền thật nào được chuyển.')).toBeVisible();
  await expect(main(page)).toContainText('500.000');
  await main(page).getByRole('button', { name: 'Giả lập chuyển thiếu một nửa' }).click();
  await expect(main(page)).toContainText('Đã chuyển thiếu');
  await expect(main(page)).toContainText('đã nhận 250.000');
  await main(page).getByRole('button', { name: 'Thanh toán', exact: true }).click();
  await expect(main(page)).toContainText('Đã thanh toán');
  await expect(main(page).getByRole('button', { name: 'Thanh toán', exact: true })).toHaveCount(0);
  expect(api.calls.every((c) => c.authorization === undefined)).toBe(true);
});

test('an expired pay link says so', async ({ page }) => {
  await stubApi(page, {
    'GET /billing/sandbox/payments/:token': { status: 404, body: { message: 'expired' } },
  });
  await page.goto(`/sandbox/pay/${TOKEN}`);
  await expect(main(page).getByRole('alert')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Thanh toán', exact: true })).toHaveCount(0);
});

test('a Tutor sees what each Session is worth and why one is not paid', async ({ page }) => {
  const item = (id: string, over: object) => ({
    id,
    kind: 'WORK',
    sessionId: id,
    classId: CLASS_ID,
    tutorId: T1,
    date: '2026-11-10',
    attended: true,
    amount: 150_000,
    status: 'PAID',
    ...over,
  });
  await as('TUTOR', page, {
    'GET /classes': { body: [cls] },
    'GET /billing/payroll/work': {
      body: [
        item('w1', {}),
        item('w2', {
          date: '2026-11-12',
          attended: false,
          amount: 0,
          status: 'NOT_PAYABLE',
        }),
        item('w3', { date: '2026-11-25', status: 'WAITING_LOCK' }),
      ],
    },
    'GET /billing/payroll/payouts': {
      body: [
        {
          ...payout(T1, 150_000, {
            status: 'PAID',
            accountNumberMasked: '••••2222',
            paidAt: '2026-11-20T03:00:00.000Z',
          }),
          period: '2026-11',
        },
      ],
    },
  });
  await page.getByRole('link', { name: 'Công dạy' }).click();
  await expect(main(page).getByRole('row', { name: /12\/11\/2026/ })).toContainText(
    'Không tính công',
  );
  await expect(main(page).getByRole('row', { name: /25\/11\/2026/ })).toContainText(
    'Chờ hết hạn sửa điểm danh',
  );
  await expect(main(page).getByText('Tổng tháng:')).toContainText('300.000');
  await expect(main(page).getByRole('row', { name: /••••2222/ })).toContainText('Đã nhận');
});
