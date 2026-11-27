/**
 * Sign-in, Tutor sign-up, invitations, sign-out and role routing (#23, "Đăng nhập và tài khoản").
 */
import { expect, test } from '@playwright/test';
import {
  createUser,
  expectBearer,
  meOf,
  passwordUser,
  resetMails,
  setClaims,
  signIn,
  stubApi,
  uidOf,
  verificationMails,
  verifyEmail,
} from './support';

test('a Tutor signs in and lands on the Tutor home; API calls carry the ID token', async ({
  page,
}) => {
  const tutor = await createUser('TUTOR');
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(tutor) } });
  await signIn(page, tutor);
  await expect(page).toHaveURL(/\/tutor$/);
  await expect(page.getByRole('heading', { name: 'Tổng quan giáo viên' })).toBeVisible();
  await expect(page.getByText(`Xin chào ${tutor.email} · Giáo viên.`)).toBeVisible();
  expect(api.find('GET', '/users/me').length).toBeGreaterThan(0);
  expectBearer(api.calls, tutor);
});

test('each role lands on its own home', async ({ page }) => {
  for (const [role, path, heading] of [
    ['PARENT', '/parent', 'Lịch học của An'],
    ['STUDENT', '/student', 'Lịch học của An'],
    ['ADMIN', '/admin', 'Giáo viên'],
  ] as const) {
    const user = await createUser(role);
    const an = { id: 'st1', fullName: 'An', parents: [], status: 'ACTIVE', dob: '2012-01-01' };
    await stubApi(page, {
      'GET /users/me': { body: meOf(user) },
      'GET /users': { body: [] },
      'GET /parents/me/children': { body: [an] },
      'GET /students/me': { body: an },
      'GET /students/:id/classes': { body: [] },
      'GET /sessions': { body: [] },
    });
    await signIn(page, user);
    await expect(page).toHaveURL(new RegExp(`${path}$`));
    await expect(page.getByRole('heading', { name: heading })).toBeVisible();
    await page.getByRole('button', { name: 'Đăng xuất' }).click();
    await expect(page).toHaveURL(/\/login$/);
  }
});

test("another role's pages show 'no permission'", async ({ page }) => {
  const parent = await createUser('PARENT');
  await stubApi(page, {});
  await signIn(page, parent);
  await expect(page).toHaveURL(/\/parent$/);
  await page.goto('/tutor');
  await expect(
    page.getByRole('heading', { name: 'Bạn không có quyền xem trang này' }),
  ).toBeVisible();
  await page.getByRole('link', { name: 'Về trang của tôi' }).click();
  await expect(page).toHaveURL(/\/parent$/);
});

test('signed out: protected pages send you to sign in, and back afterwards', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  await stubApi(page, { 'GET /users/me': { body: meOf(tutor) } });
  await page.goto('/tutor');
  await expect(page).toHaveURL(/\/login\?next=%2Ftutor/);
  await page.getByLabel('Email Google (giả lập)').fill(tutor.email);
  await page.getByRole('button', { name: 'Đăng nhập với Google' }).click();
  await expect(page).toHaveURL(/\/tutor$/);
  await page.reload(); // the session survives a reload
  await expect(page.getByRole('heading', { name: 'Tổng quan giáo viên' })).toBeVisible();
});

test('a 401 from the API (revoked session) signs out with an explanation', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  await stubApi(page, { 'GET /users/me': { status: 401, body: { message: 'revoked' } } });
  await signIn(page, tutor);
  await expect(page).toHaveURL(/\/login\?reason=session/);
  await expect(page.getByText(/Phiên đăng nhập của bạn đã hết hạn hoặc bị thu hồi/)).toBeVisible();
  await page.goto('/tutor');
  await expect(page).toHaveURL(/\/login/); // really signed out
});

test('a 403 from the API shows the no-permission view', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  await stubApi(page, { 'GET /users/me': { status: 403, body: { message: 'forbidden' } } });
  await signIn(page, tutor);
  await expect(
    page.getByRole('heading', { name: 'Bạn không có quyền xem nội dung này' }),
  ).toBeVisible();
});

test('a 5xx shows a friendly retry message', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  let healthy = false; // the service is down until the test brings it back
  await stubApi(page, {
    'GET /users/me': () => (healthy ? { body: meOf(tutor) } : { status: 503 }),
  });
  await signIn(page, tutor);
  await expect(page.getByRole('main').getByRole('alert')).toContainText('tạm thời không phản hồi');
  healthy = true;
  await page.getByRole('button', { name: 'Thử lại' }).click();
  await expect(page.getByText(`Xin chào ${tutor.email}`)).toBeVisible();
});

