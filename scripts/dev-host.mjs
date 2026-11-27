// `pnpm dev:host [--seed]`: the whole app on this machine to click through, without building any
// image. Infrastructure (PostgreSQL, RabbitMQ, Redis, Mailpit) runs in its own compose project
// `tms-local` and keeps its data (`docker compose -p tms-local down -v` empties it); the Firebase
// emulators (Auth + Realtime Database, project `demo-tms`), every service (from `dist/`) and the
// frontend (`next dev`) run as processes here. Sign-in is the emulator's fake Google form: no
// real account is used. `--seed` runs `pnpm seed:demo` once all is up. Ctrl+C stops everything,
// saves the emulator data to .emulator-data/ and leaves the containers up.
// Logs: <tmp>/tms-dev-host/<name>.log
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const logs = join(tmpdir(), 'tms-dev-host');
mkdirSync(logs, { recursive: true });
const win = process.platform === 'win32';

const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  console.error('.env is missing: run `pnpm setup:env` first');
  process.exit(1);
}
const dotenv = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*?)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v]),
);
const DEFAULT_DB = { TUTOR_DB_URL: 'postgresql://tutor:tutor@postgres:5432/tutor_db' };
const db = (key) => (dotenv[key] ?? DEFAULT_DB[key]).replace('@postgres:5432', '@127.0.0.1:5432');
const at = (port) => `http://127.0.0.1:${port}`;
const env = (key, fallback = '') => dotenv[key] || fallback;
const FRONTEND = 'http://localhost:5173';
const PROJECT = 'tms-local';

