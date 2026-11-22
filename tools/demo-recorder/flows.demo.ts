/**
 * Demo videos: each test is one flow, recorded to recordings/<name>.webm.
 * Data each flow needs but does not demonstrate is created first through the gateway API
 * (off camera); everything shown is the real frontend against the real services.
 * Moving the clock (7-day deadline, month close) uses the e2e test hooks, announced on screen.
 */
import { execSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test, type Page } from '@playwright/test';

const OUT = process.env.DEMO_OUT ?? join(__dirname, '..', '..', 'recordings');
mkdirSync(OUT, { recursive: true });
const GATEWAY = 'http://127.0.0.1:28080/api';
const EMULATOR = 'http://127.0.0.1:29099';
const HOOKS = {
  class: 'http://127.0.0.1:23003',
  schedule: 'http://127.0.0.1:23004',
  billing: 'http://127.0.0.1:23006',
};
const COMPOSE =
  'docker compose -p tms-e2e --project-directory . -f tools/demo-recorder/base.compose.yml -f docker-compose.e2e.yml -f tools/demo-recorder/docker-compose.demo.yml';
const ROOT = join(__dirname, '..', '..');
const PASSWORD = 'matkhau123';
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ------------------------------------------------------------------ dates (Vietnam)
const vnDate = (d = new Date()) => new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);
const addDays = (date: string, n: number) => {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + n)).toISOString().slice(0, 10);
};
const nextPeriod = (p: string) => {
  const [y, m] = p.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
};
/** ISO weekday 1..7 of a YYYY-MM-DD. */
const weekdayOf = (date: string) => {
  const d = new Date(`${date}T00:00:00Z`).getUTCDay();
  return d === 0 ? 7 : d;
};

