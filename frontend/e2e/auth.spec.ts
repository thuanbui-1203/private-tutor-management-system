/**
 * Sign-in, Tutor sign-up, invitations, sign-out and role routing (#23, "Đăng nhập và tài khoản").
 */
import { expect, test } from '@playwright/test';
import { createUser, expectBearer, meOf, setClaims, signIn, stubApi, uidOf } from './support';

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

test('a wrong password shows a clear message and stays on the sign-in page', async ({ page }) => {
  const tutor = await createUser('TUTOR');
  await signIn(page, { ...tutor, password: 'sai-mat-khau' });
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Email hoặc mật khẩu không đúng.',
  );
  await expect(page).toHaveURL(/\/login/);
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
  await page.getByLabel('Email').fill(tutor.email);
  await page.getByLabel('Mật khẩu').fill(tutor.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
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

test('a Tutor signs up: Firebase account → POST /auth/register → refreshed role claim → Tutor home', async ({
  page,
}) => {
  const email = `new.tutor.${Date.now()}@example.com`;
  let registeredUid: string | undefined;
  const api = await stubApi(page, {
    // What Identity does: create users row, set role + userId claims.
    'POST /auth/register': async (req) => {
      registeredUid = uidOf(req.authorization);
      await setClaims(registeredUid!, { role: 'TUTOR', userId: crypto.randomUUID() });
      return { status: 201, body: { id: 'x', email, role: 'TUTOR', status: 'ACTIVE' } };
    },
    'GET /users/me': { body: { id: 'x', email, role: 'TUTOR', status: 'ACTIVE', createdAt: '' } },
  });
  await page.goto('/register');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('matkhau123');
  await page.getByLabel('Nhập lại mật khẩu').fill('matkhau123');
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await expect(page).toHaveURL(/\/tutor$/);
  expect(api.find('POST', '/auth/register')).toHaveLength(1);
  expect(registeredUid).toBeTruthy();
});

test('sign-up checks the password before creating anything', async ({ page }) => {
  const api = await stubApi(page, {});
  await page.goto('/register');
  await page.getByLabel('Email').fill(`x.${Date.now()}@example.com`);
  await page.getByLabel('Mật khẩu', { exact: true }).fill('ngan');
  await page.getByLabel('Nhập lại mật khẩu').fill('ngan');
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await expect(page.getByRole('main').getByRole('alert')).toHaveText(
    'Mật khẩu cần ít nhất 8 ký tự.',
  );
  expect(api.calls).toEqual([]);
});

test('an account without a role is sent to finish signing up', async ({ page }) => {
  const orphan = await createUser(null);
  await stubApi(page, {});
  await signIn(page, orphan);
  await expect(page).toHaveURL(/\/register\?complete=1/);
  await expect(page.getByRole('heading', { name: 'Hoàn tất đăng ký' })).toBeVisible();
});

test('accepting a valid invitation sets the password and signs in as a Parent', async ({
  page,
}) => {
  const email = `invited.${Date.now()}@example.com`;
  const api = await stubApi(page, {
    'GET /users/me': {
      body: { id: 'p', email: 'p', role: 'TUTOR', status: 'ACTIVE', createdAt: '' },
    },
    // What Identity does: activate the Firebase user with this password and its claims.
    'POST /auth/invitations/:token/accept': async (req) => {
      const password = (req.body as { password: string }).password;
      const res = await fetch(
        'http://127.0.0.1:9099/identitytoolkit.googleapis.com/v1/accounts:signUp?key=demo-key',
        {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ email, password, returnSecureToken: true }),
        },
      );
      const { localId } = await res.json();
      await setClaims(localId, { role: 'PARENT', userId: crypto.randomUUID() });
      return { body: { userId: 'u', email, role: 'PARENT', status: 'ACTIVE' } };
    },
  });
  // Someone else is still signed in on this browser (a shared computer): their token must not
  // be sent with the public accept call.
  const previous = await createUser('TUTOR');
  await signIn(page, previous);
  await expect(page).toHaveURL(/\/tutor$/);
  await page.goto('/invite/abc123');
  await page.getByLabel('Mật khẩu mới').fill('matkhau123');
  await page.getByLabel('Nhập lại mật khẩu').fill('matkhau123');
  await page.getByRole('button', { name: 'Kích hoạt và đăng nhập' }).click();
  await expect(page).toHaveURL(/\/parent$/);
  const [accept] = api.find('POST', '/auth/invitations/abc123/accept');
  expect(accept.body).toEqual({ password: 'matkhau123' });
  expect(accept.authorization).toBeUndefined(); // public endpoint, no token sent
});

test('an expired, used or revoked invitation says so', async ({ page }) => {
  await stubApi(page, {
    'POST /auth/invitations/:token/accept': { status: 410, body: { message: 'gone' } },
  });
  await page.goto('/invite/old-token');
  await page.getByLabel('Mật khẩu mới').fill('matkhau123');
  await page.getByLabel('Nhập lại mật khẩu').fill('matkhau123');
  await page.getByRole('button', { name: 'Kích hoạt và đăng nhập' }).click();
  await expect(page.getByRole('heading', { name: 'Lời mời không còn hiệu lực' })).toBeVisible();
});

test('forgot password sends the reset email without revealing whether the account exists', async ({
  page,
}) => {
  await page.goto('/forgot-password');
  await page.getByLabel('Email đăng nhập').fill(`nobody.${Date.now()}@example.com`);
  await page.getByRole('button', { name: 'Gửi liên kết đặt lại' }).click();
  await expect(page.getByText(/Nếu email có trong hệ thống/)).toBeVisible();
});
