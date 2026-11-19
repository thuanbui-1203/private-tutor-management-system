/**
 * Tutor screens for Schedules, the teaching calendar and Attendance (#23, "Giáo viên – lịch và
 * buổi học", "Giáo viên – điểm danh").
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type TestUser } from './support';

const CLASS_ID = '22222222-2222-4222-8222-222222222222';
const OTHER_CLASS = '33333333-3333-4333-8333-333333333333';
const SESSION_ID = '44444444-4444-4444-8444-444444444444';
const STUDENT_A = '55555555-5555-4555-8555-555555555555';
const STUDENT_B = '66666666-6666-4666-8666-666666666666';
const HOUR = 3_600_000;

const cls = (id = CLASS_ID, name = 'Toán 8') => ({
  id,
  tutorId: 't',
  name,
  subject: 'Toán',
  type: 'GROUP',
  maxStudents: 4,
  feeType: 'PER_SESSION',
  feeAmount: 200_000,
  chargeAbsent: true,
  feeEffectiveFrom: '2026-11',
  status: 'OPEN',
});
/** A Session starting `inHours` from now (Vietnam local date/time derived from it). */
function session(inHours: number, over: object = {}) {
  const startsAt = new Date(Date.now() + inHours * HOUR);
  const endsAt = new Date(startsAt.getTime() + 1.5 * HOUR);
  const local = (d: Date) => new Date(d.getTime() + 7 * HOUR).toISOString();
  return {
    id: SESSION_ID,
    classId: CLASS_ID,
    scheduleId: null,
    date: local(startsAt).slice(0, 10),
    startTime: local(startsAt).slice(11, 16),
    endTime: local(endsAt).slice(11, 16),
    startsAt: startsAt.toISOString(),
    endsAt: endsAt.toISOString(),
    status: 'SCHEDULED',
    makeupOf: null,
    cancelReason: null,
    ...over,
  };
}

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
const classPage = {
  'GET /classes/:id': { body: cls() },
  'GET /classes/:id/students': { body: [] },
  'GET /students': { body: { items: [], total: 0, page: 1, pageSize: 100 } },
};

test('Schedule preview shows the overlaps; saving skips them only when asked', async ({ page }) => {
  const conflict = {
    date: '2026-12-07',
    startTime: '19:00',
    endTime: '20:30',
    conflictsWith: { sessionId: 's', classId: OTHER_CLASS, startTime: '18:30', endTime: '20:00' },
  };
  const api = await asTutor(page, {
    ...classPage,
    'GET /schedules': { body: [] },
    'POST /schedules/preview': {
      body: {
        sessions: [
          { date: '2026-11-30', startTime: '19:00', endTime: '20:30' },
          { date: '2026-12-07', startTime: '19:00', endTime: '20:30' },
        ],
        conflicts: [conflict],
      },
    },
    'POST /schedules': { status: 201, body: { sessionsCreated: 1, skipped: [conflict] } },
  });
  await page.goto(`/tutor/classes/${CLASS_ID}`);
  await expect(main(page).getByText(/Lịch lặp không sửa được \(BR-SC-07\)/)).toBeVisible();
  const form = page.getByRole('form', { name: 'Tạo lịch lặp' });
  await form.getByLabel('Thứ trong tuần').selectOption('1');
  await form.getByLabel('Từ ngày').fill('2026-11-30');
  await form.getByRole('button', { name: 'Xem trước' }).click();
  await expect(form.getByText('Sẽ sinh 2 buổi (buổi đầu 30/11/2026).')).toBeVisible();
  await expect(
    form.getByText('07/12/2026 19:00–20:30 trùng buổi 18:30–20:00 của lớp khác'),
  ).toBeVisible();
  await expect(form.getByRole('button', { name: 'Lưu lịch lặp' })).toBeDisabled();
  await form.getByRole('button', { name: 'Lưu và bỏ qua 1 buổi trùng' }).click();
  await expect(
    main(page).getByText('Đã tạo lịch lặp và sinh 1 buổi học, bỏ qua 1 buổi bị trùng.'),
  ).toBeVisible();
  expect(api.find('POST', '/schedules/preview')[0].body).toEqual({
    classId: CLASS_ID,
    weekday: 1,
    startTime: '19:00',
    endTime: '20:30',
    fromDate: '2026-11-30',
  });
  expect(api.find('POST', '/schedules')[0].body).toMatchObject({
    skipConflicts: true,
    fromDate: '2026-11-30',
  });
});

