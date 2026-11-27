// `pnpm test:e2e:host [jest args]`: the end-to-end suite without building any image. Same tests
// and same throwaway infrastructure as `pnpm test:e2e` (compose project `tms-e2e`: own databases
// and broker, Auth emulator), but the services run as Node processes from their `dist/`.
// Needs far less disk and memory; `pnpm test:e2e` stays the check of the images themselves.
import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, openSync, readFileSync } from 'node:fs';
import { createServer } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const logs = join(tmpdir(), 'tms-e2e-host');
mkdirSync(logs, { recursive: true });

const envFile = join(root, '.env');
if (!existsSync(envFile)) {
  console.error('.env is missing: run `pnpm setup:env` first');
  process.exit(1);
}
const dotenv = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v]),
);
const DEFAULT_DB = { TUTOR_DB_URL: 'postgresql://tutor:tutor@postgres:5432/tutor_db' };
const db = (key) => (dotenv[key] ?? DEFAULT_DB[key]).replace('@postgres:5432', '@127.0.0.1:25432');
const onHost = (port) => `http://127.0.0.1:${port}`;

const hooks = { E2E_HOOKS: 'true' };
const APPS = {
  identity: {
    port: 23001,
    env: { DATABASE_URL: db('IDENTITY_DB_URL'), CLASS_SERVICE_URL: onHost(23003) },
  },
  student: {
    port: 23002,
    env: {
      DATABASE_URL: db('STUDENT_DB_URL'),
      IDENTITY_SERVICE_URL: onHost(23001),
      BILLING_SERVICE_URL: onHost(23006),
    },
  },
  class: {
    port: 23003,
    env: { ...hooks, DATABASE_URL: db('CLASS_DB_URL'), STUDENT_SERVICE_URL: onHost(23002) },
  },
  schedule: {
    port: 23004,
    env: {
      ...hooks,
      DATABASE_URL: db('SCHEDULE_DB_URL'),
      STUDENT_SERVICE_URL: onHost(23002),
      ATTENDANCE_EDIT_WINDOW_HOURS: '48',
    },
  },
  // The same settings as docker-compose.e2e.yml.
  billing: {
    port: 23006,
    env: {
      ...hooks,
      DATABASE_URL: db('BILLING_DB_URL'),
      STUDENT_SERVICE_URL: onHost(23002),
      BILLING_INVOICE_DUE_DAY: '10',
      BILLING_CHARGE_ABSENT: 'true',
      BANK_DATA_KEY: 'ZTJlLXRlc3Qta2V5LW9ubHktMzItYnl0ZXMtbG9uZyE=',
      PAYOUT_MODE: 'sandbox',
      PAYOUT_WEBHOOK_SECRET: 'e2e-only-payroll-webhook-secret-0000',
      SANDBOX_PUBLIC_URL: onHost(25173),
      ATTENDANCE_EDIT_WINDOW_HOURS: '-24',
    },
  },
  audit: {
    port: 23008,
    env: {
      DATABASE_URL: db('AUDIT_DB_URL'),
      AUDIT_RETENTION_DAYS: '365',
      IDENTITY_SERVICE_URL: onHost(23001),
      STUDENT_SERVICE_URL: onHost(23002),
      CLASS_SERVICE_URL: onHost(23003),
      SCHEDULE_SERVICE_URL: onHost(23004),
      BILLING_SERVICE_URL: onHost(23006),
      TUTOR_SERVICE_URL: onHost(23009),
    },
  },
  // The same settings as docker-compose.e2e.yml.
  tutor: {
    port: 23009,
    env: {
      DATABASE_URL: db('TUTOR_DB_URL'),
      FIREBASE_DATABASE_URL: 'http://127.0.0.1:29002?ns=demo-tms-default-rtdb',
      FIREBASE_DATABASE_EMULATOR_HOST: '127.0.0.1:29002',
      FILE_DATA_KEY: 'ZTJlLWZpbGUta2V5LW9ubHktMzItYnl0ZXMtbG9uZyE=',
    },
  },
  gateway: {
    port: 28080,
    dir: 'api-gateway',
    env: {
      AUDIT_SPOOL_DIR: join(logs, 'spool'),
      CORS_ORIGINS: onHost(25173),
      IDENTITY_SERVICE_URL: onHost(23001),
      STUDENT_SERVICE_URL: onHost(23002),
      CLASS_SERVICE_URL: onHost(23003),
      SCHEDULE_SERVICE_URL: onHost(23004),
      BILLING_SERVICE_URL: onHost(23006),
      AUDIT_SERVICE_URL: onHost(23008),
      TUTOR_SERVICE_URL: onHost(23009),
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
  TZ: 'UTC',
  RABBITMQ_URL: 'amqp://tms:tms_dev@127.0.0.1:25672',
  FIREBASE_PROJECT_ID: 'demo-tms',
  FIREBASE_AUTH_EMULATOR_HOST: '127.0.0.1:29099',
};

const sh = (cmd, args, env = {}) =>
  spawnSync(cmd, args, {
    cwd: root,
    stdio: 'inherit',
    env: { ...process.env, COMPOSE_BAKE: 'false', ...env },
    shell: process.platform === 'win32' && cmd === 'pnpm',
  }).status ?? 1;
// Through `pnpm compose` (scripts/compose.mjs), as e2e.mjs does: started straight from Git Bash,
// Compose's Bake builder asks for an extra `--allow=fs.read=<Dockerfile>` and the build stops.
const compose = (...a) =>
  sh('pnpm', [
    'compose',
    '-p',
    'tms-e2e',
    '-f',
    'docker-compose.yml',
    '-f',
    'docker-compose.e2e.yml',
    ...a,
  ]);

const running = new Map();
let stopping = false;
function start(name) {
  const out = openSync(join(logs, `${name}.log`), 'a');
  const child = spawn(process.execPath, ['dist/main.js'], {
    cwd: join(root, 'backend', dirOf(name)),
    env: { ...BASE, PORT: String(APPS[name].port), ...APPS[name].env },
    stdio: ['ignore', out, out],
  });
  child.on('exit', (code) => {
    if (running.get(name) === child) running.delete(name);
    if (!stopping && code) console.error(`${name} exited with ${code}: see ${logs}`);
  });
  running.set(name, child);
}
function stop(name) {
  const child = running.get(name);
  if (!child) return Promise.resolve();
  running.delete(name);
  return new Promise((done) => {
    child.once('exit', done);
    child.kill();
  });
}
async function ready(name) {
  const url = `${onHost(APPS[name].port)}/health/ready`;
  for (let i = 0; i < 60; i++) {
    const ok = await fetch(url).then(
      (r) => r.ok,
      () => false,
    );
    if (ok) return;
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${name} is not ready (${url}); logs in ${logs}`);
}

async function finish(code) {
  stopping = true;
  await Promise.all([...running.keys()].map(stop));
  compose('down', '-v');
  process.exit(code);
}
const must = async (code, what) => {
  if (code === 0) return;
  console.error(`\n✗ ${what} failed (exit ${code})`);
  await finish(code);
};
process.on('SIGINT', () => void finish(130));

compose('down', '-v');
await must(
  sh('pnpm', ['--filter', '@tms/contracts', '--filter', '@tms/common', 'build']),
  'building packages',
);
for (const name of Object.keys(APPS)) {
  await must(sh('pnpm', ['--filter', `@tms/${dirOf(name)}`, 'build']), `building ${name}`);
}
await must(compose('build', 'firebase-emulator'), 'building the emulator');
await must(
  compose('up', '-d', '--wait', 'postgres', 'rabbitmq', 'redis', 'firebase-emulator'),
  'starting infrastructure',
);
for (const name of Object.keys(APPS).filter((n) => APPS[n].env.DATABASE_URL)) {
  await must(
    sh('pnpm', ['--filter', `@tms/${dirOf(name)}`, 'exec', 'prisma', 'migrate', 'deploy'], {
      DATABASE_URL: APPS[name].env.DATABASE_URL,
    }),
    `migrating ${name}`,
  );
}
try {
  for (const name of Object.keys(APPS)) start(name);
  for (const name of Object.keys(APPS)) await ready(name);
} catch (err) {
  console.error(err.message);
  await finish(1);
}

// The outage scenario stops and starts a service: the tests ask here instead of docker.
const control = createServer(async (req, res) => {
  const [, action, service] = (req.url ?? '').split('/');
  const name = service?.replace('-service', '');
  if (!APPS[name] || !['stop', 'start'].includes(action)) return void res.writeHead(404).end();
  if (action === 'stop') await stop(name);
  else if (!running.has(name)) {
    start(name);
    await ready(name).catch(() => undefined);
  }
  res.writeHead(204).end();
});
await new Promise((r) => control.listen(0, '127.0.0.1', r));

const tests = spawn('pnpm', ['--filter', '@tms/e2e-tests', 'test:e2e', ...process.argv.slice(2)], {
  cwd: root,
  stdio: 'inherit',
  env: { ...process.env, E2E_HOST_CONTROL: onHost(control.address().port) },
  shell: process.platform === 'win32',
});
tests.on('exit', (code) => void finish(code ?? 1));
