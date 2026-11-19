/**
 * Tutor billing screens (#23, "Giáo viên – học phí"): Invoices with Adjustment lines,
 * payments, the overpayment guard, reversals, void-and-replace, VietQR, balance, revenue.
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type TestUser } from './support';

const INVOICE_ID = '77777777-7777-4777-8777-777777777777';
const NEW_INVOICE = '88888888-8888-4888-8888-888888888888';
const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const PAYMENT_ID = '99999999-9999-4999-8999-999999999999';

const invoice = (over: object = {}) => ({
  id: INVOICE_ID,
  kind: 'MONTHLY',
  studentId: STUDENT_ID,
  enrollmentId: null,
  studentName: 'Nguyễn An',
  payerContact: { name: 'Trần Lan', email: 'lan@example.com' },
  period: '2026-12',
  total: 1_300_000,
  status: 'ISSUED',
  issuedAt: '2026-12-31T17:00:00.000Z',
  dueDate: '2027-01-10',
  replacesInvoiceId: null,
  paid: 0,
  outstanding: 1_300_000,
  payments: [],
  items: [
    {
      id: 'i1',
      type: 'FEE',
      classId: 'c',
      sessionId: 's1',
      enrollmentId: null,
      adjustsItemId: null,
      servicePeriod: '2026-12',
      attendanceStatus: 'PRESENT',
      description: 'Buổi 03/12/2026 (Có mặt)',
      amount: 1_500_000,
    },
    {
      id: 'i2',
      type: 'ADJUSTMENT',
      classId: 'c',
      sessionId: 's0',
      enrollmentId: null,
      adjustsItemId: 'old',
      servicePeriod: '2026-11',
      attendanceStatus: 'EXCUSED',
      description: 'Điều chỉnh điểm danh buổi 30/11/2026: Vắng có phép',
      amount: -200_000,
    },
  ],
  ...over,
});

let tutor: TestUser;
test.beforeAll(async () => {
  tutor = await createUser('TUTOR');
});
async function asTutor(page: Page, stubs: Parameters<typeof stubApi>[1]) {
  const api = await stubApi(page, {
    'GET /users/me': { body: meOf(tutor) },
    'GET /billing/invoices/:id/qr': { status: 503, body: { message: 'not configured' } },
    ...stubs,
  });
  await signIn(page, tutor);
  await expect(page).toHaveURL(/\/tutor$/);
  return api;
}
const main = (page: Page) => page.getByRole('main');

test('invoice list filters by period, status and kind', async ({ page }) => {
  const api = await asTutor(page, { 'GET /billing/invoices': { body: [invoice()] } });
  await page.getByRole('link', { name: 'Hóa đơn' }).click();
  await expect(main(page).getByRole('cell', { name: '1.300.000 ₫' })).toBeVisible();
  await expect(main(page).getByRole('cell', { name: '10/01/2027' })).toBeVisible();
  await page.getByLabel('Kỳ').fill('2026-12');
  await page.getByLabel('Trạng thái').selectOption('OVERDUE');
  await page.getByLabel('Loại hóa đơn').selectOption('ENROLLMENT');
  await expect
    .poll(() => {
      const q = api.find('GET', '/billing/invoices').at(-1)!.query;
      return [q.get('period'), q.get('status'), q.get('kind')];
    })
    .toEqual(['2026-12', 'OVERDUE', 'ENROLLMENT']);
});

test('invoice detail: Adjustment lines say what they correct; totals in VND', async ({ page }) => {
  await asTutor(page, { 'GET /billing/invoices/:id': { body: invoice() } });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  await expect(
    main(page).getByRole('heading', { name: /Hóa đơn tháng kỳ 12\/2026/ }),
  ).toBeVisible();
  await expect(
    main(page).getByText(
      'Dòng điều chỉnh cho một buổi học của kỳ 11/2026 (hóa đơn đã phát hành không bị sửa)',
    ),
  ).toBeVisible();
  await expect(main(page).getByRole('cell', { name: '-200.000 ₫' })).toBeVisible();
  await expect(main(page).getByRole('row', { name: /Còn phải trả/ })).toContainText('1.300.000 ₫');
});

test('recording a payment: more than what is owed is blocked; a partial then a full payment', async ({
  page,
}) => {
  let paid = 0;
  const api = await asTutor(page, {
    'GET /billing/invoices/:id': () => ({
      body: invoice({
        paid,
        outstanding: 1_300_000 - paid,
        status: paid === 0 ? 'ISSUED' : paid < 1_300_000 ? 'PARTIALLY_PAID' : 'PAID',
        payments: paid
          ? [
              {
                id: PAYMENT_ID,
                kind: 'PAYMENT',
                reversesPaymentId: null,
                amount: paid,
                method: 'CASH',
                paidAt: '2027-01-03T03:00:00.000Z',
                note: null,
              },
            ]
          : [],
      }),
    }),
    'POST /billing/invoices/:id/payments': (req) => {
      paid += (req.body as { amount: number }).amount;
      return {
        status: 201,
        body: { invoiceStatus: paid >= 1_300_000 ? 'PAID' : 'PARTIALLY_PAID' },
      };
    },
  });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  const form = page.getByRole('form', { name: 'Ghi nhận thanh toán' });
  await form.getByLabel('Số tiền (VND)').fill('1300001');
  await form.getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Số tiền vượt số còn nợ (1.300.000 ₫) (BR-BI-07).',
  );
  expect(api.find('POST', `/billing/invoices/${INVOICE_ID}/payments`)).toEqual([]);

  await form.getByLabel('Số tiền (VND)').fill('500000');
  await form.getByLabel('Hình thức').selectOption('CASH');
  await form.getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(main(page).getByText('Đã ghi nhận thanh toán một phần.')).toBeVisible();
  await expect(main(page).getByText('Trả một phần')).toBeVisible();
  expect(api.find('POST', `/billing/invoices/${INVOICE_ID}/payments`)[0].body).toEqual({
    amount: 500000,
    method: 'CASH',
  });
  await expect(form.getByLabel('Số tiền (VND)')).toHaveValue('800000'); // pre-filled with what is left

  await form.getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(
    main(page).getByText('Đã ghi nhận thanh toán. Hóa đơn đã được thanh toán đủ.'),
  ).toBeVisible();
  await expect(page.getByRole('form', { name: 'Ghi nhận thanh toán' })).toHaveCount(0);
});

test("the API's own overpayment refusal (someone paid meanwhile) is explained", async ({
  page,
}) => {
  await asTutor(page, {
    'GET /billing/invoices/:id': { body: invoice() },
    'POST /billing/invoices/:id/payments': {
      status: 422,
      body: { message: 'too much', outstanding: 300_000 },
    },
  });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  const form = page.getByRole('form', { name: 'Ghi nhận thanh toán' });
  await form.getByLabel('Số tiền (VND)').fill('500000');
  await form.getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(form.getByRole('alert')).toHaveText(
    'Số tiền vượt số còn nợ (300.000 ₫) (BR-BI-07).',
  );
});

test('a wrongly recorded payment is reversed with a reason, never deleted', async ({ page }) => {
  let reversed = false;
  const payment = {
    id: PAYMENT_ID,
    kind: 'PAYMENT',
    reversesPaymentId: null,
    amount: 500_000,
    method: 'BANK_TRANSFER',
    paidAt: '2027-01-03T03:00:00.000Z',
    note: null,
  };
  const api = await asTutor(page, {
    'GET /billing/invoices/:id': () => ({
      body: invoice({
        status: reversed ? 'ISSUED' : 'PARTIALLY_PAID',
        paid: reversed ? 0 : 500_000,
        outstanding: reversed ? 1_300_000 : 800_000,
        payments: reversed
          ? [
              payment,
              {
                id: 'r1',
                kind: 'REVERSAL',
                reversesPaymentId: PAYMENT_ID,
                amount: 500_000,
                method: 'BANK_TRANSFER',
                paidAt: '2027-01-04T03:00:00.000Z',
                note: 'Chuyển nhầm hóa đơn',
              },
            ]
          : [payment],
      }),
    }),
    'POST /billing/payments/:id/reversal': () => {
      reversed = true;
      return { status: 201, body: { invoiceStatus: 'ISSUED' } };
    },
  });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  await page.getByRole('button', { name: 'Tạo bút toán đảo' }).click();
  await expect(page.getByRole('dialog')).toContainText('Thanh toán không bao giờ bị sửa hay xóa');
  await page.getByRole('dialog').getByRole('button', { name: 'Tạo bút toán đảo' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Cần nhập lý do đảo.');
  expect(api.find('POST', `/billing/payments/${PAYMENT_ID}/reversal`)).toEqual([]);
  await page.getByRole('dialog').getByLabel('Lý do đảo').fill('Chuyển nhầm hóa đơn');
  await page.getByRole('dialog').getByRole('button', { name: 'Tạo bút toán đảo' }).click();
  await expect(main(page).getByText(/Đã tạo bút toán đảo/)).toBeVisible();
  expect(api.find('POST', `/billing/payments/${PAYMENT_ID}/reversal`)[0].body).toEqual({
    reason: 'Chuyển nhầm hóa đơn',
  });
  await expect(main(page).getByRole('cell', { name: 'Đã đảo' })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Tạo bút toán đảo' })).toHaveCount(0); // once only
  await expect(main(page).getByText('Chuyển nhầm hóa đơn')).toBeVisible();
});

test('void-and-replace needs a reason and opens the replacement', async ({ page }) => {
  const api = await asTutor(page, {
    'GET /billing/invoices/:id': (req) => ({
      body: req.path.endsWith(NEW_INVOICE)
        ? invoice({ id: NEW_INVOICE, replacesInvoiceId: INVOICE_ID, studentName: 'Nguyễn Văn An' })
        : invoice(),
    }),
    'POST /billing/invoices/:id/void': {
      status: 201,
      body: { voided: invoice({ status: 'VOID' }), replacement: { id: NEW_INVOICE } },
    },
  });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  await page.getByRole('button', { name: 'Hủy hóa đơn và phát hành hóa đơn thay thế' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy và phát hành lại' }).click();
  await expect(page.getByRole('dialog').getByRole('alert')).toHaveText('Cần nhập lý do hủy.');
  expect(api.find('POST', `/billing/invoices/${INVOICE_ID}/void`)).toEqual([]);
  await page.getByRole('dialog').getByLabel('Lý do hủy').fill('Sai tên học sinh');
  await page.getByRole('dialog').getByRole('button', { name: 'Hủy và phát hành lại' }).click();
  await expect(page).toHaveURL(new RegExp(`/tutor/invoices/${NEW_INVOICE}$`));
  await expect(main(page).getByText('Hóa đơn này thay thế một hóa đơn đã bị hủy.')).toBeVisible();
  expect(api.find('POST', `/billing/invoices/${INVOICE_ID}/void`).at(-1)!.body).toEqual({
    reason: 'Sai tên học sinh',
  });
});

test('VietQR shows the amount, the transfer note and a scannable code', async ({ page }) => {
  await asTutor(page, {
    'GET /billing/invoices/:id': { body: invoice() },
    'GET /billing/invoices/:id/qr': {
      body: {
        invoiceId: INVOICE_ID,
        amount: 1_300_000,
        bankBin: '970436',
        accountNumber: '0011001234567',
        accountName: 'NGUYEN VAN GIAO',
        description: 'TMS 77777777',
        payload:
          '00020101021238540010A00000072701240006970436011300110012345670208QRIBFTTA53037045407130000058' +
          '02VN62160812TMS 7777777763041234',
      },
    },
  });
  await page.goto(`/tutor/invoices/${INVOICE_ID}`);
  const qr = main(page).getByRole('region', { name: 'VietQR' });
  await expect(qr.getByText('Nội dung chuyển khoản: TMS 77777777')).toBeVisible();
  await expect(qr.getByText('Số tiền: 1.300.000 ₫')).toBeVisible();
  await expect(qr.getByRole('img', { name: 'Mã VietQR' }).locator('svg')).toBeVisible();
});

test("a Student's balance on their page, and the revenue report", async ({ page }) => {
  const api = await asTutor(page, {
    'GET /students/:id': {
      body: {
        id: STUDENT_ID,
        tutorId: 't',
        fullName: 'Nguyễn An',
        email: null,
        dob: '2012-05-04',
        school: null,
        grade: null,
        status: 'ACTIVE',
        note: null,
        parents: [],
      },
    },
    'GET /students/:id/classes': { body: [] },
    'GET /students/:id/attendance': {
      body: {
        studentId: STUDENT_ID,
        month: '2026-11',
        summary: { PRESENT: 0, LATE: 0, EXCUSED: 0, ABSENT: 0 },
        records: [],
      },
    },
    'GET /billing/students/:id/balance': {
      body: {
        studentId: STUDENT_ID,
        studentName: 'Nguyễn An',
        outstanding: 1_500_000,
        overdue: 1_000_000,
        currentMonthDraft: 400_000,
        invoices: [
          {
            invoiceId: INVOICE_ID,
            kind: 'ENROLLMENT',
            period: '2026-11',
            status: 'OVERDUE',
            dueDate: '2026-11-08',
            total: 1_000_000,
            paid: 0,
            outstanding: 1_000_000,
          },
        ],
      },
    },
    'GET /billing/reports/revenue': (req) => ({
      body: {
        from: req.query.get('from'),
        to: req.query.get('to'),
        months: [
          { period: '2026-10', billed: 2_000_000, collected: 1_500_000 },
          { period: '2026-11', billed: 0, collected: 300_000 },
        ],
        billed: 2_000_000,
        collected: 1_800_000,
      },
    }),
  });
  await page.goto(`/tutor/students/${STUDENT_ID}`);
  const balance = main(page).getByRole('region', { name: 'Công nợ' });
  await expect(balance.getByText('Còn phải trả: 1.500.000 ₫')).toBeVisible();
  await expect(balance.getByText('Quá hạn 1.000.000 ₫')).toBeVisible();
  await expect(balance.getByRole('link', { name: 'Hóa đơn ghi danh 11/2026' })).toHaveAttribute(
    'href',
    `/tutor/invoices/${INVOICE_ID}`,
  );

  await page.getByRole('link', { name: 'Doanh thu' }).click();
  await expect(main(page).getByText('Đã thu: 1.800.000 ₫')).toBeVisible();
  await expect(main(page).getByRole('row', { name: /10\/2026/ })).toContainText('2.000.000 ₫');
  await page.getByLabel('Từ tháng').fill('2026-10');
  await page.getByLabel('Đến tháng').fill('2026-11');
  await expect
    .poll(() => {
      const q = api.find('GET', '/billing/reports/revenue').at(-1)!.query;
      return [q.get('from'), q.get('to')];
    })
    .toEqual(['2026-10', '2026-11']);
});