test('a Schedule without overlaps saves as is; ending one asks first', async ({ page }) => {
  const api = await asTutor(page, {
    ...classPage,
    'GET /schedules': {
      body: [
        {
          id: 'sch1',
          classId: CLASS_ID,
          weekday: 4,
          startTime: '19:00',
          endTime: '20:30',
          fromDate: '2026-11-01T00:00:00.000Z',
          toDate: null,
          endedAt: null,
        },
      ],
    },
    'POST /schedules/preview': {
      body: {
        sessions: [{ date: '2026-12-01', startTime: '19:00', endTime: '20:30' }],
        conflicts: [],
      },
    },
    'POST /schedules': { status: 201, body: { sessionsCreated: 13, skipped: [] } },
    'DELETE /schedules/:id': { body: { sessionsCancelled: 6 } },
  });
  await page.goto(`/tutor/classes/${CLASS_ID}`);
  await expect(main(page).getByRole('cell', { name: 'Thứ Năm' })).toBeVisible();
  const form = page.getByRole('form', { name: 'Tạo lịch lặp' });
  await form.getByRole('button', { name: 'Xem trước' }).click();
  await form.getByRole('button', { name: 'Lưu lịch lặp' }).click();
  await expect(main(page).getByText('Đã tạo lịch lặp và sinh 13 buổi học.')).toBeVisible();
  expect(api.find('POST', '/schedules')[0].body).not.toHaveProperty('skipConflicts');

  await page.getByRole('button', { name: 'Kết thúc lịch' }).click();
  await expect(page.getByRole('dialog')).toContainText(
    'Các buổi học tương lai của lịch này sẽ bị hủy',
  );
  await page.getByRole('dialog').getByRole('button', { name: 'Kết thúc lịch' }).click();
  await expect(main(page).getByText('Đã kết thúc lịch lặp và hủy 6 buổi tương lai.')).toBeVisible();
  expect(api.find('DELETE', '/schedules/sch1')).toHaveLength(1);
});

test('calendar: Sessions by day with their Class and status; cancel suggests a makeup', async ({
  page,
}) => {
  const upcoming = session(48);
  const api = await asTutor(page, {
    'GET /classes': { body: [cls(), cls(OTHER_CLASS, 'Lý 9')] },
    'GET /sessions': (req) => ({
      body: req.query.get('from') && req.query.get('from')! < upcoming.date ? [upcoming] : [],
    }),
    'POST /sessions/:id/cancel': { body: { ...upcoming, status: 'CANCELLED' } },
    'POST /sessions': { status: 201, body: session(72) },
  });
  await page.getByRole('link', { name: 'Lịch dạy' }).click();
  const card = main(page).getByRole('article', { name: `Toán 8 ${upcoming.startTime}` });
  await expect(card).toContainText('Sắp diễn ra');
  await expect(card.getByRole('button', { name: 'Mở buổi học' })).toHaveCount(0); // not yet within 15 minutes
  await card.getByRole('button', { name: 'Hủy buổi' }).click();
  await expect(
    card.getByText('Không học sinh nào bị tính phí cho buổi bị hủy (BR-SC-04).'),
  ).toBeVisible();
  await card.getByLabel('Lý do hủy').fill('Giáo viên ốm');
  await card.getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(main(page).getByText(/Bạn có thể tạo buổi bù ngay bên dưới/)).toBeVisible();
  expect(api.find('POST', `/sessions/${SESSION_ID}/cancel`)[0].body).toEqual({
    reason: 'Giáo viên ốm',
  });

  await card.getByLabel('Ngày mới').fill('2027-01-05');
  await card.getByLabel('Giờ bắt đầu').fill('18:00');
  await card.getByLabel('Giờ kết thúc').fill('19:30');
  await card.getByRole('button', { name: 'Tạo buổi bù' }).click();
  expect(api.find('POST', '/sessions')[0].body).toEqual({
    classId: CLASS_ID,
    date: '2027-01-05',
    startTime: '18:00',
    endTime: '19:30',
    makeupOf: SESSION_ID,
  });
  const listCall = api.find('GET', '/sessions')[0];
  expect(listCall.query.get('to')).toBeTruthy();
});

