/**
 * Tutor profiles (docs/07 §2): the Tutor fills in and submits their profile with a credential
 * file; the Admin reviews it item by item.
 */
import { expect, test, type Page } from '@playwright/test';
import { createUser, meOf, signIn, stubApi, type Role, type TestUser } from './support';

const TUTOR_ID = '11111111-1111-4111-8111-111111111111';
const CRED = '22222222-2222-4222-8222-222222222222';
const SUBJ = '33333333-3333-4333-8333-333333333333';

const users: Partial<Record<Role, TestUser>> = {};
async function as(role: Role, page: Page, stubs: Parameters<typeof stubApi>[1]) {
  users[role] ??= await createUser(role);
  const user = users[role]!;
  const api = await stubApi(page, {
    'GET /users/me': { body: meOf(user) },
    'GET /tutors/locations/provinces': {
      body: [
        { code: 1, name: 'Thành phố Hà Nội' },
        { code: 79, name: 'Thành phố Hồ Chí Minh' },
      ],
    },
    'GET /tutors/locations/provinces/79/wards': {
      body: [{ code: 26740, name: 'Phường Sài Gòn' }],
    },
    ...stubs,
  });
  await signIn(page, user);
  return api;
}
const main = (page: Page) => page.getByRole('main');

const empty = {
  tutorId: TUTOR_ID,
  status: 'DRAFT',
  kind: null,
  displayName: null,
  bio: null,
  school: null,
  schoolCountry: null,
  reportedToPrincipal: false,
  noOwnPupils: false,
  gpa: null,
  gpaScale: null,
  transcriptPublic: false,
  submittedAt: null,
  verifiedAt: null,
  credentials: [],
  subjects: [],
  areas: [],
  availability: [],
};
const credential = (over: object = {}) => ({
  id: CRED,
  kind: 'STUDENT_CARD',
  title: 'Thẻ sinh viên',
  issuer: 'ĐH Sư phạm',
  country: 'VN',
  number: 'SV-1',
  issuedOn: null,
  expiresOn: null,
  status: 'PENDING',
  reviewNote: null,
  file: { name: 'the.pdf', mime: 'application/pdf', size: 20 },
  ...over,
});
const subject = (over: object = {}) => ({
  id: SUBJ,
  subject: 'Toán',
  gradeFrom: 6,
  gradeTo: 9,
  suggestedFee: 200000,
  status: 'PENDING',
  reviewNote: null,
  ...over,
});

test('a Tutor fills in the profile, uploads a credential file and is told what is missing', async ({
  page,
}) => {
  let profile: Record<string, unknown> = { ...empty };
  const api = await as('TUTOR', page, {
    'GET /tutors/me': () => ({ body: profile }),
    'PUT /tutors/me': ({ body }) => {
      profile = { ...profile, ...(body as object), subjects: [subject()] };
      return { body: profile };
    },
    'POST /tutors/me/credentials': () => {
      profile = { ...profile, credentials: [credential()] };
      return { status: 201, body: profile };
    },
    'POST /tutors/me/submit': {
      status: 422,
      body: { message: 'the profile is not complete', missing: ['areas'] },
    },
  });
  await page.getByRole('link', { name: 'Hồ sơ' }).click();
  await expect(main(page).getByText('Đang soạn')).toBeVisible();

  const form = main(page).getByRole('form', { name: 'Thông tin gia sư' });
  await form.getByLabel('Bạn là').selectOption('STUDENT');
  await form.getByLabel('Tên hiển thị').fill('Nguyễn Văn An');
  await form.getByLabel('Trường', { exact: true }).fill('ĐH Sư phạm');
  await form.getByRole('button', { name: 'Thêm môn' }).click();
  await form.getByLabel('Môn', { exact: true }).fill('Toán');
  await form.getByLabel('Từ lớp').fill('6');
  await form.getByLabel('Đến lớp').fill('9');
  await form.getByRole('button', { name: 'Thêm giờ rảnh' }).click();
  await form.getByRole('button', { name: 'Lưu thông tin' }).click();
  await expect(form.getByText('Đã lưu.')).toBeVisible();
  expect(api.find('PUT', '/tutors/me')[0].body).toMatchObject({
    kind: 'STUDENT',
    displayName: 'Nguyễn Văn An',
    school: 'ĐH Sư phạm',
    schoolCountry: 'VN',
    subjects: [{ subject: 'Toán', gradeFrom: 6, gradeTo: 9, suggestedFee: null }],
    availability: [{ weekday: 2, startTime: '18:00', endTime: '20:00' }],
  });

  const creds = main(page).getByRole('region', { name: 'Minh chứng' });
  await creds.getByLabel('Tên minh chứng').fill('Thẻ sinh viên');
  await creds.getByLabel('Nơi cấp', { exact: true }).fill('ĐH Sư phạm');
  await creds.getByLabel(/^Tệp/).setInputFiles({
    name: 'the.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4 the sinh vien'),
  });
  await creds.getByRole('button', { name: 'Tải lên' }).click();
  await expect(creds.getByRole('row', { name: /Thẻ sinh viên/ })).toContainText('Chờ duyệt');
  const sent = api.find('POST', '/tutors/me/credentials')[0].body as {
    file: { name: string; contentBase64: string };
  };
  expect(sent.file.name).toBe('the.pdf');
  expect(Buffer.from(sent.file.contentBase64, 'base64').toString()).toBe('%PDF-1.4 the sinh vien');

  await main(page).getByRole('button', { name: 'Gửi duyệt' }).click();
  await expect(main(page).getByRole('alert')).toContainText('Còn thiếu: areas');
});