const APPS = {
  identity: {
    port: 3001,
    env: {
      DATABASE_URL: db('IDENTITY_DB_URL'),
      ADMIN_EMAILS: env('ADMIN_EMAILS'),
      CLASS_SERVICE_URL: at(3003),
      FRONTEND_URL: FRONTEND,
      SMTP_HOST: '127.0.0.1',
      SMTP_PORT: '1025',
      SMTP_FROM: 'TMS <no-reply@tms.local>',
    },
  },
  student: {
    port: 3002,
    env: { DATABASE_URL: db('STUDENT_DB_URL'), BILLING_SERVICE_URL: at(3006) },
  },
  class: {
    port: 3003,
    env: {
      DATABASE_URL: db('CLASS_DB_URL'),
      STUDENT_SERVICE_URL: at(3002),
      REQUIRE_VERIFIED_TUTOR: env('REQUIRE_VERIFIED_TUTOR', 'true'),
    },
  },
  schedule: {
    port: 3004,
    env: {
      DATABASE_URL: db('SCHEDULE_DB_URL'),
      STUDENT_SERVICE_URL: at(3002),
      ATTENDANCE_EDIT_WINDOW_HOURS: env('ATTENDANCE_EDIT_WINDOW_HOURS', '48'),
    },
  },
  billing: {
    port: 3006,
    env: {
      DATABASE_URL: db('BILLING_DB_URL'),
      STUDENT_SERVICE_URL: at(3002),
      BILLING_INVOICE_DUE_DAY: env('BILLING_INVOICE_DUE_DAY', '10'),
      BILLING_CHARGE_ABSENT: env('BILLING_CHARGE_ABSENT', 'true'),
      BANK_DATA_KEY: env('BANK_DATA_KEY'),
      ATTENDANCE_EDIT_WINDOW_HOURS: env('ATTENDANCE_EDIT_WINDOW_HOURS', '48'),
      // A made-up centre account so invoices show a VietQR; nothing is ever paid into it.
      BILLING_BANK_BIN: env('BILLING_BANK_BIN', '970436'),
      BILLING_BANK_ACCOUNT: env('BILLING_BANK_ACCOUNT', '0011000000000'),
      BILLING_BANK_ACCOUNT_NAME: env('BILLING_BANK_ACCOUNT_NAME', 'TRUNG TAM TMS DEMO'),
      // Payroll in sandbox mode: no real money moves (docs/07 §6).
      PAYOUT_MODE: env('PAYOUT_MODE', 'sandbox'),
      PAYOUT_WEBHOOK_SECRET: env('PAYOUT_WEBHOOK_SECRET', 'local-dev-only-payroll-webhook-secret'),
      SANDBOX_PUBLIC_URL: FRONTEND,
    },
  },
  audit: {
    port: 3008,
    env: {
      DATABASE_URL: db('AUDIT_DB_URL'),
      AUDIT_RETENTION_DAYS: '365',
      IDENTITY_SERVICE_URL: at(3001),
      STUDENT_SERVICE_URL: at(3002),
      CLASS_SERVICE_URL: at(3003),
      SCHEDULE_SERVICE_URL: at(3004),
      BILLING_SERVICE_URL: at(3006),
      TUTOR_SERVICE_URL: at(3009),
    },
  },
  tutor: {
    port: 3009,
    env: {
      DATABASE_URL: db('TUTOR_DB_URL'),
      FIREBASE_DATABASE_URL: 'http://127.0.0.1:9002?ns=demo-tms-default-rtdb',
      FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:9002',
      FILE_DATA_KEY: env('FILE_DATA_KEY'),
    },
  },
  gateway: {
    port: 8080,
    dir: 'api-gateway',
    env: {
      REDIS_URL: 'redis://127.0.0.1:6379',
      AUDIT_SPOOL_DIR: join(logs, 'spool'),
      CORS_ORIGINS: FRONTEND,
      IDENTITY_SERVICE_URL: at(3001),
      STUDENT_SERVICE_URL: at(3002),
      CLASS_SERVICE_URL: at(3003),
      SCHEDULE_SERVICE_URL: at(3004),
      BILLING_SERVICE_URL: at(3006),
      AUDIT_SERVICE_URL: at(3008),
      TUTOR_SERVICE_URL: at(3009),
    },
  },
};
const dirOf = (name) => APPS[name].dir ?? `${name}-service`;
// Only what a process needs from this shell: no real Firebase credentials reach the services.
const BASE = {
  PATH: process.env.PATH,
  SystemRoot: process.env.SystemRoot,
  TEMP: process.env.TEMP,
  NODE_ENV: 'development',
  LOG_LEVEL: 'info',
  TZ: env('TZ', 'Asia/Ho_Chi_Minh'),
  RABBITMQ_URL: 'amqp://tms:tms_dev@127.0.0.1:5672',
  FIREBASE_PROJECT_ID: 'demo-tms',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
};

const sh = (cmd, args, extra = {}) =>
  spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, ...extra },
    shell: win,
  }).status ?? 1;

