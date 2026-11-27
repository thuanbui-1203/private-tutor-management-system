// `pnpm seed:demo`: sample accounts and data for demoing the app, created the way real users
// would create them, through the API gateway:
//   Tutor   = Firebase sign-up → POST /auth/register
//   Student / Parent = Tutor creates the Student (no e-mail) → Tutor invites → invitee accepts
//   then Classes, weekly Schedules, Enrollments and Payments.
// Run `pnpm seed` (Admin) first. The stack must be up (docker compose) with NODE_ENV not
// "production" (the invitation link is returned only then).
//
// Firebase: the Auth emulator when FIREBASE_AUTH_EMULATOR_HOST is set, otherwise the real
// project with NEXT_PUBLIC_FIREBASE_API_KEY from .env / frontend/.env.local.
// Env: DEMO_GATEWAY (default http://localhost:8080/api), DEMO_PASSWORD (required unless the
// emulator is used).
//
// Re-running is safe: if the first demo Tutor already exists, it only prints the list.
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const readEnv = (file) =>
  existsSync(file)
    ? Object.fromEntries(
        readFileSync(file, 'utf8')
          .split(/\r?\n/)
          .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
          .filter(Boolean)
          .map(([, k, v]) => [k, v.replace(/^["']|["']$/g, '')]),
      )
    : {};
const fileEnv = { ...readEnv(join(root, '.env')), ...readEnv(join(root, 'frontend/.env.local')) };

const GATEWAY = process.env.DEMO_GATEWAY ?? 'http://localhost:8080/api';
const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST;
// No default on a real project: this repo is public, so a default password is a known one.
const PASSWORD = process.env.DEMO_PASSWORD || (EMULATOR ? 'Demo@1234' : undefined);
if (!PASSWORD) {
  console.error('set DEMO_PASSWORD (there is no default on a real Firebase project)');
  process.exit(1);
}
const API_KEY = EMULATOR
  ? 'demo-key'
  : (process.env.NEXT_PUBLIC_FIREBASE_API_KEY ?? fileEnv.NEXT_PUBLIC_FIREBASE_API_KEY);
const IDENTITY_TOOLKIT = EMULATOR
  ? `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`
  : 'https://identitytoolkit.googleapis.com/v1';
if (!API_KEY) {
  console.error('NEXT_PUBLIC_FIREBASE_API_KEY is missing (.env or frontend/.env.local)');
  process.exit(1);
}

// ------------------------------------------------------------------ the demo data set
const TUTORS = [
  {
    key: 'minh',
    email: 'gv.minh@tms.demo',
    name: 'Thầy Nguyễn Văn Minh',
    classes: [
      {
        key: 'toan9',
        name: 'Toán 9 – Ôn thi vào 10',
        subject: 'Toán',
        type: 'GROUP',
        maxStudents: 6,
        feeType: 'MONTHLY',
        feeAmount: 1_200_000,
        slots: [
          [2, '18:00', '19:30'],
          [5, '18:00', '19:30'],
        ],
      },
      {
        key: 'toan7',
        name: 'Toán 7 – Kèm 1-1',
        subject: 'Toán',
        type: 'ONE_ON_ONE',
        feeType: 'PER_SESSION',
        feeAmount: 250_000,
        slots: [[3, '17:30', '19:00']],
      },
    ],
  },
  {
    key: 'lan',
    email: 'gv.lan@tms.demo',
    name: 'Cô Trần Thị Lan',
    classes: [
      {
        key: 'ielts',
        name: 'IELTS Foundation',
        subject: 'Tiếng Anh',
        type: 'GROUP',
        maxStudents: 8,
        feeType: 'MONTHLY',
        feeAmount: 1_500_000,
        slots: [
          [2, '19:00', '20:30'],
          [4, '19:00', '20:30'],
        ],
      },
      {
        key: 'anh6',
        name: 'Tiếng Anh 6 – Nhóm nhỏ',
        subject: 'Tiếng Anh',
        type: 'GROUP',
        maxStudents: 4,
        feeType: 'PER_SESSION',
        feeAmount: 200_000,
        slots: [[7, '09:00', '10:30']],
      },
    ],
  },
];

// `login`: activate an account for the Student itself (needs `email`) and/or each Parent.
// `pay`: 'full' | 'partial' | undefined (unpaid) for a MONTHLY Enrollment invoice.
const STUDENTS = [
  {
    tutor: 'minh',
    fullName: 'Nguyễn Minh Khoa',
    dob: '2011-03-15',
    grade: 9,
    school: 'THCS Trưng Vương',
    email: 'hs.khoa@tms.demo',
    parent: {
      key: 'hoa',
      fullName: 'Nguyễn Thị Hoa',
      phone: '0912345678',
      email: 'ph.hoa@tms.demo',
    },
    classes: [['toan9', 'full']],
  },
  {
    tutor: 'minh',
    fullName: 'Nguyễn Thu Hà',
    dob: '2013-08-02',
    grade: 7,
    school: 'THCS Trưng Vương',
    parent: { key: 'hoa' },
    classes: [['toan7']],
  },
  {
    tutor: 'minh',
    fullName: 'Trần Gia Bảo',
    dob: '2011-11-20',
    grade: 9,
    school: 'THCS Nguyễn Du',
    parent: { key: 'nam', fullName: 'Trần Văn Nam', phone: '0987654321', email: 'ph.nam@tms.demo' },
    classes: [['toan9']],
  },
  {
    tutor: 'minh',
    fullName: 'Lê Hoàng Phúc',
    dob: '2011-06-09',
    grade: 9,
    school: 'THCS Nguyễn Du',
    parent: {
      key: 'tuan',
      fullName: 'Lê Minh Tuấn',
      phone: '0903111222',
      email: 'ph.tuan@tms.demo',
    },
    classes: [['toan9', 'partial']],
  },
  {
    tutor: 'lan',
    fullName: 'Phạm Quỳnh Anh',
    dob: '2008-01-25',
    grade: 12,
    school: 'THPT Chu Văn An',
    email: 'hs.quynhanh@tms.demo',
    payer: 'SELF',
    classes: [['ielts', 'full']],
  },
  {
    tutor: 'lan',
    fullName: 'Võ Đức Huy',
    dob: '2014-04-12',
    grade: 6,
    school: 'THCS Lê Lợi',
    parent: {
      key: 'thao',
      fullName: 'Võ Thị Thảo',
      phone: '0938222333',
      email: 'ph.thao@tms.demo',
    },
    classes: [['anh6'], ['ielts', 'full']],
  },
  {
    tutor: 'lan',
    fullName: 'Đặng Bảo Ngọc',
    dob: '2014-09-30',
    grade: 6,
    school: 'THCS Lê Lợi',
    parent: { key: 'mai', fullName: 'Đặng Thị Mai', phone: '0977444555', email: 'ph.mai@tms.demo' },
    classes: [['anh6']],
  },
];

// ------------------------------------------------------------------ HTTP
async function call(url, init = {}) {
  const res = await fetch(url, init);
  const text = await res.text();
  let body = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    /* keep text */
  }
  return { status: res.status, body };
}
async function firebase(path, body) {
  const r = await call(`${IDENTITY_TOOLKIT}/${path}?key=${API_KEY}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', referer: 'http://localhost:5173/' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`firebase ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
const signIn = async (email, password = PASSWORD) =>
  new Api(
    (await firebase('accounts:signInWithPassword', { email, password, returnSecureToken: true }))
      .idToken,
  );

class Api {
  constructor(token) {
    this.token = token;
  }
  async ok(method, path, body) {
    const r = await call(`${GATEWAY}${path}`, {
      method,
      headers: {
        ...(this.token && { authorization: `Bearer ${this.token}` }),
        ...(body !== undefined && { 'content-type': 'application/json' }),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (r.status >= 300)
      throw new Error(`${method} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
    return r.body;
  }
}

/** Events travel through RabbitMQ: retry until the other service has caught up. */
async function eventually(check, timeoutMs = 45_000, every = 700) {
  const deadline = Date.now() + timeoutMs;
  let last;
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
const tomorrowVn = () =>
  new Date(Date.now() + 7 * 3_600_000 + 86_400_000).toISOString().slice(0, 10);

// ------------------------------------------------------------------ steps
async function newTutor(t) {
  const { idToken } = await firebase('accounts:signUp', {
    email: t.email,
    password: PASSWORD,
    displayName: t.name,
    returnSecureToken: true,
  });
  await new Api(idToken).ok('POST', '/auth/register', {});
  return signIn(t.email); // fresh token carrying the TUTOR role claim
}

async function inviteAndAccept(tutor, email, fullName, role) {
  const inv = await tutor.ok('POST', '/auth/invitations', { email, fullName, role });
  const token = inv.acceptUrl?.match(/\/invitations\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`no invitation link for ${email} (is NODE_ENV=production?)`);
  await new Api('').ok('POST', `/auth/invitations/${token}/accept`, { password: PASSWORD });
}

async function main() {
  // Guard: already seeded?
  const already = await signIn(TUTORS[0].email).then(
    () => true,
    () => false,
  );
  if (already) {
    console.log(`Demo data already exists (${TUTORS[0].email} signs in). Nothing created.`);
    return;
  }

  const tutors = {};
  const classes = {};
  for (const t of TUTORS) {
    const api = await newTutor(t);
    tutors[t.key] = api;
    console.log(`✓ Tutor ${t.email}`);
    for (const c of t.classes) {
      const { key, slots, ...body } = c;
      const cls = await api.ok('POST', '/classes', { ...body, chargeAbsent: true });
      classes[key] = { ...cls, ...c, api };
      for (const [weekday, startTime, endTime] of slots) {
        await eventually(() =>
          api.ok('POST', '/schedules', {
            classId: cls.id,
            weekday,
            startTime,
            endTime,
            fromDate: tomorrowVn(),
          }),
        );
      }
      console.log(`  ✓ Class "${c.name}" + ${slots.length} weekly schedule(s)`);
    }
  }

  const parents = {}; // key → { tutor, parentId }
  const logins = [];
  for (const s of STUDENTS) {
    const api = tutors[s.tutor];
    const parentLinks = [];
    if (s.parent && parents[s.parent.key]) {
      parentLinks.push({ parentId: parents[s.parent.key].parentId, isPrimary: true });
    } else if (s.parent) {
      const { fullName, phone, email } = s.parent;
      parentLinks.push({ fullName, phone, email, isPrimary: true });
    }
    const student = await api.ok('POST', '/students', {
      fullName: s.fullName,
      dob: s.dob,
      grade: s.grade,
      school: s.school,
      ...(s.email && { email: s.email }),
      ...(s.payer && { payer: s.payer }),
      parents: parentLinks,
      invite: false,
    });
    console.log(`✓ Student ${s.fullName}`);

    if (s.parent && !parents[s.parent.key]) {
      const detail = await api.ok('GET', `/students/${student.id}`);
      const parent = (detail.parents ?? []).find((p) => p.email === s.parent.email);
      parents[s.parent.key] = { parentId: parent.id };
      await inviteAndAccept(api, s.parent.email, s.parent.fullName, 'PARENT');
      logins.push(s.parent.email);
      console.log(`  ✓ Parent account ${s.parent.email}`);
    }
    if (s.email) {
      await inviteAndAccept(api, s.email, s.fullName, 'STUDENT');
      logins.push(s.email);
      console.log(`  ✓ Student account ${s.email}`);
    }

    for (const [classKey, pay] of s.classes) {
      const cls = classes[classKey];
      const enr = await eventually(() =>
        api.ok('POST', `/classes/${cls.id}/enrollments`, { studentId: student.id }),
      );
      let note = enr.status;
      if (cls.feeType === 'MONTHLY' && pay) {
        const invoice = await eventually(() =>
          api.ok('GET', `/billing/enrollments/${enr.id}/invoice`),
        );
        const amount = pay === 'full' ? invoice.total : Math.round(invoice.total / 2 / 1000) * 1000;
        await api.ok('POST', `/billing/invoices/${invoice.id}/payments`, {
          amount,
          method: pay === 'full' ? 'BANK_TRANSFER' : 'CASH',
          note: 'Dữ liệu demo',
        });
        note += ` → paid ${pay} (${amount.toLocaleString('vi-VN')} ₫)`;
      }
      console.log(`  ✓ Enrolled in "${cls.name}": ${note}`);
    }
  }
  console.log(
    `\nDone. ${TUTORS.length} tutors, ${logins.length} parent/student logins (password: DEMO_PASSWORD)`,
  );
}

main().catch((err) => {
  console.error(`seed:demo failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