for (const [role, label, home] of [
  ['TUTOR', 'Tôi là gia sư', /\/tutor$/],
  ['STUDENT', 'Tôi là học sinh', /\/student$/],
  ['PARENT', 'Tôi là phụ huynh', /\/parent$/],
] as const) {
  test(`first Google sign-in: choosing ${role} registers and lands on that home`, async ({
    page,
  }) => {
    const email = `new.${role.toLowerCase()}.${Date.now()}@example.com`;
    const api = await stubApi(page, {
      // What Identity does: create the users row, set the role + userId claims.
      'POST /auth/register': async (req) => {
        await setClaims(uidOf(req.authorization)!, { role, userId: crypto.randomUUID() });
        return { status: 201, body: { id: 'x', email, role, status: 'ACTIVE' } };
      },
      'GET /users/me': { body: { id: 'x', email, role, status: 'ACTIVE', createdAt: '' } },
      'GET /parents/me/children': { body: [] },
      'GET /students/me': { status: 404, body: { message: 'none' } },
    });
    await page.goto('/login');
    await page.getByLabel('Email Google (giả lập)').fill(email);
    await page.getByRole('button', { name: 'Đăng nhập với Google' }).click();
    await expect(page).toHaveURL(/\/register\?complete=1/);
    await page.getByRole('button', { name: label }).click();
    await expect(page).toHaveURL(home);
    expect(api.find('POST', '/auth/register').map((c) => c.body)).toEqual([{ role }]);
  });
}

test('there is no way to choose Admin', async ({ page }) => {
  const orphan = await createUser(null);
  await stubApi(page, {});
  await signIn(page, orphan);
  await expect(page.getByRole('heading', { name: 'Hoàn tất đăng ký' })).toBeVisible();
  await expect(page.getByRole('button', { name: /quản trị/i })).toHaveCount(0);
});

test('sign-up with an e-mail: verify the address first, then choose a role', async ({ page }) => {
  const email = `pw.${Date.now()}@example.com`;
  const api = await stubApi(page, {
    'POST /auth/register': async (req) => {
      await setClaims(uidOf(req.authorization)!, { role: 'PARENT', userId: crypto.randomUUID() });
      return { status: 201, body: { id: 'x', email, role: 'PARENT', status: 'ACTIVE' } };
    },
    'GET /users/me': { body: { id: 'x', email, role: 'PARENT', status: 'ACTIVE', createdAt: '' } },
    'GET /parents/me/children': { body: [] },
  });
  await page.goto('/register');
  await page.getByLabel('Email', { exact: true }).fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('short');
  await expect(page.getByText('Mật khẩu cần ít nhất 8 ký tự.')).toBeVisible();
  await page.getByLabel('Mật khẩu', { exact: true }).fill('mot-mat-khau-dai');
  await page.getByLabel('Nhập lại mật khẩu').fill('mot-mat-khau-khac');
  await expect(page.getByText('Hai mật khẩu chưa khớp.')).toBeVisible();
  const create = page.getByRole('button', { name: 'Tạo tài khoản bằng email' });
  await expect(create).toBeDisabled();
  await page.getByLabel('Nhập lại mật khẩu').fill('mot-mat-khau-dai');
  await create.click();

  // Held until the address is verified; nothing reaches the API meanwhile.
  await expect(page.getByRole('heading', { name: 'Xác minh email của bạn' })).toBeVisible();
  await expect(page.getByText(email)).toBeVisible();
  expect(await verificationMails(email)).toBe(1);
  await page.getByRole('button', { name: 'Tôi đã xác minh xong' }).click();
  await expect(page.getByText('Email vẫn chưa được xác minh')).toBeVisible();
  await page.getByRole('button', { name: 'Gửi lại thư' }).click();
  await expect(page.getByText('Đã gửi lại thư xác minh.')).toBeVisible();
  expect(api.calls).toEqual([]);

  await verifyEmail(email); // the person opens the link in the e-mail
  await page.getByRole('button', { name: 'Tôi đã xác minh xong' }).click();
  await expect(page.getByRole('heading', { name: 'Hoàn tất đăng ký' })).toBeVisible();
  await page.getByRole('button', { name: 'Tôi là phụ huynh' }).click();
  await expect(page).toHaveURL(/\/parent$/);
});

