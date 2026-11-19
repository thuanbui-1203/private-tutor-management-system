/**
 * Parent, Student and Admin screens (#23, "Phụ huynh", "Học sinh", "Admin"): child switcher,
 * schedule with cancelled / moved Sessions, own-child Attendance only, billing only for the
 * Payer, and the Admin's Tutor administration (BR-CL-08).
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type Role, type TestUser } from './support';

const AN = '11111111-1111-4111-8111-111111111111';
const BINH = '12121212-1212-4212-8212-121212121212';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const INVOICE_ID = '77777777-7777-4777-8777-777777777777';

const child = (id: string, fullName: string, over: object = {}) => ({
  id,
  tutorId: 't',
  fullName,
  email: null,
  dob: '2012-05-04',
  school: null,
  grade: 8,
  status: 'ACTIVE',
  parents: [{ id: 'p1', fullName: 'Trần Lan', isPrimary: true }],
  ...over,
});
const asPayer = {
  payer: 'PRIMARY_PARENT',
  payerContact: { name: 'Trần Lan', email: 'lan@example.com' },
};
const sessionOn = (date: string, status: string, over: object = {}) => ({
  id: `s-${date}-${status}`,
  classId: CLASS_ID,
  scheduleId: null,
  date,
  startTime: '19:00',
  endTime: '20:30',
  startsAt: `${date}T12:00:00.000Z`,
  endsAt: `${date}T13:30:00.000Z`,
  status,
  makeupOf: null,
  cancelReason: null,
  ...over,
});
const classesOf = [
  {
    enrollmentId: 'e',
    status: 'ACTIVE',
    joinedAt: '2026-10-01',
    paymentDeadline: null,
    class: {
      id: CLASS_ID,
      name: 'Toán 8 nhóm',
      subject: 'Toán',
      type: 'GROUP',
      feeType: 'MONTHLY',
      tutorId: 't',
    },
  },
];
const invoice = (over: object = {}) => ({
  id: INVOICE_ID,
  kind: 'ENROLLMENT',
  studentId: AN,
  enrollmentId: 'e',
  studentName: 'Nguyễn An',
  payerContact: { name: 'Trần Lan' },
  period: '2026-11',
  total: 1_000_000,
  status: 'OVERDUE',
  issuedAt: '2026-11-01T03:00:00.000Z',
  dueDate: '2026-11-08',
  replacesInvoiceId: null,
  ...over,
});

const users: Partial<Record<Role, TestUser>> = {};
async function as(role: Role, page: Page, stubs: Parameters<typeof stubApi>[1]) {
  users[role] ??= await createUser(role);
  const user = users[role]!;
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(user) }, ...stubs });
  await signIn(page, user);
  return api;
}
const main = (page: Page) => page.getByRole('main');

test('a Parent with two children switches between them; cancelled and moved Sessions stand out', async ({
  page,
}) => {
  const api = await as('PARENT', page, {
    'GET /parents/me/children': {
      body: [child(AN, 'Nguyễn An', asPayer), child(BINH, 'Nguyễn Bình', asPayer)],
    },
    'GET /students/:id/classes': { body: classesOf },
    'GET /sessions': (req) => ({
      body:
        req.query.get('studentId') === AN
          ? [
              sessionOn('2026-12-03', 'SCHEDULED'),
              sessionOn('2026-12-07', 'CANCELLED', { cancelReason: 'Giáo viên ốm' }),
              sessionOn('2026-12-10', 'RESCHEDULED'),
            ]
          : [],
    }),
  });
  await expect(page).toHaveURL(/\/parent$/);
  await expect(main(page).getByRole('heading', { name: 'Lịch học của Nguyễn An' })).toBeVisible();
  await expect(main(page).getByRole('cell', { name: 'Toán 8 nhóm' }).first()).toBeVisible();
  await expect(main(page).getByText('Lý do: Giáo viên ốm')).toBeVisible();
  await expect(main(page).getByText('Buổi này đã được dời sang giờ khác')).toBeVisible();
  await expect(main(page).getByText('Thứ Năm, 03/12/2026')).toBeVisible();
  expect(api.find('GET', '/sessions').at(-1)!.query.get('studentId')).toBe(AN);

  await page.getByLabel('Đang xem').selectOption(BINH);
  await expect(main(page).getByRole('heading', { name: 'Lịch học của Nguyễn Bình' })).toBeVisible();
  await expect(main(page).getByText('Không có buổi học nào trong 4 tuần tới.')).toBeVisible();
  expect(api.find('GET', '/sessions').at(-1)!.query.get('studentId')).toBe(BINH);
  await page.reload(); // the chosen child is remembered
  await expect(main(page).getByRole('heading', { name: 'Lịch học của Nguyễn Bình' })).toBeVisible();
});

test('the paying Parent sees billing: invoices incl. the Enrollment invoice, overdue, read-only detail with VietQR', async ({
  page,
}) => {
  const api = await as('PARENT', page, {
    'GET /parents/me/children': { body: [child(AN, 'Nguyễn An', asPayer)] },
    'GET /students/:id/classes': { body: classesOf },
    'GET /sessions': { body: [] },
    'GET /billing/students/:id/balance': {
      body: {
        studentId: AN,
        studentName: 'Nguyễn An',
        outstanding: 1_000_000,
        overdue: 1_000_000,
        currentMonthDraft: 0,
        invoices: [],
      },
    },
    'GET /billing/students/:id/invoices': {
      body: [
        invoice(),
        invoice({
          id: 'paid-1',
          kind: 'MONTHLY',
          period: '2026-10',
          status: 'PAID',
          total: 800_000,
          dueDate: '2026-11-10',
        }),
      ],
    },
    'GET /billing/invoices/:id': {
      body: {
        ...invoice(),
        paid: 0,
        outstanding: 1_000_000,
        payments: [],
        items: [
          {
            id: 'i',
            type: 'FEE',
            classId: CLASS_ID,
            sessionId: null,
            enrollmentId: 'e',
            adjustsItemId: null,
            servicePeriod: '2026-11',
            attendanceStatus: null,
            description: 'Học phí tháng 11/2026 (3/5 buổi) (ghi danh)',
            amount: 1_000_000,
          },
        ],
      },
    },
    'GET /billing/invoices/:id/qr': {
      body: {
        invoiceId: INVOICE_ID,
        amount: 1_000_000,
        bankBin: '970436',
        accountNumber: '001',
        accountName: null,
        description: 'TMS 77777777',
        payload: '000201',
      },
    },
  });
  await page.getByRole('link', { name: 'Học phí' }).click();
  await expect(main(page).getByText('Còn phải trả: 1.000.000 ₫')).toBeVisible();
  await expect(main(page).getByText('Quá hạn 1.000.000 ₫')).toBeVisible();
  await expect(main(page).getByRole('cell', { name: 'Đã thanh toán' })).toBeVisible(); // paid ones are listed too
  await main(page).getByRole('link', { name: 'Hóa đơn ghi danh 11/2026' }).click();
  await expect(main(page).getByText(/Hóa đơn đã quá hạn thanh toán/)).toBeVisible();
  await expect(main(page).getByText('Học phí tháng 11/2026 (3/5 buổi) (ghi danh)')).toBeVisible();
  await expect(main(page).getByRole('region', { name: 'VietQR' })).toContainText('TMS 77777777');
  await expect(page.getByRole('form', { name: 'Ghi nhận thanh toán' })).toHaveCount(0); // read-only for the Payer
  await expect(page.getByRole('button', { name: /Hủy hóa đơn/ })).toHaveCount(0);
  expect(api.find('GET', `/billing/students/${AN}/invoices`).length).toBeGreaterThan(0);
});

test('a secondary Parent sees schedule and Attendance but no billing (BR-ST-06)', async ({
  page,
}) => {
  const api = await as('PARENT', page, {
    'GET /parents/me/children': { body: [child(AN, 'Nguyễn An')] }, // no payer fields: not theirs to see
    'GET /students/:id/classes': { body: classesOf },
    'GET /sessions': { body: [] },
    'GET /students/:id/attendance': (req) => ({
      body: {
        studentId: AN,
        month: req.query.get('month'),
        summary: { PRESENT: 2, LATE: 0, EXCUSED: 1, ABSENT: 0 },
        records: [
          {
            sessionId: 's1',
            classId: CLASS_ID,
            date: '2026-11-03',
            startTime: '19:00',
            endTime: '20:30',
            status: 'EXCUSED',
            note: null,
          },
        ],
      },
    }),
  });
  await expect(page.getByRole('link', { name: 'Chuyên cần' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Học phí' })).toHaveCount(0);
  await page.getByRole('link', { name: 'Chuyên cần' }).click();
  await expect(main(page).getByText('Vắng có phép: 1')).toBeVisible();
  await expect(main(page).getByRole('cell', { name: 'Toán 8 nhóm' })).toBeVisible();
  // The group Class's other Students never appear: only this child's own records are asked for.
  expect(
    api.calls
      .filter((c) => c.path.includes('/attendance'))
      .every((c) => c.path === `/students/${AN}/attendance`),
  ).toBe(true);
  await page.goto('/parent/billing');
  await expect(
    main(page).getByText('Mục học phí chỉ dành cho người thanh toán của học sinh này.'),
  ).toBeVisible();
  expect(api.find('GET', `/billing/students/${AN}/invoices`)).toEqual([]);
});

test('a Student sees their own schedule; billing only when they pay for themselves', async ({
  page,
}) => {
  let payer: object = {};
  await as('STUDENT', page, {
    'GET /students/me': () => ({ body: child(AN, 'Lê Hoa', payer) }),
    'GET /students/:id/classes': { body: classesOf },
    'GET /sessions': { body: [sessionOn('2026-12-03', 'SCHEDULED')] },
  });
  await expect(page).toHaveURL(/\/student$/);
  await expect(main(page).getByRole('heading', { name: 'Lịch học của Lê Hoa' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Học phí' })).toHaveCount(0); // a minor: the Parent pays
  payer = { payer: 'SELF', payerContact: { name: 'Lê Hoa', email: 'hoa@example.com' } };
  await page.reload();
  await expect(page.getByRole('link', { name: 'Học phí' })).toBeVisible(); // an adult paying for themselves
});

test('an account not linked to a Student record gets a clear message', async ({ page }) => {
  await as('STUDENT', page, {
    'GET /students/me': { status: 404, body: { message: 'no Student is linked' } },
  });
  await expect(main(page).getByRole('alert')).toContainText('Không tìm thấy dữ liệu');
});

test('Admin: Tutors list; disabling one with open Classes explains BR-CL-08; disabling works otherwise', async ({
  page,
}) => {
  const tutors = [
    {
      id: 'u1',
      email: 'co.giao@example.com',
      role: 'TUTOR',
      status: 'ACTIVE',
      createdAt: '2026-10-01T03:00:00.000Z',
    },
    {
      id: 'u2',
      email: 'thay.ba@example.com',
      role: 'TUTOR',
      status: 'ACTIVE',
      createdAt: '2026-10-02T03:00:00.000Z',
    },
  ];
  const api = await as('ADMIN', page, {
    'GET /users': (req) => ({ body: req.query.get('role') === 'TUTOR' ? tutors : [] }),
    'PATCH /users/:id': (req) =>
      req.path.endsWith('/u1')
        ? { status: 409, body: { message: 'open classes', openClassIds: ['c1', 'c2'] } }
        : { body: { ...tutors[1], status: 'DISABLED' } },
  });
  await expect(page).toHaveURL(/\/admin$/);
  await expect(main(page).getByRole('cell', { name: 'co.giao@example.com' })).toBeVisible();
  await main(page)
    .getByRole('row', { name: /co\.giao/ })
    .getByRole('button', { name: 'Vô hiệu hóa' })
    .click();
  await expect(page.getByRole('dialog')).toContainText('đăng xuất ngay');
  await page.getByRole('dialog').getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await expect(main(page).getByRole('alert')).toContainText('giáo viên còn 2 lớp đang mở');
  await main(page)
    .getByRole('row', { name: /thay\.ba/ })
    .getByRole('button', { name: 'Vô hiệu hóa' })
    .click();
  await page.getByRole('dialog').getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await expect(main(page).getByText('Đã vô hiệu hóa thay.ba@example.com.')).toBeVisible();
  expect(api.find('PATCH', '/users/u2')[0].body).toEqual({ status: 'DISABLED' });
  // The Admin also has every Tutor screen.
  await expect(page.getByRole('link', { name: 'Doanh thu' })).toBeVisible();
});

test('Admin creating a Student does it on their own account (tutorId)', async ({ page }) => {
  const api = await as('ADMIN', page, {
    'GET /users': { body: [] },
    'POST /students': {
      status: 201,
      body: { ...child(AN, 'Lê Chi'), invitation: { status: 'skipped' } },
    },
  });
  await page.goto('/tutor/students/new');
  await page.getByLabel('Họ tên học sinh').fill('Lê Chi');
  await page.getByLabel('Ngày sinh').fill('2014-03-02');
  await page.getByLabel('Họ tên phụ huynh 1').fill('Trần Lan');
  await page.getByLabel('Số điện thoại phụ huynh 1').fill('0901234567');
  await page.getByRole('button', { name: 'Lưu học sinh' }).click();
  await expect(main(page).getByText('Đã thêm học sinh Lê Chi')).toBeVisible();
  expect(api.find('POST', '/students')[0].body).toMatchObject({ tutorId: users.ADMIN!.userId });
});