test('rescheduling onto another Session shows which one it overlaps (BR-SC-01)', async ({
  page,
}) => {
  const upcoming = session(48);
  await asTutor(page, {
    'GET /classes': { body: [cls(), cls(OTHER_CLASS, 'Lý 9')] },
    'GET /sessions': { body: [upcoming] },
    'POST /sessions/:id/reschedule': {
      status: 409,
      body: {
        message: "the time overlaps the Tutor's other Sessions (BR-SC-01)",
        conflicts: [
          {
            date: '2027-01-05',
            startTime: '18:00',
            endTime: '19:30',
            conflictsWith: {
              sessionId: 'x',
              classId: OTHER_CLASS,
              startTime: '18:30',
              endTime: '20:00',
            },
          },
        ],
      },
    },
  });
  await page.goto('/tutor/schedule');
  await page.getByRole('button', { name: 'Tháng' }).click();
  const card = main(page).getByRole('article').first();
  await card.getByRole('button', { name: 'Dời buổi' }).click();
  await card.getByLabel('Ngày mới').fill('2027-01-05');
  await card.getByLabel('Giờ bắt đầu').fill('18:00');
  await card.getByLabel('Giờ kết thúc').fill('19:30');
  await card.getByRole('button', { name: 'Lưu giờ mới' }).click();
  await expect(card.getByRole('alert')).toContainText(
    '05/01/2027 18:00–19:30 trùng với lớp Lý 9 18:30–20:00',
  );
});

test('a Session about to start can be opened; missed Sessions are listed for late Attendance', async ({
  page,
}) => {
  const soon = session(0.1); // starts in 6 minutes
  const missed = session(-30, { id: 'missed-1', status: 'MISSED' });
  const api = await asTutor(page, {
    'GET /classes': { body: [cls()] },
    'GET /sessions': (req) => ({
      body:
        req.query.has('classId') || req.query.get('to') !== req.query.get('from')
          ? [soon, missed]
          : [],
    }),
    'POST /sessions/:id/start': { body: { ...soon, status: 'IN_PROGRESS' } },
  });
  await page.goto('/tutor/schedule');
  const panel = main(page).getByRole('region', { name: 'Buổi bị bỏ lỡ' });
  await expect(panel.getByRole('link', { name: 'Điểm danh bổ sung' })).toHaveAttribute(
    'href',
    '/tutor/sessions/missed-1/attendance',
  );
  await main(page).getByRole('button', { name: 'Mở buổi học' }).first().click();
  await expect.poll(() => api.find('POST', `/sessions/${SESSION_ID}/start`).length).toBe(1);
});

const sheet = (over: object = {}, students?: object[]) => ({
  session: session(-2, { status: 'IN_PROGRESS' }),
  editableUntil: new Date(Date.now() + 47 * HOUR).toISOString(),
  students: students ?? [
    { studentId: STUDENT_A, studentName: 'An', status: null, note: null },
    { studentId: STUDENT_B, studentName: 'Bình', status: null, note: null },
  ],
  ...over,
});

test('whole-class Attendance: every Student needs a status; saves one PUT', async ({ page }) => {
  const api = await asTutor(page, {
    'GET /sessions/:id/attendance': { body: sheet() },
    'PUT /sessions/:id/attendance': { body: { corrected: false } },
  });
  await page.goto(`/tutor/sessions/${SESSION_ID}/attendance`);
  await page.getByRole('radiogroup', { name: 'Trạng thái của An' }).getByLabel('Đi trễ').check();
  await page.getByRole('button', { name: 'Lưu điểm danh' }).click();
  await expect(main(page).getByRole('alert')).toHaveText('Còn 1 học sinh chưa chọn trạng thái.');
  expect(api.find('PUT', `/sessions/${SESSION_ID}/attendance`)).toEqual([]);
  await page.getByLabel('Ghi chú cho An').fill('Trễ 10 phút');
  await page.getByRole('button', { name: 'Còn lại đều có mặt' }).click();
  await page.getByRole('button', { name: 'Lưu điểm danh' }).click();
  await expect(main(page).getByText('Đã lưu điểm danh. Buổi học đã hoàn thành.')).toBeVisible();
  expect(api.find('PUT', `/sessions/${SESSION_ID}/attendance`)[0].body).toEqual({
    records: [
      { studentId: STUDENT_A, status: 'LATE', note: 'Trễ 10 phút' },
      { studentId: STUDENT_B, status: 'PRESENT' },
    ],
  });
});

