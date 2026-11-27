// `pnpm setup:env`: create local env files from their examples, never overwriting.
// - .env (docker compose) from .env.example; NEXT_PUBLIC_* filled from frontend/.env.local
// - backend/<service>/.env (host-side migrations and `pnpm dev`) from each .env.example
import { randomBytes } from 'node:crypto';
import { copyFileSync, existsSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const created = [];

const parseEnv = (text) =>
  Object.fromEntries(
    text
      .split(/\r?\n/)
      .map((line) => line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/))
      .filter(Boolean)
      .map(([, k, v]) => [k, v]),
  );

function copyIfMissing(dir) {
  const example = join(dir, '.env.example');
  const target = join(dir, '.env');
  if (existsSync(example) && !existsSync(target)) {
    copyFileSync(example, target);
    created.push(target);
  }
}

copyIfMissing(root);
for (const name of readdirSync(join(root, 'backend'))) copyIfMissing(join(root, 'backend', name));

// The frontend's Firebase web config already lives in frontend/.env.local; reuse it
// for the docker build args instead of asking for it twice. Only fills empty values.
const rootEnv = join(root, '.env');
const frontendEnv = join(root, 'frontend', '.env.local');
if (existsSync(frontendEnv)) {
  const fromFrontend = parseEnv(readFileSync(frontendEnv, 'utf8'));
  let text = readFileSync(rootEnv, 'utf8');
  let filled = 0;
  text = text.replace(/^(NEXT_PUBLIC_[A-Z0-9_]+)=(.*)$/gm, (line, key, value) => {
    if (value.trim() !== '' || !fromFrontend[key]) return line;
    filled++;
    return `${key}=${fromFrontend[key]}`;
  });
  if (filled > 0) {
    writeFileSync(rootEnv, text);
    console.log(`Filled ${filled} NEXT_PUBLIC_* value(s) in .env from frontend/.env.local`);
  }
}

// Encryption key for bank details (ADR-0006): generated once, never overwritten.
{
  const text = readFileSync(rootEnv, 'utf8');
  if (/^BANK_DATA_KEY=[ \t]*$/m.test(text)) {
    const key = randomBytes(32).toString('base64');
    writeFileSync(rootEnv, text.replace(/^BANK_DATA_KEY=[ \t]*$/m, `BANK_DATA_KEY=${key}`));
    console.log('Generated BANK_DATA_KEY in .env (keep it secret; do not change it later).');
  }
}

// Encrypts tutor-service files (docs/07 §5): generated once, never overwritten.
{
  const text = readFileSync(rootEnv, 'utf8');
  if (/^FILE_DATA_KEY=[ \t]*$/m.test(text)) {
    const key = randomBytes(32).toString('base64');
    writeFileSync(rootEnv, text.replace(/^FILE_DATA_KEY=[ \t]*$/m, `FILE_DATA_KEY=${key}`));
    console.log('Generated FILE_DATA_KEY in .env (keep it secret; do not change it later).');
  }
}

// Signs payroll payment notices (docs/07 §6): generated once, never overwritten.
{
  const text = readFileSync(rootEnv, 'utf8');
  if (/^PAYOUT_WEBHOOK_SECRET=[ \t]*$/m.test(text)) {
    const secret = randomBytes(32).toString('hex');
    writeFileSync(
      rootEnv,
      text.replace(/^PAYOUT_WEBHOOK_SECRET=[ \t]*$/m, `PAYOUT_WEBHOOK_SECRET=${secret}`),
    );
    console.log('Generated PAYOUT_WEBHOOK_SECRET in .env.');
  }
}

console.log(
  created.length
    ? `Created:\n${created.map((f) => `  ${f}`).join('\n')}`
    : 'All env files already exist; nothing overwritten.',
);
if (!existsSync(join(root, 'infra', 'keys', 'firebase-service-account.json'))) {
  console.log(
    'Note: infra/keys/firebase-service-account.json is missing; the gateway and identity-service need it to verify sign-ins.',
  );
}