test('a file over 5 MB is stopped before it is sent', async ({ page }) => {
  const api = await as('TUTOR', page, { 'GET /tutors/me': { body: empty } });
  await page.goto('/tutor/profile');
  const creds = main(page).getByRole('region', { name: 'Minh chứng' });
  await creds.getByLabel('Tên minh chứng').fill('Bằng');
  await creds.getByLabel('Nơi cấp', { exact: true }).fill('ĐH');
  await creds.getByLabel(/^Tệp/).setInputFiles({
    name: 'big.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.alloc(5 * 1024 * 1024 + 1),
  });
  await expect(creds.getByRole('alert')).toContainText('lớn hơn 5 MB');
  await expect(creds.getByRole('button', { name: 'Tải lên' })).toBeDisabled();
  expect(api.find('POST', '/tutors/me/credentials')).toHaveLength(0);
});

test('while under review the profile is read-only', async ({ page }) => {
  await as('TUTOR', page, {
    'GET /tutors/me': { body: { ...empty, status: 'SUBMITTED', credentials: [credential()] } },
  });
  await page.goto('/tutor/profile');
  await expect(main(page).getByText('đang chờ quản trị viên duyệt')).toBeVisible();
  await expect(main(page).getByRole('button', { name: 'Lưu thông tin' })).toBeDisabled();
  await expect(main(page).getByRole('button', { name: 'Tải lên' })).toHaveCount(0);
  await expect(main(page).getByRole('button', { name: 'Gửi duyệt' })).toHaveCount(0);
});

test('Admin decides each item, then verifies the profile', async ({ page }) => {
  let profile: Record<string, unknown> = {
    ...empty,
    status: 'SUBMITTED',
    kind: 'STUDENT',
    displayName: 'Nguyễn Văn An',
    school: 'ĐH Sư phạm',
    schoolCountry: 'VN',
    submittedAt: '2026-11-26T03:00:00.000Z',
    credentials: [credential()],
    subjects: [subject()],
    areas: [{ kind: 'ONLINE' }],
    reviews: [],
  };
  const api = await as('ADMIN', page, {
    'GET /tutors': {
      body: [
        {
          tutorId: TUTOR_ID,
          displayName: 'Nguyễn Văn An',
          kind: 'STUDENT',
          status: 'SUBMITTED',
          submittedAt: '2026-11-26T03:00:00.000Z',
          pendingCredentials: 1,
          pendingSubjects: 1,
        },
      ],
    },
    'GET /tutors/:id': () => ({ body: profile }),
    'POST /tutors/:id/review': () => {
      profile = {
        ...profile,
        status: 'VERIFIED',
        credentials: [credential({ status: 'VERIFIED' })],
        subjects: [subject({ status: 'VERIFIED' })],
        reviews: [
          {
            decision: 'VERIFY',
            reason: null,
            reviewerId: 'a',
            createdAt: '2026-11-26T04:00:00.000Z',
          },
        ],
      };
      return { body: profile };
    },
  });
  await page.getByRole('link', { name: 'Duyệt gia sư' }).click();
  await expect(main(page).getByRole('row', { name: /Nguyễn Văn An/ })).toContainText('2');
  await main(page).getByRole('button', { name: 'Xem hồ sơ' }).click();
  const card = main(page).getByRole('region', { name: 'Hồ sơ gia sư' });
  const decisions = card.getByLabel('Quyết định');
  await decisions.nth(0).selectOption('VERIFIED');
  await decisions.nth(1).selectOption('VERIFIED');
  await card.getByLabel('Ghi chú').first().fill('Thẻ rõ');
  await card.getByRole('button', { name: 'Xác minh' }).click();
  await expect(card.getByText('Đã xác minh.')).toBeVisible();
  expect(api.find('POST', `/tutors/${TUTOR_ID}/review`)[0].body).toEqual({
    decision: 'VERIFY',
    reason: null,
    credentials: [{ id: CRED, status: 'VERIFIED', note: 'Thẻ rõ' }],
    subjects: [{ id: SUBJ, status: 'VERIFIED', note: null }],
  });
  await expect(card.getByRole('button', { name: 'Tạm khóa' })).toBeVisible();
});

test('a teaching area is picked from the province and ward lists', async ({ page }) => {
  let profile: Record<string, unknown> = { ...empty };
  const api = await as('TUTOR', page, {
    'GET /tutors/me': () => ({ body: profile }),
    'PUT /tutors/me': ({ body }) => {
      profile = { ...profile, ...(body as object) };
      return { body: profile };
    },
  });
  await page.goto('/tutor/profile');
  const form = main(page).getByRole('form', { name: 'Thông tin gia sư' });
  await form.getByLabel('Tỉnh/Thành phố').selectOption('79');
  await form.getByLabel('Phường/Xã').selectOption('26740');
  await form.getByRole('button', { name: 'Thêm khu vực' }).click();
  await expect(form.getByText('Phường Sài Gòn, Thành phố Hồ Chí Minh')).toBeVisible();
  await form.getByLabel('Tỉnh/Thành phố').selectOption('1');
  await form.getByRole('button', { name: 'Thêm khu vực' }).click();
  await expect(form.getByText('Thành phố Hà Nội (cả tỉnh)')).toBeVisible();
  await form.getByRole('button', { name: 'Lưu thông tin' }).click();
  await expect(form.getByText('Đã lưu.')).toBeVisible();
  expect(api.find('PUT', '/tutors/me')[0].body).toMatchObject({
    areas: [
      { kind: 'LOCAL', provinceCode: 79, wardCode: 26740 },
      { kind: 'LOCAL', provinceCode: 1, wardCode: null },
    ],
  });
});