test('sign-in with an e-mail: wrong password, then the right one', async ({ page }) => {
  const tutor = await passwordUser('TUTOR', 'mat-khau-gia-su-1');
  await stubApi(page, { 'GET /users/me': { body: meOf(tutor) } });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(tutor.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('sai-mat-khau');
  await page.getByRole('button', { name: 'Đăng nhập bằng email' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText(
    'Email hoặc mật khẩu không đúng',
  );
  await page.getByLabel('Mật khẩu', { exact: true }).fill('mat-khau-gia-su-1');
  await page.getByRole('button', { name: 'Đăng nhập bằng email' }).click();
  await expect(page).toHaveURL(/\/tutor$/);
});

test('an unverified password account with a role is held at the verification step', async ({
  page,
}) => {
  const tutor = await passwordUser('TUTOR', 'mat-khau-gia-su-2', false);
  const api = await stubApi(page, { 'GET /users/me': { body: meOf(tutor) } });
  await page.goto('/login');
  await page.getByLabel('Email', { exact: true }).fill(tutor.email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('mat-khau-gia-su-2');
  await page.getByRole('button', { name: 'Đăng nhập bằng email' }).click();
  await expect(page.getByRole('heading', { name: 'Xác minh email của bạn' })).toBeVisible();
  await page.goto('/tutor'); // the app does not let it in either
  await expect(page.getByRole('heading', { name: 'Xác minh email của bạn' })).toBeVisible();
  expect(api.calls).toEqual([]);
  await page.getByRole('button', { name: 'Dùng tài khoản khác' }).click();
  await expect(page.getByRole('button', { name: 'Đăng nhập bằng email' })).toBeVisible();
});

test('forgot password sends a reset link without saying whether the address exists', async ({
  page,
}) => {
  const tutor = await passwordUser('TUTOR', 'mat-khau-gia-su-3');
  await stubApi(page, {});
  await page.goto('/login');
  await page.getByRole('button', { name: 'Quên mật khẩu?' }).click();
  await page.getByLabel('Email', { exact: true }).fill(tutor.email);
  await page.getByRole('button', { name: 'Gửi liên kết đặt lại' }).click();
  await expect(page.getByText(/thư đặt lại mật khẩu đã được gửi/)).toBeVisible();
  expect(await resetMails(tutor.email)).toBe(1);
  await page.getByRole('button', { name: '← Quay lại đăng nhập' }).click();
  await expect(page.getByRole('button', { name: 'Đăng nhập bằng email' })).toBeVisible();
});

test('an invited address is told to open its invitation', async ({ page }) => {
  const invited = await createUser(null);
  await stubApi(page, {
    'POST /auth/register': { status: 409, body: { message: 'invited', code: 'INVITED' } },
  });
  await signIn(page, invited);
  await page.getByRole('button', { name: 'Tôi là phụ huynh' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('email lời mời');
});

test('signing in never sends you to another site', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  await stubApi(page, { 'GET /users/me': { body: meOf(tutor) } });
  await page.goto('/login?next=//evil.example/steal');
  await page.getByLabel('Email Google (giả lập)').fill(tutor.email);
  await page.getByRole('button', { name: 'Đăng nhập với Google' }).click();
  await expect(page).toHaveURL(/localhost:\d+\/tutor$/);
});

test('an invitation is accepted as the Google account chosen now, not as whoever was signed in', async ({
  page,
}) => {
  const invited = await createUser(null);
  const api = await stubApi(page, {
    'GET /users/me': {
      body: { id: 'p', email: 'p', role: 'TUTOR', status: 'ACTIVE', createdAt: '' },
    },
    'POST /auth/invitations/:token/accept': async (req) => {
      await setClaims(uidOf(req.authorization)!, { role: 'PARENT', userId: crypto.randomUUID() });
      return { body: { userId: 'u', email: invited.email, role: 'PARENT', status: 'ACTIVE' } };
    },
    'GET /parents/me/children': { body: [] },
  });
  // Someone else is still signed in on this browser (a shared computer).
  const previous = await createUser('TUTOR');
  await signIn(page, previous);
  await expect(page).toHaveURL(/\/tutor$/);
  await page.goto('/invite/abc123');
  await page.getByLabel('Email Google (giả lập)').fill(invited.email);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page).toHaveURL(/\/parent$/);
  const [accept] = api.find('POST', '/auth/invitations/abc123/accept');
  expect(uidOf(accept.authorization)).toBe(invited.uid);
});

test('an invitation for another address, or a dead one, says so', async ({ page }) => {
  const someone = await createUser(null);
  let status = 403;
  await stubApi(page, {
    'POST /auth/invitations/:token/accept': () => ({ status, body: { message: 'no' } }),
  });
  await page.goto('/invite/old-token');
  await page.getByLabel('Email Google (giả lập)').fill(someone.email);
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toContainText('địa chỉ email khác');
  status = 410;
  await page.getByRole('button', { name: 'Kích hoạt bằng Google' }).click();
  await expect(page.getByRole('heading', { name: 'Lời mời không còn hiệu lực' })).toBeVisible();
});
