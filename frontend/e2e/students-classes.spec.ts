/**
 * Tutor screens for Students, Classes and enrollment (#23, "Giáo viên – học sinh và phụ
 * huynh", "Giáo viên – lớp và ghi danh").
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, expectBearer, meOf, signIn, stubApi, type TestUser } from './support';

const STUDENT_ID = '11111111-1111-4111-8111-111111111111';
const CLASS_ID = '22222222-2222-4222-8222-222222222222';

const student = (over: object = {}) => ({
  id: STUDENT_ID,
  tutorId: 't',
  fullName: 'Nguyễn An',
  email: null,
  dob: '2012-05-04',
  school: 'THCS Lê Lợi',
  grade: 8,
  status: 'ACTIVE',
  note: 'Cần luyện thêm hình học',
  payer: 'PRIMARY_PARENT',
  payerContact: { name: 'Trần Lan', email: 'lan@example.com', phone: '0901234567' },
  parents: [
    {
      id: 'p1',
      fullName: 'Trần Lan',
      isPrimary: true,
      phone: '0901234567',
      email: 'lan@example.com',
    },
    { id: 'p2', fullName: 'Nguyễn Bình', isPrimary: false, phone: '0907654321', email: null },
  ],
  ...over,
});
const cls = (over: object = {}) => ({
  id: CLASS_ID,
  tutorId: 't',
  name: 'Toán 8 – nhóm tối thứ 2',
  subject: 'Toán',
  type: 'GROUP',
  maxStudents: 4,
  feeType: 'MONTHLY',
  feeAmount: 1_200_000,
  chargeAbsent: true,
  feeEffectiveFrom: '2026-11',
  status: 'OPEN',
  ...over,
});

let tutor: TestUser;
test.beforeAll(async () => {
  tutor = await createUser('TUTOR');
});
async function asTutor(page: Page, stubs: Parameters<typeof stubApi>[1]) {
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(tutor) }, ...stubs });
  await signIn(page, tutor);
  await expect(page).toHaveURL(/\/tutor$/);
  return api;
}
const main = (page: Page) => page.getByRole('main');

test('students list: search, status filter and paging go to the API', async ({ page }) => {
  const api = await asTutor(page, {
    'GET /students': (req) => ({
      body: {
        items: req.query.get('q') === 'Bình' ? [] : [student()],
        total: 1,
        page: Number(req.query.get('page')),
        pageSize: 20,
      },
    }),
  });
  await page.getByRole('link', { name: 'Học sinh' }).click();
  await expect(main(page).getByRole('link', { name: 'Nguyễn An' })).toBeVisible();
  await expect(main(page).getByText('04/05/2012')).toBeVisible(); // Vietnamese date
  await expect(main(page).getByRole('cell', { name: 'Đang học' })).toBeVisible();
  await page.getByLabel('Tìm theo tên').fill('Bình');
  await page.getByRole('button', { name: 'Tìm' }).click();
  await expect(main(page).getByText('Chưa có học sinh nào khớp bộ lọc.')).toBeVisible();
  await page.getByLabel('Trạng thái').selectOption('PAUSED');
  const last = api.find('GET', '/students').at(-1)!;
  await expect.poll(() => api.find('GET', '/students').at(-1)!.query.get('status')).toBe('PAUSED');
  expect(last.query.get('q')).toBe('Bình');
  expectBearer(api.calls, tutor);
});

test('creating a Student under 18 without a primary Parent is blocked before any request', async ({
  page,
}) => {
  const api = await asTutor(page, {});
  await page.goto('/tutor/students/new');
  await page.getByLabel('Họ tên học sinh').fill('Lê Chi');
  await page.getByLabel('Ngày sinh').fill('2014-03-02');
  await page.getByRole('button', { name: 'Bỏ phụ huynh này' }).click();
  await page.getByRole('button', { name: 'Lưu học sinh' }).click();
  await expect(main(page).getByRole('alert')).toContainText(
    'dưới 18 tuổi phải có một phụ huynh chính',
  );
  expect(api.find('POST', '/students')).toEqual([]);
});

test('creating a Student with a primary Parent sends the right body and reports the invitation', async ({
  page,
}) => {
  const api = await asTutor(page, {
    'POST /students': (req) => ({
      status: 201,
      body: {
        ...student({ fullName: (req.body as { fullName: string }).fullName }),
        invitation: { status: 'sent', to: 'PARENT', email: 'lan@example.com' },
      },
    }),
  });
  await page.goto('/tutor/students/new');
  await page.getByLabel('Họ tên học sinh').fill('Lê Chi');
  await page.getByLabel('Ngày sinh').fill('2014-03-02');
  await page.getByLabel('Khối lớp').selectOption('6');
  await page.getByLabel('Họ tên phụ huynh 1').fill('Trần Lan');
  await page.getByLabel('Số điện thoại phụ huynh 1').fill('0901234567');
  await page.getByLabel('Email phụ huynh 1').fill('lan@example.com');
  await page.getByRole('button', { name: 'Lưu học sinh' }).click();
  await expect(
    main(page).getByText(
      'Đã gửi lời mời kích hoạt tài khoản tới lan@example.com (phụ huynh chính).',
    ),
  ).toBeVisible();
  const [post] = api.find('POST', '/students');
  expect(post.body).toEqual({
    fullName: 'Lê Chi',
    dob: '2014-03-02',
    grade: 6,
    invite: true,
    parents: [
      { fullName: 'Trần Lan', phone: '0901234567', email: 'lan@example.com', isPrimary: true },
    ],
  });
});

test('student detail: payer, private note, Parents; status change asks first; invitation resent', async ({
  page,
}) => {
  const api = await asTutor(page, {
    'GET /students/:id': { body: student() },
    'GET /students/:id/classes': {
      body: [
        {
          enrollmentId: 'e1',
          status: 'AWAITING_PAYMENT',
          joinedAt: '2026-11-18',
          paymentDeadline: '2026-11-25T03:00:00.000Z',
          class: {
            id: CLASS_ID,
            name: 'Toán 8',
            subject: 'Toán',
            type: 'GROUP',
            feeType: 'MONTHLY',
            tutorId: 't',
          },
        },
      ],
    },
    'POST /students/:id/status': { status: 201, body: {} },
    'POST /auth/invitations': { status: 201, body: {} },
  });
  await page.goto(`/tutor/students/${STUDENT_ID}`);
  await expect(main(page).getByText('Phụ huynh chính: Trần Lan')).toBeVisible();
  await expect(main(page).getByText('Cần luyện thêm hình học')).toBeVisible();
  await expect(main(page).getByText('Chờ thanh toán')).toBeVisible();

  await page.getByRole('button', { name: 'Chuyển sang “Tạm nghỉ”' }).click();
  await expect(page.getByRole('dialog')).toContainText('sau 60 ngày tạm nghỉ');
  await page.getByRole('button', { name: 'Không' }).click();
  expect(api.find('POST', `/students/${STUDENT_ID}/status`)).toEqual([]);
  await page.getByRole('button', { name: 'Chuyển sang “Tạm nghỉ”' }).click();
  await page.getByRole('button', { name: 'Xác nhận' }).click();
  await expect(main(page).getByText('Đã chuyển sang “Tạm nghỉ”.')).toBeVisible();
  expect(api.find('POST', `/students/${STUDENT_ID}/status`)[0].body).toEqual({ status: 'PAUSED' });

  await page.getByRole('button', { name: 'Gửi lại lời mời' }).click();
  await expect(
    main(page).getByText(/Đã gửi lời mời tới phụ huynh chính \(lan@example.com\)/),
  ).toBeVisible();
  expect(api.find('POST', '/auth/invitations')[0].body).toEqual({
    email: 'lan@example.com',
    fullName: 'Trần Lan',
    role: 'PARENT',
  });
});

test('creating a group Class sends its seats and fee, then opens it', async ({ page }) => {
  const api = await asTutor(page, {
    'POST /classes': { status: 201, body: cls() },
    'GET /classes/:id': { body: cls() },
    'GET /classes/:id/students': { body: [] },
    'GET /students': { body: { items: [], total: 0, page: 1, pageSize: 100 } },
  });
  await page.goto('/tutor/classes/new');
  await page.getByLabel('Tên lớp').fill('Toán 8 – nhóm tối thứ 2');
  await page.getByLabel('Môn học').fill('Toán');
  await page.getByLabel('Loại lớp').selectOption('GROUP');
  await page.getByLabel('Sĩ số tối đa').fill('4');
  await page.getByLabel('Cách tính học phí').selectOption('MONTHLY');
  await page.getByLabel('Học phí mỗi tháng (VND)').fill('1200000');
  await page.getByRole('button', { name: 'Tạo lớp' }).click();
  await expect(page).toHaveURL(new RegExp(`/tutor/classes/${CLASS_ID}$`));
  expect(api.find('POST', '/classes')[0].body).toEqual({
    name: 'Toán 8 – nhóm tối thứ 2',
    subject: 'Toán',
    type: 'GROUP',
    maxStudents: 4,
    feeType: 'MONTHLY',
    feeAmount: 1200000,
    chargeAbsent: true,
  });
  await expect(main(page).getByText('1.200.000 ₫')).toBeVisible(); // VND formatting
});

test.describe('enrolling a Student', () => {
  for (const [name, reply, expected] of [
    [
      '201 ACTIVE',
      { status: 201, body: { id: 'e1', studentName: 'Nguyễn An', status: 'ACTIVE' } },
      'Đã ghi danh Nguyễn An vào lớp.',
    ],
    [
      '201 AWAITING_PAYMENT',
      {
        status: 201,
        body: {
          id: 'e1',
          studentName: 'Nguyễn An',
          status: 'AWAITING_PAYMENT',
          paymentDeadline: '2026-11-27T16:30:00.000Z',
        },
      },
      'Nguyễn An đang chờ thanh toán: hóa đơn ghi danh đã được gửi cho người thanh toán, hạn 27/11/2026 23:30 (7 ngày).',
    ],
    [
      '202 PENDING',
      { status: 202, body: { id: 'e1', studentName: 'Nguyễn An', status: 'PENDING' } },
      'Đang xử lý ghi danh Nguyễn An',
    ],
    ['409 class full', { status: 409, body: { message: 'the class is full' } }, 'Lớp đã đủ chỗ.'],
    [
      '409 already enrolled',
      {
        status: 409,
        body: { message: 'this Student is already enrolled in the class (BR-CL-03)' },
      },
      'Học sinh này đã ghi danh vào lớp rồi.',
    ],
  ] as const) {
    test(name, async ({ page }) => {
      const api = await asTutor(page, {
        'GET /classes/:id': { body: cls() },
        'GET /classes/:id/students': { body: [] },
        'GET /students': { body: { items: [student()], total: 1, page: 1, pageSize: 100 } },
        'POST /classes/:id/enrollments': reply,
      });
      await page.goto(`/tutor/classes/${CLASS_ID}`);
      await page.getByLabel('Ghi danh học sinh').selectOption(STUDENT_ID);
      await page.getByRole('button', { name: 'Ghi danh', exact: true }).click();
      await expect(main(page)).toContainText(expected);
      expect(api.find('POST', `/classes/${CLASS_ID}/enrollments`)[0].body).toEqual({
        studentId: STUDENT_ID,
      });
    });
  }
});

test('changing the fee says it applies from the next period; closing asks first', async ({
  page,
}) => {
  const api = await asTutor(page, {
    'GET /classes/:id': { body: cls() },
    'GET /classes/:id/students': {
      body: [
        {
          id: 'e1',
          studentId: STUDENT_ID,
          studentName: 'Nguyễn An',
          status: 'AWAITING_PAYMENT',
          paymentDeadline: '2026-11-27T16:30:00.000Z',
          joinedAt: '2026-11-20',
        },
      ],
    },
    'GET /students': { body: { items: [], total: 0, page: 1, pageSize: 100 } },
    'PATCH /classes/:id': (req) => ({
      body: cls({
        feeAmount: (req.body as { feeAmount: number }).feeAmount,
        feeEffectiveFrom: '2026-12',
      }),
    }),
    'POST /classes/:id/close': { status: 201, body: cls({ status: 'CLOSED' }) },
  });
  await page.goto(`/tutor/classes/${CLASS_ID}`);
  await expect(
    main(page).getByText('Hạn thanh toán hóa đơn ghi danh: 27/11/2026 23:30'),
  ).toBeVisible();
  await page.getByRole('button', { name: 'Đổi học phí' }).click();
  await page.getByLabel('Học phí mới mỗi tháng (VND)').fill('1500000');
  await page.getByRole('button', { name: 'Lưu học phí' }).click();
  await expect(
    main(page).getByText(/Mức mới áp dụng từ kỳ 12\/2026; các hóa đơn của kỳ trước không thay đổi/),
  ).toBeVisible();
  expect(api.find('PATCH', `/classes/${CLASS_ID}`)[0].body).toEqual({
    feeAmount: 1500000,
    chargeAbsent: true,
  });

  await page.getByRole('button', { name: 'Đóng lớp' }).click();
  await expect(page.getByRole('dialog')).toContainText('Các buổi học tương lai bị hủy');
  await page.getByRole('dialog').getByRole('button', { name: 'Đóng lớp' }).click();
  await expect(main(page).getByText('Đã đóng lớp.')).toBeVisible();
  expect(api.find('POST', `/classes/${CLASS_ID}/close`)).toHaveLength(1);
});
