// `pnpm test:e2e`: the end-to-end suite (#21) against a throwaway stack.
//   1. `tms-e2e` compose project (docker-compose.yml + docker-compose.e2e.yml): own databases,
//      production images, Firebase Auth Emulator container, ports 2xxxx on 127.0.0.1 only.
//   2. Prisma migrations of every service applied to that database.
//   3. The services, then the tests (tests/e2e), all through the API gateway.
//   4. The stack is removed again (volumes included), unless `--keep`.
// Options: --keep (leave the stack running), --reuse (skip the fresh start; for re-running
// tests quickly; the month close in scenario 4 makes a second run on the same data differ).
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const args = new Set(process.argv.slice(2));
const env = {
  ...process.env,
  COMPOSE_BAKE: 'false',
  COMPOSE_PARALLEL_LIMIT: process.env.COMPOSE_PARALLEL_LIMIT ?? '2',
};
const COMPOSE = [
  'compose',
  '-p',
  'tms-e2e',
  '-f',
  'docker-compose.yml',
  '-f',
  'docker-compose.e2e.yml',
];
const INFRA = ['postgres', 'rabbitmq', 'redis', 'firebase-emulator'];
const APPS = [
  'identity-service',
  'student-service',
  'class-service',
  'schedule-service',
  'billing-service',
  'audit-service',
  'tutor-service',
  'api-gateway',
];
const DATABASES = {
  identity: 'IDENTITY_DB_URL',
  student: 'STUDENT_DB_URL',
  class: 'CLASS_DB_URL',
  schedule: 'SCHEDULE_DB_URL',
  billing: 'BILLING_DB_URL',
  audit: 'AUDIT_DB_URL',
  tutor: 'TUTOR_DB_URL',
};

function run(cmd, cmdArgs, extraEnv = {}) {
  console.log(`\n$ ${cmd} ${cmdArgs.join(' ')}`);
  const r = spawnSync(cmd, cmdArgs, {
    cwd: root,
    stdio: 'inherit',
    env: { ...env, ...extraEnv },
    shell: process.platform === 'win32' && cmd === 'pnpm',
  });
  return r.status ?? 1;
}
// Through the repo's `pnpm compose` wrapper: launched straight from Git Bash, Compose's Bake
// builder demanded an extra `--allow=fs.read=<Dockerfile>` entitlement; launched by pnpm it
// does not (the environments differ only in PATH and pnpm's own variables).
const compose = (...a) => run('pnpm', ['compose', ...COMPOSE.slice(1), ...a]);
const must = (code, what) => {
  if (code !== 0) {
    console.error(`\n✗ ${what} failed (exit ${code})`);
    if (!args.has('--keep')) compose('down', '-v');
    process.exit(code);
  }
};

const envFile = join(root, '.env');
if (!existsSync(envFile)) must(1, '.env is missing: run `pnpm setup:env` first');
const dotenv = Object.fromEntries(
  readFileSync(envFile, 'utf8')
    .split(/\r?\n/)
    .map((l) => l.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
    .filter(Boolean)
    .map(([, k, v]) => [k, v]),
);

if (!args.has('--reuse')) compose('down', '-v');
must(compose('build', 'firebase-emulator'), 'building the emulator');
must(compose('up', '-d', '--wait', ...INFRA), 'starting infrastructure');

for (const [service, key] of Object.entries(DATABASES)) {
  const url = dotenv[key]?.replace('@postgres:5432', '@127.0.0.1:25432');
  if (!url) must(1, `${key} missing in .env`);
  must(
    run('pnpm', ['--filter', `@tms/${service}-service`, 'exec', 'prisma', 'migrate', 'deploy'], {
      DATABASE_URL: url,
    }),
    `migrating ${service}`,
  );
}

// One image at a time: Compose v5 builds through Bake, which ignores COMPOSE_PARALLEL_LIMIT,
// and six parallel builds ran Docker Desktop's VM out of memory ("rpc error ... EOF").
for (const app of APPS) must(compose('build', app), `building ${app}`);
must(compose('up', '-d', '--wait', ...APPS), 'starting the services');
const code = run('pnpm', ['--filter', '@tms/e2e-tests', 'test:e2e']);
if (code !== 0) compose('logs', '--tail', '80', ...APPS);
if (!args.has('--keep')) compose('down', '-v');
else
  console.log(
    '\nStack kept: gateway http://127.0.0.1:28080/api — remove with `pnpm test:e2e:down`.',
  );
process.exit(code);