const running = new Map();
let stopping = false;
function start(name, cmd, args, opts) {
  const out = openSync(join(logs, `${name}.log`), 'w');
  const child = spawn(cmd, args, { stdio: ['ignore', out, out], ...opts });
  child.on('exit', (code) => {
    if (running.get(name) === child) running.delete(name);
    if (!stopping) console.error(`✗ ${name} stopped (${code}): ${join(logs, `${name}.log`)}`);
  });
  running.set(name, child);
}
// The emulators and `next dev` start children of their own (java, the Next server):
// kill the whole tree, or they keep their ports.
function kill(child) {
  if (win) spawnSync('taskkill', ['/pid', String(child.pid), '/T', '/F'], { stdio: 'ignore' });
  else child.kill();
}
async function waitFor(what, url, seconds = 90) {
  for (let i = 0; i < seconds; i++) {
    const ok = await fetch(url).then(
      (r) => r.status < 500,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} is not ready (${url}); logs in ${logs}`);
}

async function finish(code) {
  if (stopping) return;
  stopping = true;
  if (running.has('emulators')) {
    console.log('saving emulator data to .emulator-data/ …');
    sh('firebase', ['emulators:export', '.emulator-data', '--project', 'demo-tms', '--force'], {});
  }
  for (const child of running.values()) kill(child);
  process.exit(code);
}
const must = async (code, what) => {
  if (code === 0) return;
  console.error(`\n✗ ${what} failed (exit ${code})`);
  await finish(code);
};
process.on('SIGINT', () => void finish(0));

for (const port of [9099, 9002, 5173, ...Object.values(APPS).map((a) => a.port)]) {
  const busy = await fetch(at(port)).then(
    () => true,
    () => false,
  );
  if (busy) {
    console.error(`port ${port} is already in use: stop what runs there (the dev compose stack?)`);
    process.exit(1);
  }
}

// Own compose project: its own, initially empty volumes, so the dev stack's data () stays.
await must(
  sh('pnpm', [
    'compose',
    '-p',
    PROJECT,
    'up',
    '-d',
    '--wait',
    'postgres',
    'rabbitmq',
    'redis',
    'mailpit',
  ]),
  'starting infrastructure',
);

await must(
  sh('pnpm', ['--filter', '@tms/contracts', '--filter', '@tms/common', 'build']),
  'building packages',
);
for (const name of Object.keys(APPS)) {
  await must(sh('pnpm', ['--filter', `@tms/${dirOf(name)}`, 'build']), `building ${name}`);
}
for (const name of Object.keys(APPS).filter((n) => APPS[n].env.DATABASE_URL)) {
  await must(
    sh('pnpm', ['--filter', `@tms/${dirOf(name)}`, 'exec', 'prisma', 'migrate', 'deploy'], {
      DATABASE_URL: APPS[name].env.DATABASE_URL,
    }),
    `migrating ${name}`,
  );
}

try {
  const saved = existsSync(join(root, '.emulator-data', 'firebase-export-metadata.json'));
  start(
    'emulators',
    'firebase',
    [
      'emulators:start',
      '--only',
      'auth,database',
      '--project',
      'demo-tms',
      ...(saved ? ['--import', '.emulator-data'] : []),
    ],
    { cwd: root, shell: win },
  );
  await waitFor('Auth emulator', at(9099));
  await waitFor('Database emulator', at(9002));

  for (const name of Object.keys(APPS)) {
    start(name, process.execPath, ['dist/main.js'], {
      cwd: join(root, 'backend', dirOf(name)),
      env: { ...BASE, PORT: String(APPS[name].port), ...APPS[name].env },
    });
  }
  for (const name of Object.keys(APPS)) {
    await waitFor(name, `${at(APPS[name].port)}/health/ready`);
  }

  start('frontend', 'pnpm', ['--filter', '@tms/frontend', 'dev'], {
    cwd: root,
    shell: win,
    // Wins over frontend/.env.local: the browser signs in on the emulator, not the real project.
    env: {
      ...process.env,
      NEXT_PUBLIC_API_URL: 'http://localhost:8080/api',
      NEXT_PUBLIC_FIREBASE_PROJECT_ID: 'demo-tms',
      NEXT_PUBLIC_FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:9099',
      NEXT_PUBLIC_FIREBASE_API_KEY: 'demo-key',
      NEXT_PUBLIC_FIREBASE_AUTH_DOMAIN: 'demo-tms.firebaseapp.com',
      NEXT_PUBLIC_FIREBASE_APP_ID: 'demo-app',
    },
  });
  await waitFor('frontend', FRONTEND, 180);
} catch (err) {
  console.error(err.message);
  await finish(1);
}

if (process.argv.includes('--seed')) {
  // A failed seed leaves the app running: the data can be added by hand, or the seed fixed.
  if (sh('pnpm', ['seed:demo']) !== 0) console.error('✗ seed:demo failed: the app keeps running');
}
console.log(`
TMS is running on this machine (Ctrl+C stops it):
  ${FRONTEND}                 app (sign in with any e-mail on the emulator's Google form)
  http://localhost:8080/docs  API Gateway (Swagger)
  http://localhost:8025       Mailpit (e-mails the app sent)
  http://localhost:15672      RabbitMQ (tms / tms_dev)
  logs                        ${logs}
`);
