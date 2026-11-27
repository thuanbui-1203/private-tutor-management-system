// `pnpm seed:demo`: sample accounts and data for demoing the app, created the way real users
// would create them, through the API gateway:
//   Tutor   = Google sign-in → POST /auth/register
//   Student / Parent = Tutor creates the Student (no e-mail) → Tutor invites → invitee accepts
//   then Classes, weekly Schedules, Enrollments and Payments.
// The stack must be up with NODE_ENV not "production" (the invitation link is returned only then).
//
// Only with the Auth emulator (`pnpm emulators`): the demo addresses are not real Google accounts.
// Env: DEMO_GATEWAY (default http://localhost:8080/api),
//      FIREBASE_AUTH_EMULATOR_HOST (default 127.0.0.1:9099).
//
// Re-running is safe: if the first demo Tutor already exists, nothing is created.
import { randomUUID } from 'node:crypto';

const GATEWAY = process.env.DEMO_GATEWAY ?? 'http://localhost:8080/api';
const EMULATOR = process.env.FIREBASE_AUTH_EMULATOR_HOST ?? '127.0.0.1:9099';
const IDENTITY_TOOLKIT = `http://${EMULATOR}/identitytoolkit.googleapis.com/v1`;

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
  const r = await call(`${IDENTITY_TOOLKIT}/${path}?key=demo-key`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (r.status !== 200) throw new Error(`firebase ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}
/** Google sign-in, as the app does it with the emulator. */
const signIn = async (email) => {
  const google = JSON.stringify({ sub: `google-${email}`, email, email_verified: true });
  const { idToken } = await firebase('accounts:signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(google)}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
    returnIdpCredential: true,
  });
  return new Api(idToken);
};
const roleOf = (api) =>
  JSON.parse(Buffer.from(api.token.split('.')[1], 'base64url').toString()).role;

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
async function newTutor(t, admin) {
  await (await signIn(t.email)).ok('POST', '/auth/register', { role: 'TUTOR' });
  const api = await signIn(t.email); // fresh token carrying the TUTOR role claim
  // Only a verified Tutor's Classes take Students (BR-TU-01): profile, credential, review.
  await api.ok('PUT', '/tutors/me', {
    kind: 'GRADUATE',
    displayName: t.name,
    school: 'Đại học Sư phạm Hà Nội',
    schoolCountry: 'VN',
    subjects: [...new Set(t.classes.map((c) => c.subject))].map((subject) => ({
      subject,
      gradeFrom: 6,
      gradeTo: 12,
    })),
    areas: [{ kind: 'LOCAL', provinceCode: 1, wardCode: null }, { kind: 'ONLINE' }],
    availability: [{ weekday: 2, startTime: '17:00', endTime: '21:00' }],
  });
  const pdf = Buffer.from('%PDF-1.4\nBang tot nghiep (du lieu demo)\n%%EOF\n').toString('base64');
  await api.ok('POST', '/tutors/me/credentials', {
    kind: 'DEGREE',
    title: 'Cử nhân Sư phạm',
    issuer: 'Đại học Sư phạm Hà Nội',
    country: 'VN',
    file: { name: 'bang-demo.pdf', contentBase64: pdf },
  });
  const p = await api.ok('POST', '/tutors/me/submit');
  await admin.ok('POST', `/tutors/${p.tutorId}/review`, {
    decision: 'VERIFY',
    credentials: p.credentials.map((c) => ({ id: c.id, status: 'VERIFIED' })),
    subjects: p.subjects.map((s) => ({ id: s.id, status: 'VERIFIED' })),
  });
  return api;
}

/**
 * An Admin for the review: an emulator account given the claims directly (no users row; the
 * gateway and tutor-service only read the claims). Only possible with the emulator.
 */
async function reviewer() {
  const email = 'reviewer@tms.demo';
  const { users } = await firebase('accounts:lookup', {
    idToken: (await signIn(email)).token,
  });
  const res = await fetch(
    `http://${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/demo-tms/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({
        localId: users[0].localId,
        customAttributes: JSON.stringify({ role: 'ADMIN', userId: randomUUID() }),
      }),
    },
  );
  if (!res.ok) throw new Error(`reviewer claims: ${res.status}`);
  return signIn(email);
}

async function inviteAndAccept(tutor, email, fullName, role) {
  const inv = await tutor.ok('POST', '/auth/invitations', { email, fullName, role });
  const token = inv.acceptUrl?.match(/\/invite\/([A-Za-z0-9_-]+)/)?.[1];
  if (!token) throw new Error(`no invitation link for ${email} (is NODE_ENV=production?)`);
  await (await signIn(email)).ok('POST', `/auth/invitations/${token}/accept`, {});
}

async function main() {
  // Guard: already seeded?
  if (roleOf(await signIn(TUTORS[0].email))) {
    console.log(`Demo data already exists (${TUTORS[0].email} signs in). Nothing created.`);
    return;
  }

  const admin = await reviewer();
  const tutors = {};
  const classes = {};
  for (const t of TUTORS) {
    const api = await newTutor(t, admin);
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
    `\nDone. ${TUTORS.length} tutors, ${logins.length} parent/student logins (Google, emulator)`,
  );
}

main().catch((err) => {
  console.error(`seed:demo failed: ${err instanceof Error ? err.message : err}`);
  process.exit(1);
});
