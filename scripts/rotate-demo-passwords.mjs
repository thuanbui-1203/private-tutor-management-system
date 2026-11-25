// Gives the demo accounts (admin@tms.local, *@tms.demo) new random passwords and signs them out
// everywhere. Their old passwords were committed to this public repo, so they must be changed.
//
//   node scripts/rotate-demo-passwords.mjs            # only lists the accounts it would change
//   node scripts/rotate-demo-passwords.mjs --apply    # changes them
//
// Works on the Firebase project in FIREBASE_PROJECT_ID (.env), which the VPS shares: the new
// passwords apply there too. They are written to dumps/demo-passwords.txt (git-ignored).
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
// firebase-admin is a dependency of identity-service only.
const require = createRequire(join(root, 'backend/identity-service/package.json'));
const { cert, initializeApp } = require('firebase-admin/app');
const { getAuth } = require('firebase-admin/auth');

const apply = process.argv.includes('--apply');
const projectId = readFileSync(join(root, '.env'), 'utf8').match(
  /^FIREBASE_PROJECT_ID=(.+?)\s*$/m,
)?.[1];
const keyDir = join(root, 'infra/keys');
const keyFile = existsSync(keyDir) && readdirSync(keyDir).find((f) => f.endsWith('.json'));
if (!projectId || !keyFile) {
  console.error('need FIREBASE_PROJECT_ID in .env and a service account key in infra/keys/');
  process.exit(1);
}

const key = JSON.parse(readFileSync(join(keyDir, keyFile), 'utf8'));
if (key.project_id !== projectId) {
  console.error(`the key is for ${key.project_id}, but .env says ${projectId}: stopping`);
  process.exit(1);
}
initializeApp({ projectId, credential: cert(key) });
const auth = getAuth();
const isDemo = (email) => email === 'admin@tms.local' || email?.endsWith('@tms.demo');

const users = [];
let pageToken;
do {
  const page = await auth.listUsers(1000, pageToken);
  users.push(...page.users.filter((u) => isDemo(u.email)));
  pageToken = page.pageToken;
} while (pageToken);

console.log(`${users.length} demo account(s) on ${projectId}:`);
for (const u of users) console.log(`  ${u.email}`);
if (!apply) {
  console.log('\nNothing changed. Run again with --apply to change their passwords.');
} else if (users.length > 0) {
  const demoPassword = randomBytes(12).toString('base64url');
  const adminPassword = randomBytes(18).toString('base64url');
  // Saved first: if a later step fails, the new passwords are not lost.
  mkdirSync(join(root, 'dumps'), { recursive: true });
  writeFileSync(
    join(root, 'dumps/demo-passwords.txt'),
    `admin@tms.local: ${adminPassword}\n*@tms.demo: ${demoPassword}\n`,
    { mode: 0o600 },
  );
  for (const u of users) {
    await auth.updateUser(u.uid, {
      password: u.email === 'admin@tms.local' ? adminPassword : demoPassword,
    });
    await auth.revokeRefreshTokens(u.uid);
    console.log(`✓ ${u.email}`);
  }
  console.log('\nNew passwords are in dumps/demo-passwords.txt (git-ignored).');
}