// ------------------------------------------------------------------ API (off camera)
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = any;
async function call(url: string, init: RequestInit = {}): Promise<{ status: number; body: Json }> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: Json = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* text */
  }
  return { status: res.status, body };
}
const post = (body: unknown): RequestInit => ({
  method: 'POST',
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});
async function emulator(path: string, body: unknown) {
  const r = await call(
    `${EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=demo-key`,
    post(body),
  );
  if (r.status !== 200) throw new Error(`emulator ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
async function eventually<T>(check: () => Promise<T>, timeoutMs = 45_000, every = 700) {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (e) {
      last = e;
      await new Promise((r) => setTimeout(r, every));
    }
  }
  throw last;
}

class Api {
  constructor(
    public token: string,
    readonly email: string,
  ) {}
  async req(method: string, path: string, body?: unknown) {
    const r = await call(`${GATEWAY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    return r;
  }
  async ok(method: string, path: string, body?: unknown) {
    const r = await this.req(method, path, body);
    if (r.status >= 300) throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

async function signInApi(email: string, password = PASSWORD) {
  const { idToken } = await emulator('accounts:signInWithPassword', {
    email,
    password,
    returnSecureToken: true,
  });
  return new Api(idToken, email);
}
/** A Tutor account: Firebase sign-up → POST /auth/register → token with claims. */
async function newTutor(name: string) {
  const email = `${name}.${randomUUID().slice(0, 4)}@demo.test`;
  const { idToken } = await emulator('accounts:signUp', {
    email,
    password: PASSWORD,
    returnSecureToken: true,
  });
  const r = await new Api(idToken, email).ok('POST', '/auth/register', {});
  void r;
  return signInApi(email);
}
const adminApi = () => signInApi('admin@tms.local', 'Admin@123');

async function newStudent(tutor: Api, fullName: string, parentName: string, invite = false) {
  const parentEmail = `phuhuynh.${randomUUID().slice(0, 4)}@demo.test`;
  const s = await tutor.ok('POST', '/students', {
    fullName,
    dob: '2012-05-04',
    grade: 8,
    school: 'THCS Lê Lợi',
    invite,
    parents: [{ fullName: parentName, phone: '0901234567', email: parentEmail, isPrimary: true }],
  });
  return { ...(s as { id: string; fullName: string }), parentEmail };
}
async function newClass(tutor: Api, name: string, feeType: 'MONTHLY' | 'PER_SESSION', fee: number) {
  return (await tutor.ok('POST', '/classes', {
    name,
    subject: 'Toán',
    type: 'GROUP',
    maxStudents: 6,
    feeType,
    feeAmount: fee,
    chargeAbsent: true,
  })) as { id: string; name: string };
}
/** Weekly Schedule from tomorrow (retries while the Class reaches schedule-service). */
async function weeklySchedule(tutor: Api, classId: string, startTime: string, endTime: string) {
  const from = addDays(vnDate(), 1);
  return eventually(() =>
    tutor.ok('POST', '/schedules', {
      classId,
      weekday: weekdayOf(from),
      startTime,
      endTime,
      fromDate: from,
    }),
  );
}
async function oneOff(tutor: Api, classId: string, date: string, startTime: string, endTime: string) {
  return eventually(() => tutor.ok('POST', '/sessions', { classId, date, startTime, endTime }));
}
async function enroll(tutor: Api, classId: string, studentId: string) {
  return eventually(() =>
    tutor.ok('POST', `/classes/${classId}/enrollments`, { studentId }),
  ) as Promise<{ id: string; status: string }>;
}
async function hook(service: keyof typeof HOOKS, path: string, body?: unknown) {
  const r = await call(
    `${HOOKS[service]}/internal/test/${path}`,
    body === undefined ? {} : post(body),
  );
  if (r.status >= 300) throw new Error(`hook ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
function compose(args: string) {
  execSync(`${COMPOSE} ${args}`, {
    cwd: ROOT,
    stdio: 'pipe',
    env: { ...process.env, COMPOSE_BAKE: 'false' },
  });
}
/** The invitation link identity-service logged for an e-mail (dev mode only). */
function invitationToken(email: string) {
  const logs = execSync('docker logs tms-e2e-identity-service-1 2>&1', {
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  });
  const line = logs
    .split('\n')
    .reverse()
    .find((l) => l.includes(`invitation for ${email}`));
  const token = line?.match(/\/invitations\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`no invitation link for ${email}`);
  return token;
}

// ------------------------------------------------------------------ on-screen narration
const OVERLAY = `
(() => {
  const css = \`
    #demo-caption{position:fixed;left:50%;bottom:22px;transform:translateX(-50%);z-index:2147483646;
      max-width:82%;background:rgba(17,24,39,.92);color:#fff;font:600 19px/1.45 system-ui,'Segoe UI',sans-serif;
      padding:12px 22px;border-radius:12px;box-shadow:0 6px 24px rgba(0,0,0,.35);text-align:center;pointer-events:none}
    #demo-caption:empty{display:none}
    #demo-caption .sys{color:#fbbf24}
    #demo-cursor{position:fixed;z-index:2147483647;width:22px;height:22px;margin:-11px 0 0 -11px;border-radius:50%;
      background:rgba(239,68,68,.35);border:2px solid rgba(239,68,68,.9);pointer-events:none;transition:transform .12s;left:-50px;top:-50px}
    #demo-cursor.down{transform:scale(.6);background:rgba(239,68,68,.7)}
    #demo-title{position:fixed;inset:0;z-index:2147483647;display:flex;flex-direction:column;align-items:center;justify-content:center;
      background:linear-gradient(135deg,#1e3a8a,#0f172a);color:#fff;font-family:system-ui,'Segoe UI',sans-serif;text-align:center;padding:40px}
    #demo-title h1{font-size:44px;margin:0 0 18px} #demo-title p{font-size:22px;opacity:.85;max-width:900px;margin:4px 0}
    #demo-title .tag{font-size:16px;letter-spacing:.12em;text-transform:uppercase;opacity:.6;margin-bottom:20px}\`;
  const mount = () => {
    if (document.getElementById('demo-caption')) return;
    const st = document.createElement('style'); st.textContent = css; document.documentElement.appendChild(st);
    const cap = document.createElement('div'); cap.id = 'demo-caption';
    cap.innerHTML = sessionStorage.getItem('demo-caption') || '';
    document.documentElement.appendChild(cap);
    const cur = document.createElement('div'); cur.id = 'demo-cursor';
    const pos = JSON.parse(sessionStorage.getItem('demo-cursor') || 'null');
    if (pos) { cur.style.left = pos[0] + 'px'; cur.style.top = pos[1] + 'px'; }
    document.documentElement.appendChild(cur);
    addEventListener('mousemove', e => { cur.style.left = e.clientX + 'px'; cur.style.top = e.clientY + 'px';
      sessionStorage.setItem('demo-cursor', JSON.stringify([e.clientX, e.clientY])); }, true);
    addEventListener('mousedown', () => cur.classList.add('down'), true);
    addEventListener('mouseup', () => cur.classList.remove('down'), true);
  };
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount); else mount();
})();`;

async function say(page: Page, html: string, ms = 2200) {
  await page.evaluate((h) => {
    sessionStorage.setItem('demo-caption', h);
    const el = document.getElementById('demo-caption');
    if (el) el.innerHTML = h;
  }, html);
  await page.waitForTimeout(ms);
}
/** Narration for something the system does behind the scenes (shown in amber). */
const system = (page: Page, text: string, ms = 2800) =>
  say(page, `<span class="sys">⚙ ${text}</span>`, ms);

async function titleCard(page: Page, n: number, title: string, lines: string[]) {
  await page.goto('/login');
  await page.evaluate(
    ({ n, title, lines }) => {
      const el = document.createElement('div');
      el.id = 'demo-title';
      el.innerHTML =
        `<div class="tag">TMS · Luồng ${n}</div><h1>${title}</h1>` +
        lines.map((l) => `<p>${l}</p>`).join('');
      document.documentElement.appendChild(el);
    },
    { n, title, lines },
  );
  await page.waitForTimeout(4200);
  await page.evaluate(() => document.getElementById('demo-title')?.remove());
}
async function endCard(page: Page, text: string) {
  await say(page, `✔ ${text}`, 3500);
}

const main = (page: Page) => page.getByRole('main');
const nav = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Menu chính' }).getByRole('link', { name, exact: true });
/** Scrolls the class roster ("Danh sách lớp") to the top of the screen, smoothly. */
async function showRoster(page: Page) {
  await page
    .getByRole('heading', { name: 'Danh sách lớp' })
    .evaluate((e) => window.scrollTo({ top: e.getBoundingClientRect().top + scrollY - 70, behavior: 'smooth' }));
  await page.waitForTimeout(900);
}
async function signIn(page: Page, email: string, password = PASSWORD) {
  if (!page.url().endsWith('/login')) await page.goto('/login');
  await page.getByLabel('Email').pressSequentially(email, { delay: 25 });
  await page.getByLabel('Mật khẩu').pressSequentially(password, { delay: 40 });
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}
async function signOut(page: Page) {
  await page.getByRole('button', { name: 'Đăng xuất' }).click();
  await expect(page).toHaveURL(/\/login/);
}
async function type(page: Page, label: string, value: string, exact = false) {
  const f = page.getByLabel(label, { exact });
  await f.click();
  await f.pressSequentially(value, { delay: 30 });
}

// ------------------------------------------------------------------ the flows
test.beforeEach(async ({ context }) => {
  await context.addInitScript(OVERLAY);
});
test.afterEach(async ({ page }, info) => {
  const video = page.video();
  await page.waitForTimeout(800);
  await page.close();
  await video?.saveAs(join(OUT, `${info.title.split(' ')[0]}.webm`));
});

test('01-dang-ky-dang-nhap-phan-quyen', async ({ page }) => {
  const email = `co.mai.${randomUUID().slice(0, 4)}@demo.test`;
  await titleCard(page, 1, 'Đăng ký, đăng nhập và phân quyền', [
    'Giáo viên tự đăng ký → Firebase Authentication + Identity Service gán vai trò TUTOR',
    'Sai mật khẩu, đăng xuất, và chặn truy cập trang của vai trò khác',
  ]);
  await say(page, 'Giáo viên mới chưa có tài khoản: bấm "Đăng ký"');
  await page.getByRole('link', { name: 'Đăng ký' }).click();
  await type(page, 'Email', email);
  await type(page, 'Mật khẩu', 'ngan', true);
  await type(page, 'Nhập lại mật khẩu', 'ngan');
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await say(page, 'Mật khẩu quá ngắn: frontend chặn ngay, chưa gửi request nào');
  await page.getByLabel('Mật khẩu', { exact: true }).fill('');
  await page.getByLabel('Nhập lại mật khẩu').fill('');
  await type(page, 'Mật khẩu', PASSWORD, true);
  await type(page, 'Nhập lại mật khẩu', PASSWORD);
  await page.getByRole('button', { name: 'Đăng ký' }).click();
  await system(
    page,
    'Firebase tạo tài khoản → POST /api/auth/register qua API Gateway → Identity Service lưu user và gán custom claim role=TUTOR',
    3500,
  );
  await expect(page).toHaveURL(/\/tutor$/);
  await expect(main(page).getByRole('heading', { name: 'Tổng quan giáo viên' })).toBeVisible();
  await say(page, 'Đăng ký xong, vào thẳng trang Tổng quan của giáo viên');
  await signOut(page);
  await say(page, 'Đăng xuất. Thử đăng nhập với mật khẩu sai');
  await signIn(page, email, 'sai-mat-khau');
  await expect(main(page).getByRole('alert')).toBeVisible();
  await say(page, 'Sai mật khẩu: báo lỗi rõ ràng, vẫn ở trang đăng nhập');
  await page.getByLabel('Email').fill('');
  await page.getByLabel('Mật khẩu').fill('');
  await signIn(page, email);
  await expect(page).toHaveURL(/\/tutor$/);
  await say(page, 'Đăng nhập đúng → trang giáo viên');
  await say(page, 'Thử mở trang quản trị /admin bằng tài khoản giáo viên…');
  await page.goto('/admin');
  await expect(main(page).getByRole('heading', { name: /không có quyền/ })).toBeVisible();
  await say(page, 'Bị chặn: mỗi vai trò chỉ vào được trang của mình', 2800);
  await page.getByRole('link', { name: 'Về trang của tôi' }).click();
  await expect(page).toHaveURL(/\/tutor$/);
  await endCard(page, 'Hết luồng 1');
});

test('02-hoc-sinh-lop-lich-ghi-danh', async ({ page }) => {
  const tutor = await newTutor('thay.hung');
  await titleCard(page, 2, 'Học sinh, lớp học, lịch lặp và ghi danh', [
    'Student Service · Class Service · Schedule Service · Billing Service',
    'Ghi danh lớp tính phí theo tháng → chờ thanh toán + hóa đơn ghi danh + vào danh sách buổi học',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await say(page, 'Bước 1: thêm học sinh mới');
  await nav(page, 'Học sinh').click();
  await page.getByRole('link', { name: 'Thêm học sinh' }).click();
  await type(page, 'Họ tên học sinh', 'Nguyễn Minh An');
  await page.getByLabel('Ngày sinh').fill('2012-05-04');
  await type(page, 'Trường', 'THCS Lê Lợi');
  await page.getByLabel('Khối lớp').selectOption('8');
  await say(page, 'Học sinh dưới 18 tuổi bắt buộc có phụ huynh chính (người thanh toán)');
  await type(page, 'Họ tên phụ huynh 1', 'Trần Thị Lan');
  await type(page, 'Số điện thoại phụ huynh 1', '0901234567');
  await type(page, 'Email phụ huynh 1', `lan.${randomUUID().slice(0, 4)}@demo.test`);
  await page.getByRole('button', { name: 'Lưu học sinh' }).click();
  await expect(main(page).getByText(/lời mời/)).toBeVisible();
  await system(
    page,
    'Student Service lưu học sinh + phụ huynh, nhờ Identity Service tạo lời mời kích hoạt tài khoản cho phụ huynh',
    3500,
  );

  await say(page, 'Bước 2: tạo lớp nhóm, học phí 1.200.000 ₫/tháng');
  await nav(page, 'Lớp học').click();
  await page.getByRole('link', { name: 'Tạo lớp' }).click();
  await type(page, 'Tên lớp', 'Toán 8 – nhóm tối');
  await type(page, 'Môn học', 'Toán');
  await page.getByLabel('Loại lớp').selectOption('GROUP');
  await page.getByLabel('Sĩ số tối đa').fill('6');
  await page.getByLabel('Cách tính học phí').selectOption('MONTHLY');
  await page.getByLabel('Học phí mỗi tháng (VND)').fill('1200000');
  await page.getByRole('button', { name: 'Tạo lớp' }).click();
  await expect(page).toHaveURL(/\/tutor\/classes\/[0-9a-f-]{36}$/);
  await system(page, 'Class Service phát sự kiện ClassCreated qua RabbitMQ → Schedule & Billing nhận lớp mới');

  await say(page, 'Bước 3: tạo lịch lặp hằng tuần, xem trước trước khi lưu');
  const form = page.getByRole('form', { name: 'Tạo lịch lặp' });
  await form.scrollIntoViewIfNeeded();
  const from = addDays(vnDate(), 1);
  await form.getByLabel('Thứ trong tuần').selectOption(String(weekdayOf(from)));
  await form.getByLabel('Giờ bắt đầu').fill('18:30');
  await form.getByLabel('Giờ kết thúc').fill('20:00');
  await form.getByLabel('Từ ngày').fill(from);
  await eventually(async () => {
    await form.getByRole('button', { name: 'Xem trước' }).click();
    await expect(form.getByText(/Sẽ sinh \d+ buổi/)).toBeVisible({ timeout: 3000 });
  });
  await say(page, 'Xem trước: số buổi sẽ sinh và các buổi trùng giờ (nếu có)');
  await form.getByRole('button', { name: 'Lưu lịch lặp' }).click();
  await expect(main(page).getByText(/Đã tạo lịch lặp và sinh \d+ buổi học/)).toBeVisible();
  await say(page, 'Schedule Service sinh sẵn các buổi học cho 3 tháng tới');

  await say(page, 'Bước 4: ghi danh học sinh vào lớp');
  const enrollForm = page.getByRole('form', { name: 'Ghi danh' });
  await enrollForm.scrollIntoViewIfNeeded();
  await enrollForm.getByLabel('Ghi danh học sinh').selectOption({ label: 'Nguyễn Minh An' });
  await enrollForm.getByRole('button', { name: 'Ghi danh', exact: true }).click();
  await expect(main(page).getByText(/đang chờ thanh toán/)).toBeVisible();
  await system(
    page,
    'Saga ghi danh: Class kiểm tra học sinh với Student Service → StudentEnrolled → Billing phát hành hóa đơn ghi danh, Schedule thêm vào danh sách buổi học',
    4500,
  );
  await say(page, 'Lớp tính theo tháng: trạng thái "Chờ thanh toán", hạn 7 ngày', 3000);
  await showRoster(page);
  await page.waitForTimeout(1500);
  await nav(page, 'Hóa đơn').click();
  await expect(main(page).getByRole('link', { name: 'Nguyễn Minh An' })).toBeVisible();
  await say(page, 'Hóa đơn ghi danh đã được Billing Service tự động phát hành', 3000);
  await endCard(page, 'Hết luồng 2');
});

test('03-hoa-don-thanh-toan', async ({ page }) => {
  const tutor = await newTutor('co.thao');
  const st = await newStudent(tutor, 'Lê Gia Bảo', 'Lê Văn Nam');
  const cls = await newClass(tutor, 'Toán 9 – luyện thi', 'MONTHLY', 1_500_000);
  await weeklySchedule(tutor, cls.id, '17:00', '18:30');
  const enr = await enroll(tutor, cls.id, st.id);
  await eventually(() => tutor.ok('GET', `/billing/enrollments/${enr.id}/invoice`));

  await titleCard(page, 3, 'Hóa đơn ghi danh và ghi nhận thanh toán', [
    'Billing Service: VietQR, trả một phần, trả đủ',
    'PaymentReceived → Class Service kích hoạt ghi danh (Chờ thanh toán → Đang học)',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await say(page, 'Học sinh Lê Gia Bảo vừa được ghi danh, đang chờ thanh toán');
  await nav(page, 'Lớp học').click();
  await main(page).getByRole('link', { name: cls.name }).click();
  await showRoster(page);
  await expect(main(page).getByText('Chờ thanh toán').first()).toBeVisible();
  await say(page, 'Trạng thái ghi danh: Chờ thanh toán', 2500);
  await nav(page, 'Hóa đơn').click();
  await main(page).getByRole('link', { name: 'Lê Gia Bảo' }).click();
  await expect(main(page).getByRole('heading', { level: 1 })).toBeVisible();
  await say(page, 'Chi tiết hóa đơn ghi danh: học phí tính theo số buổi còn lại của tháng', 3000);
  const qr = main(page).getByRole('region', { name: 'VietQR' });
  await qr.scrollIntoViewIfNeeded();
  await say(page, 'Mã VietQR để phụ huynh chuyển khoản, kèm nội dung chuyển khoản', 3000);
  const pay = page.getByRole('form', { name: 'Ghi nhận thanh toán' });
  await pay.scrollIntoViewIfNeeded();
  await say(page, 'Phụ huynh chuyển trước 500.000 ₫ → giáo viên ghi nhận một phần');
  await pay.getByLabel('Số tiền (VND)').fill('');
  await pay.getByLabel('Số tiền (VND)').pressSequentially('500000', { delay: 60 });
  await pay.getByLabel('Hình thức').selectOption('BANK_TRANSFER').catch(() => undefined);
  await pay.getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(main(page).getByText('Đã ghi nhận thanh toán một phần.')).toBeVisible();
  await say(page, 'Hóa đơn chuyển sang "Trả một phần"; ô số tiền tự điền phần còn lại', 3000);
  await page.getByRole('form', { name: 'Ghi nhận thanh toán' }).getByRole('button', { name: 'Ghi nhận' }).click();
  await expect(main(page).getByText(/Hóa đơn đã được thanh toán đủ/)).toBeVisible();
  await system(page, 'Billing phát PaymentReceived qua RabbitMQ → Class Service kích hoạt ghi danh', 3500);
  await page.getByRole('heading', { name: 'Lịch sử thanh toán' }).scrollIntoViewIfNeeded();
  await page.waitForTimeout(2000);
  await nav(page, 'Lớp học').click();
  await main(page).getByRole('link', { name: cls.name }).click();
  await showRoster(page);
  await expect(main(page).getByText('Đang học').first()).toBeVisible();
  await say(page, 'Học sinh đã chuyển sang "Đang học"', 3000);
  await endCard(page, 'Hết luồng 3');
});

test('04-lich-day-huy-bu-doi-buoi', async ({ page }) => {
  const tutor = await newTutor('co.ngoc');
  const st = await newStudent(tutor, 'Phạm Thu Hà', 'Phạm Văn Long');
  const cls = await newClass(tutor, 'Tiếng Anh 7', 'PER_SESSION', 200_000);
  await weeklySchedule(tutor, cls.id, '18:00', '19:30');
  const other = await newClass(tutor, 'Toán 7', 'PER_SESSION', 200_000);
  await oneOff(tutor, other.id, addDays(vnDate(), 3), '18:00', '19:30');
  await enroll(tutor, cls.id, st.id);

  await titleCard(page, 4, 'Lịch dạy: hủy buổi, tạo buổi bù, dời buổi', [
    'Schedule Service: chống trùng giờ (BR-SC-01), buổi hủy không tính phí (BR-SC-04)',
    'SessionCancelled / SessionRescheduled → Billing cập nhật số buổi',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await nav(page, 'Lịch dạy').click();
  await page.getByRole('button', { name: 'Tháng' }).click();
  await say(page, 'Lịch dạy theo tháng: buổi học của mọi lớp, nhóm theo ngày', 3000);
  const card = main(page).getByRole('article', { name: `${cls.name} 18:00` }).first();
  await card.scrollIntoViewIfNeeded();
  await say(page, 'Giáo viên bận: hủy một buổi, nhập lý do');
  await card.getByRole('button', { name: 'Hủy buổi' }).click();
  await card.getByLabel('Lý do hủy').pressSequentially('Giáo viên đi công tác', { delay: 30 });
  await page.waitForTimeout(1200);
  await card.getByRole('button', { name: 'Xác nhận hủy' }).click();
  await expect(main(page).getByText(/Bạn có thể tạo buổi bù ngay bên dưới/)).toBeVisible();
  await say(page, 'Buổi đã hủy; hệ thống gợi ý tạo buổi bù ngay', 2500);
  const makeupDate = addDays(vnDate(), 5);
  const cancelled = main(page).getByRole('article', { name: `${cls.name} 18:00` }).filter({ hasText: 'Lý do hủy' });
  await cancelled.getByLabel('Ngày mới').fill(makeupDate);
  await cancelled.getByLabel('Giờ bắt đầu').fill('09:00');
  await cancelled.getByLabel('Giờ kết thúc').fill('10:30');
  await cancelled.getByRole('button', { name: 'Tạo buổi bù' }).last().click();
  await expect(main(page).getByText(/Đã tạo buổi bù ngày/)).toBeVisible();
  await say(page, 'Đã tạo buổi bù vào sáng ' + makeupDate.split('-').reverse().join('/'), 3000);

  await say(page, 'Dời một buổi khác sang giờ đã có lớp Toán 7 → hệ thống báo trùng');
  const next = main(page).getByRole('article', { name: `${cls.name} 18:00` }).filter({ hasNotText: 'Lý do hủy' }).first();
  await next.scrollIntoViewIfNeeded();
  await next.getByRole('button', { name: 'Dời buổi' }).click();
  await next.getByLabel('Ngày mới').fill(addDays(vnDate(), 3));
  await next.getByLabel('Giờ bắt đầu').fill('18:30');
  await next.getByLabel('Giờ kết thúc').fill('20:00');
  await next.getByRole('button', { name: 'Lưu giờ mới' }).click();
  await expect(next.getByRole('alert')).toBeVisible();
  await say(page, 'Bị từ chối: trùng giờ với buổi của lớp Toán 7 (BR-SC-01)', 3500);
  await next.getByLabel('Giờ bắt đầu').fill('15:00');
  await next.getByLabel('Giờ kết thúc').fill('16:30');
  await next.getByRole('button', { name: 'Lưu giờ mới' }).click();
  await expect(main(page).getByText(/Đã dời buổi sang/)).toBeVisible();
  await system(page, 'SessionRescheduled → Billing chỉ đếm buổi này một lần, theo ngày mới', 3500);
  await endCard(page, 'Hết luồng 4');
});

test('05-diem-danh-hoc-phi-theo-buoi', async ({ page }) => {
  const tutor = await newTutor('thay.khoa');
  const st = await newStudent(tutor, 'Võ Minh Khang', 'Võ Thị Hồng');
  const cls = await newClass(tutor, 'Lý 10 – kèm riêng', 'PER_SESSION', 250_000);
  await enroll(tutor, cls.id, st.id);
  const session = (await eventually(() =>
    hook('schedule', 'sessions', {
      classId: cls.id,
      startsAt: new Date(Date.now() - 10 * 60_000).toISOString(),
    }),
  )) as { id: string; date: string };
  const period = session.date.slice(0, 7);
  const next = nextPeriod(period);
  await eventually(async () => {
    const r = await tutor.ok('GET', `/sessions/${session.id}/attendance`);
    if (!r.students.length) throw new Error('roster empty');
  });

  await titleCard(page, 5, 'Điểm danh → học phí theo buổi → chốt tháng → điều chỉnh', [
    'AttendanceRecorded → Billing thêm dòng phí vào hóa đơn nháp của tháng',
    'Sửa điểm danh sau khi chốt tháng → dòng điều chỉnh ở hóa đơn tháng sau (ADR-0002)',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await nav(page, 'Lịch dạy').click();
  await say(page, 'Buổi học "Lý 10" đã bắt đầu được 10 phút');
  const card = main(page).getByRole('article', { name: new RegExp(cls.name) }).first();
  await card.getByRole('link', { name: 'Điểm danh' }).click();
  await expect(page).toHaveURL(/\/attendance$/);
  await say(page, 'Phiếu điểm danh của buổi: chọn trạng thái cho từng học sinh');
  await page.getByRole('radiogroup', { name: `Trạng thái của ${st.fullName}` }).getByLabel('Có mặt').check();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Lưu điểm danh' }).click();
  await expect(main(page).getByText(/Đã lưu điểm danh/)).toBeVisible();
  await system(page, 'AttendanceRecorded → Billing thêm 250.000 ₫ vào hóa đơn NHÁP tháng này', 3500);
  await nav(page, 'Hóa đơn').click();
  await page.getByLabel('Kỳ').fill(period);
  await expect(main(page).getByRole('link', { name: st.fullName })).toBeVisible();
  await main(page).getByRole('link', { name: st.fullName }).click();
  await expect(main(page).getByText('250.000 ₫').first()).toBeVisible();
  await say(page, `Hóa đơn tháng ${period.slice(5)}/${period.slice(0, 4)} đang ở trạng thái Nháp, 1 buổi × 250.000 ₫`, 3500);
  const invoiceUrl = page.url();

  await system(page, `⏩ Giả lập thời gian: 00:01 ngày 01/${next.slice(5)} → Billing chốt tháng, phát hành hóa đơn`, 3000);
  await hook('billing', 'close-month', {
    now: new Date(`${next}-01T00:01:00+07:00`).toISOString(),
  });
  await page.reload();
  await expect(main(page).getByText('Đã phát hành').first()).toBeVisible();
  await say(page, 'Hóa đơn đã phát hành: từ giờ không bao giờ bị sửa nữa', 3000);

  await say(page, 'Phụ huynh báo con nghỉ có phép → giáo viên sửa điểm danh (trong 48 giờ)');
  await page.goto(`/tutor/sessions/${session.id}/attendance`);
  await page.getByRole('radiogroup', { name: `Trạng thái của ${st.fullName}` }).getByLabel('Vắng có phép').check();
  await page.waitForTimeout(800);
  await page.getByRole('button', { name: 'Lưu bản sửa' }).click();
  await expect(main(page).getByText('Đã lưu bản sửa điểm danh.')).toBeVisible();
  await system(page, 'Billing không sửa hóa đơn đã phát hành: tạo dòng ĐIỀU CHỈNH -250.000 ₫ ở hóa đơn tháng sau', 4000);
  await eventually(async () => {
    const list = await tutor.ok('GET', `/billing/invoices?period=${next}&kind=MONTHLY&studentId=${st.id}`);
    if (!list[0]) throw new Error('no next invoice');
    const d = await tutor.ok('GET', `/billing/invoices/${list[0].id}`);
    if (!d.items.some((i: { type: string }) => i.type === 'ADJUSTMENT')) throw new Error('no adj');
  });
  await nav(page, 'Hóa đơn').click();
  await page.getByLabel('Kỳ').fill(next);
  await main(page).getByRole('link', { name: st.fullName }).click();
  await expect(main(page).getByText('-250.000 ₫').first()).toBeVisible();
  await say(page, `Hóa đơn tháng ${next.slice(5)}: dòng điều chỉnh -250.000 ₫ cho buổi tháng trước`, 4000);
  await page.goto(invoiceUrl);
  await expect(main(page).getByText('Đã phát hành').first()).toBeVisible();
  await say(page, 'Hóa đơn tháng trước vẫn giữ nguyên (250.000 ₫, đã phát hành)', 3500);
  await endCard(page, 'Hết luồng 5');
});

test('06-phu-huynh-kich-hoat-xem-lich-hoc-phi', async ({ page }) => {
  const tutor = await newTutor('co.linh');
  const st = await newStudent(tutor, 'Đặng Bảo Ngọc', 'Đặng Thị Mai', true);
  const cls = await newClass(tutor, 'Văn 8 – nhóm cuối tuần', 'MONTHLY', 1_000_000);
  await weeklySchedule(tutor, cls.id, '08:00', '09:30');
  const enr = await enroll(tutor, cls.id, st.id);
  const inv = await eventually(() => tutor.ok('GET', `/billing/enrollments/${enr.id}/invoice`));
  const token = invitationToken(st.parentEmail);
  void inv;

  await titleCard(page, 6, 'Phụ huynh: kích hoạt tài khoản, xem lịch học và học phí', [
    'Lời mời một lần (Identity Service) → UserRegistered → Student Service liên kết phụ huynh',
    'Phụ huynh chính là người thanh toán: xem hóa đơn và mã VietQR, chỉ đọc',
  ]);
  await say(page, `Phụ huynh ${'Đặng Thị Mai'} mở đường link kích hoạt trong lời mời`, 2800);
  await page.goto(`/invite/${token}`);
  await expect(main(page).getByRole('heading', { name: 'Kích hoạt tài khoản' })).toBeVisible();
  await type(page, 'Mật khẩu mới', PASSWORD);
  await type(page, 'Nhập lại mật khẩu', PASSWORD);
  await page.getByRole('button', { name: 'Kích hoạt và đăng nhập' }).click();
  await system(page, 'Identity đặt mật khẩu + vai trò PARENT → sự kiện UserRegistered → Student Service liên kết với học sinh', 3500);
  await expect(page).toHaveURL(/\/parent$/);
  const linked = main(page).getByRole('heading', { name: /Lịch học của/ });
  const notYet = main(page).getByText(/chưa được liên kết với học sinh/);
  await expect(linked.or(notYet)).toBeVisible();
  if (await notYet.isVisible()) {
    await say(
      page,
      'Trang tải nhanh hơn sự kiện UserRegistered (nhất quán cuối cùng): chưa thấy học sinh…',
      3500,
    );
    const parent = await signInApi(st.parentEmail);
    await eventually(async () => {
      const kids = await parent.ok('GET', '/parents/me/children');
      if (!kids.length) throw new Error('not linked yet');
    });
    await system(page, 'Student Service đã xử lý sự kiện và liên kết phụ huynh → tải lại trang', 2500);
    await page.reload();
  }
  await expect(linked).toBeVisible();
  await say(page, 'Trang phụ huynh: lịch học 4 tuần tới của con', 3500);
  await nav(page, 'Chuyên cần').click();
  await say(page, 'Chuyên cần: lịch sử điểm danh theo tháng (chưa có buổi nào)', 3000);
  await nav(page, 'Học phí').click();
  await expect(main(page).getByText(/Còn phải trả/)).toBeVisible();
  await say(page, 'Học phí: công nợ và danh sách hóa đơn, gồm hóa đơn ghi danh', 3000);
  await main(page).getByRole('link', { name: /Hóa đơn ghi danh/ }).first().click();
  await expect(main(page).getByRole('region', { name: 'VietQR' })).toBeVisible();
  await main(page).getByRole('region', { name: 'VietQR' }).scrollIntoViewIfNeeded();
  await say(page, 'Chi tiết hóa đơn + VietQR để chuyển khoản. Phụ huynh chỉ xem, không ghi nhận thanh toán được', 4000);
  await say(page, 'Thử mở trang giáo viên /tutor…');
  await page.goto('/tutor');
  await expect(main(page).getByRole('heading', { name: /không có quyền/ })).toBeVisible();
  await say(page, 'Bị chặn: phụ huynh không vào được trang giáo viên', 3000);
  await endCard(page, 'Hết luồng 6');
});

test('07-qua-han-thanh-toan-rut-ten', async ({ page }) => {
  const tutor = await newTutor('thay.tuan');
  const st = await newStudent(tutor, 'Hoàng Đức Anh', 'Hoàng Văn Sơn');
  const cls = await newClass(tutor, 'Hóa 9 – nhóm chiều', 'MONTHLY', 900_000);
  await weeklySchedule(tutor, cls.id, '15:00', '16:30');
  const enr = await enroll(tutor, cls.id, st.id);
  await eventually(() => tutor.ok('GET', `/billing/enrollments/${enr.id}/invoice`));

  await titleCard(page, 7, 'Quá hạn thanh toán 7 ngày → tự động rút tên', [
    'Job định kỳ của Class Service: WITHDRAWN (UNPAID)',
    'StudentWithdrawn → Schedule bỏ học sinh khỏi các buổi tương lai; hóa đơn được giữ nguyên',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await nav(page, 'Lớp học').click();
  await main(page).getByRole('link', { name: cls.name }).click();
  await showRoster(page);
  await expect(main(page).getByText('Chờ thanh toán').first()).toBeVisible();
  await say(page, `${st.fullName} đã ghi danh nhưng chưa thanh toán hóa đơn ghi danh`, 3500);
  await system(page, '⏩ Giả lập thời gian: 8 ngày sau. Job hằng giờ của Class Service quét các ghi danh quá hạn', 3500);
  await hook('class', 'jobs', { now: new Date(Date.now() + 8 * DAY).toISOString() });
  await page.waitForTimeout(2500);
  await page.reload();
  await showRoster(page);
  await expect(main(page).getByText('Chờ thanh toán')).toHaveCount(0);
  await say(page, 'Học sinh đã bị rút tên khỏi lớp (quá hạn thanh toán)', 3500);
  await nav(page, 'Học sinh').click();
  await main(page).getByRole('link', { name: st.fullName }).click();
  await say(page, 'Trang học sinh: không còn lớp đang học', 3000);
  await nav(page, 'Hóa đơn').click();
  await expect(main(page).getByRole('link', { name: st.fullName })).toBeVisible();
  await say(page, 'Hóa đơn ghi danh vẫn được lưu, không bị xóa hay sửa (BR-BI-05)', 3500);
  await endCard(page, 'Hết luồng 7');
});

test('08-su-co-student-service', async ({ page }) => {
  const tutor = await newTutor('co.yen');
  const st = await newStudent(tutor, 'Bùi Khánh Linh', 'Bùi Văn Tài');
  const cls = await newClass(tutor, 'Toán 6 – kèm riêng', 'PER_SESSION', 200_000);
  await oneOff(tutor, cls.id, addDays(vnDate(), 2), '19:00', '20:30');

  await titleCard(page, 8, 'Chịu lỗi: Student Service ngừng hoạt động', [
    'Ghi danh không bị mất: trả 202 + trạng thái PENDING (circuit breaker)',
    'Service hoạt động lại → job đối soát của Class Service hoàn tất ghi danh',
  ]);
  await signIn(page, tutor.email);
  await expect(page).toHaveURL(/\/tutor$/);
  await nav(page, 'Lớp học').click();
  await main(page).getByRole('link', { name: cls.name }).click();
  await system(page, '💥 Tắt container student-service (docker compose stop student-service)', 2000);
  compose('stop student-service');
  await say(page, 'Student Service đang tắt. Giáo viên vẫn ghi danh học sinh như bình thường');
  const enrollForm = page.getByRole('form', { name: 'Ghi danh' });
  await enrollForm.scrollIntoViewIfNeeded();
  await enrollForm.getByLabel('Ghi danh học sinh').selectOption({ label: st.fullName });
  await enrollForm.getByRole('button', { name: 'Ghi danh', exact: true }).click();
  await expect(main(page).getByText(/Đang xử lý ghi danh/)).toBeVisible();
  await say(page, 'Class Service không kiểm tra được học sinh → trả 202, ghi danh ở trạng thái "Đang xử lý"', 4000);
  await showRoster(page);
  await page.waitForTimeout(1500);
  await system(page, '🔧 Bật lại student-service', 1500);
  compose('start student-service');
  compose('up -d --wait student-service');
  await system(page, 'Job đối soát (mỗi phút) của Class Service kiểm tra lại các ghi danh PENDING…', 2500);
  await eventually(
    async () => {
      await hook('class', 'jobs', { now: new Date().toISOString() });
      const list = await tutor.ok('GET', `/classes/${cls.id}/students`);
      if (list.find((e: { studentId: string }) => e.studentId === st.id)?.status !== 'ACTIVE')
        throw new Error('not yet');
    },
    120_000,
    3000,
  );
  await page.reload();
  await showRoster(page);
  await expect(main(page).getByText('Đang học').first()).toBeVisible();
  await say(page, 'Ghi danh đã hoàn tất: "Đang học". Không mất dữ liệu khi một service sập', 4000);
  await endCard(page, 'Hết luồng 8');
});

test('09-quan-tri-vien', async ({ page }) => {
  const busy = await newTutor('thay.binh');
  await newClass(busy, 'Toán 12 – ôn thi', 'MONTHLY', 1_500_000);
  const idle = await newTutor('co.hoa');
  await adminApi();

  await titleCard(page, 9, 'Quản trị viên: quản lý tài khoản giáo viên', [
    'Không vô hiệu hóa được giáo viên còn lớp đang mở (BR-CL-08: Identity hỏi Class Service)',
    'Giáo viên bị vô hiệu hóa: Firebase chặn đăng nhập, phiên cũ bị thu hồi',
  ]);
  await signIn(page, 'admin@tms.local', 'Admin@123');
  await expect(page).toHaveURL(/\/admin$/);
  await say(page, 'Trang quản trị: danh sách giáo viên', 3000);
  await say(page, `Thử vô hiệu hóa ${busy.email} (đang có 1 lớp mở)`);
  await main(page).getByRole('row', { name: new RegExp(busy.email.replace('.', '\\.')) }).getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('dialog').getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await expect(main(page).getByRole('alert')).toBeVisible();
  await say(page, 'Bị từ chối: giáo viên còn lớp đang mở, phải đóng lớp trước', 3500);
  await say(page, `Vô hiệu hóa ${idle.email} (không có lớp nào)`);
  await main(page).getByRole('row', { name: new RegExp(idle.email.replace('.', '\\.')) }).getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await page.waitForTimeout(1200);
  await page.getByRole('dialog').getByRole('button', { name: 'Vô hiệu hóa' }).click();
  await expect(main(page).getByText(`Đã vô hiệu hóa ${idle.email}.`)).toBeVisible();
  await say(page, 'Thành công', 2000);
  await signOut(page);
  await say(page, `Giáo viên ${idle.email} thử đăng nhập lại…`);
  await signIn(page, idle.email);
  await expect(main(page).getByRole('alert')).toBeVisible();
  await say(page, 'Tài khoản đã bị vô hiệu hóa: không đăng nhập được', 3500);
  await endCard(page, 'Hết luồng 9');
});