test('corrections within 48h are allowed and say until when; after 48h it is locked', async ({
  page,
}) => {
  const recorded = [
    { studentId: STUDENT_A, studentName: 'An', status: 'PRESENT', note: null },
    { studentId: STUDENT_B, studentName: 'Bình', status: 'ABSENT', note: null },
  ];
  const until = new Date(Date.now() + 47 * HOUR);
  let locked = false;
  const api = await asTutor(page, {
    'GET /sessions/:id/attendance': () => ({
      body: locked
        ? sheet(
            {
              editableUntil: new Date(Date.now() - HOUR).toISOString(),
              session: session(-60, { status: 'MISSED' }),
            },
            recorded,
          )
        : sheet(
            { editableUntil: until.toISOString(), session: session(-2, { status: 'COMPLETED' }) },
            recorded,
          ),
    }),
    'PUT /sessions/:id/attendance': { body: { corrected: true } },
  });
  await page.goto(`/tutor/sessions/${SESSION_ID}/attendance`);
  await expect(
    main(page).getByText(/Đang sửa điểm danh\. Sửa được đến \d{2}\/\d{2}\/\d{4} \d{2}:\d{2}/),
  ).toBeVisible();
  await page
    .getByRole('radiogroup', { name: 'Trạng thái của Bình' })
    .getByLabel('Vắng có phép')
    .check();
  await page.getByRole('button', { name: 'Lưu bản sửa' }).click();
  await expect(main(page).getByText('Đã lưu bản sửa điểm danh.')).toBeVisible();
  expect(api.find('PUT', `/sessions/${SESSION_ID}/attendance`)[0].body).toMatchObject({
    records: [
      { studentId: STUDENT_A, status: 'PRESENT' },
      { studentId: STUDENT_B, status: 'EXCUSED' },
    ],
  });

  locked = true;
  await page.reload();
  await expect(
    main(page).getByText(/điểm danh bị khóa và không sửa được nữa; buổi bỏ lỡ này không tính phí/),
  ).toBeVisible();
  await expect(
    page.getByRole('radiogroup', { name: 'Trạng thái của An' }).getByLabel('Có mặt'),
  ).toBeDisabled();
  await expect(page.getByRole('button', { name: /Lưu/ })).toHaveCount(0);
});

test('a 409 lock from the API is explained even if the page did not know yet', async ({ page }) => {
  await asTutor(page, {
    'GET /sessions/:id/attendance': {
      body: sheet({}, [{ studentId: STUDENT_A, studentName: 'An', status: 'PRESENT', note: null }]),
    },
    'PUT /sessions/:id/attendance': {
      status: 409,
      body: { message: 'attendance is locked 48h after the session ends (BR-SC-03, BR-SC-09)' },
    },
  });
  await page.goto(`/tutor/sessions/${SESSION_ID}/attendance`);
  await page.getByRole('button', { name: 'Lưu bản sửa' }).click();
  await expect(main(page).getByRole('alert')).toHaveText(
    'Điểm danh đã bị khóa vì đã quá 48 giờ sau giờ kết thúc buổi học.',
  );
});

test("a Student's monthly attendance history on their page", async ({ page }) => {
  const api = await asTutor(page, {
    'GET /students/:id': {
      body: {
        id: STUDENT_A,
        tutorId: 't',
        fullName: 'An',
        email: null,
        dob: '2012-05-04',
        school: null,
        grade: null,
        status: 'ACTIVE',
        note: null,
        parents: [],
      },
    },
    'GET /students/:id/classes': {
      body: [
        {
          enrollmentId: 'e',
          status: 'ACTIVE',
          joinedAt: '2026-10-01',
          paymentDeadline: null,
          class: {
            id: CLASS_ID,
            name: 'Toán 8',
            subject: 'Toán',
            type: 'GROUP',
            feeType: 'PER_SESSION',
            tutorId: 't',
          },
        },
      ],
    },
    'GET /students/:id/attendance': (req) => ({
      body: {
        studentId: STUDENT_A,
        month: req.query.get('month'),
        summary: { PRESENT: 3, LATE: 1, EXCUSED: 0, ABSENT: 0 },
        records: [
          {
            sessionId: 's1',
            classId: CLASS_ID,
            date: '2026-11-03',
            startTime: '19:00',
            endTime: '20:30',
            status: 'LATE',
            note: 'Trễ 5 phút',
          },
        ],
      },
    }),
  });
  await page.goto(`/tutor/students/${STUDENT_A}`);
  const history = main(page).getByRole('region', { name: 'Chuyên cần' });
  await expect(history.getByText('Có mặt: 3')).toBeVisible();
  await expect(history.getByRole('cell', { name: 'Toán 8' })).toBeVisible();
  await expect(history.getByRole('cell', { name: '03/11/2026' })).toBeVisible();
  await history.getByLabel('Tháng').fill('2026-10');
  await expect
    .poll(() => api.find('GET', `/students/${STUDENT_A}/attendance`).at(-1)?.query.get('month'))
    .toBe('2026-10');
});
