/**
 * Helpers for the end-to-end suite (#21). The stack is the `tms-e2e` compose project
 * (docker-compose.e2e.yml), started by `pnpm test:e2e` (scripts/e2e.mjs).
 *
 * Every business call goes through the API gateway, signed in with real ID tokens from the
 * Firebase Auth Emulator. The only other doors are the test-only hooks (`/internal/test/*`,
 * E2E_HOOKS=true) that run periodic jobs at a chosen instant, and `docker compose stop` /
 * `start` for the outage scenario.
 */
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';

export const GATEWAY = process.env.E2E_GATEWAY ?? 'http://127.0.0.1:28080/api';
const EMULATOR = process.env.E2E_EMULATOR ?? 'http://127.0.0.1:29099';
export const HOOKS = {
  class: process.env.E2E_CLASS ?? 'http://127.0.0.1:23003',
  schedule: process.env.E2E_SCHEDULE ?? 'http://127.0.0.1:23004',
  billing: process.env.E2E_BILLING ?? 'http://127.0.0.1:23006',
};
const KEY = 'demo-key';

/** JSON from the API, read loosely by the assertions (the services own the real types). */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;
const HOUR = 3_600_000;

export interface Reply<T = Json> {
  status: number;
  body: T;
}

async function call<T>(url: string, init: RequestInit = {}): Promise<Reply<T>> {
  const res = await fetch(url, init);
  const text = await res.text();
  let body: unknown = text;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    // not JSON: keep the text
  }
  return { status: res.status, body: body as T };
}

const json = (body: unknown): RequestInit => ({
  headers: { 'content-type': 'application/json' },
  body: JSON.stringify(body),
});

async function emulator(path: string, body: unknown) {
  const r = await call<Json>(`${EMULATOR}/identitytoolkit.googleapis.com/v1/${path}?key=${KEY}`, {
    method: 'POST',
    ...json(body),
  });
  if (r.status !== 200) throw new Error(`emulator ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Google sign-in, as the frontend does it (the emulator's fake Google). */
function google(email: string): Promise<{ idToken: string; localId: string }> {
  const account = JSON.stringify({ sub: `google-${email}`, email, email_verified: true });
  return emulator('accounts:signInWithIdp', {
    postBody: `id_token=${encodeURIComponent(account)}&providerId=google.com`,
    requestUri: 'http://localhost',
    returnSecureToken: true,
    returnIdpCredential: true,
  });
}

/** A client that calls the gateway as one signed-in user. */
export class Client {
  constructor(
    public token: string,
    readonly email: string,
  ) {}

  /** Signs in again so new custom claims (role, userId) are in the ID token. */
  async refresh() {
    this.token = (await google(this.email)).idToken;
  }

  request<T = Json>(
    method: string,
    path: string,
    body?: unknown,
    headers: Record<string, string> = {},
  ): Promise<Reply<T>> {
    return call<T>(`${GATEWAY}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${this.token}`,
        ...(body !== undefined && { 'content-type': 'application/json' }),
        ...headers,
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
  }
  get = <T = Json>(path: string) => this.request<T>('GET', path);
  post = <T = Json>(path: string, body: unknown = {}) => this.request<T>('POST', path, body);
  put = <T = Json>(path: string, body: unknown) => this.request<T>('PUT', path, body);
  patch = <T = Json>(path: string, body: unknown) => this.request<T>('PATCH', path, body);
  delete = <T = Json>(path: string) => this.request<T>('DELETE', path);
}

/** Calls the gateway without a token (what an anonymous client does). */
export const anonymous = <T = Json>(path: string, headers: Record<string, string> = {}) =>
  call<T>(`${GATEWAY}${path}`, { headers });

/**
 * A signed-in user with the role + userId claims set directly in the emulator, as Identity
 * would after an invitation (#58: an Admin to read the audit trail, a Payer with a bank
 * account). Only claims-checking services see them; Identity has no row for them.
 */
export async function withClaims(role: 'ADMIN' | 'PARENT', userId = randomUUID()) {
  const email = `${role.toLowerCase()}.${randomUUID().slice(0, 8)}@e2e.test`;
  const { localId, idToken } = await google(email);
  const r = await call(
    `${EMULATOR}/identitytoolkit.googleapis.com/v1/projects/demo-tms/accounts:update`,
    {
      method: 'POST',
      headers: { 'content-type': 'application/json', authorization: 'Bearer owner' },
      body: JSON.stringify({ localId, customAttributes: JSON.stringify({ role, userId }) }),
    },
  );
  if (r.status !== 200) throw new Error(`claims: ${r.status} ${JSON.stringify(r.body)}`);
  const client = new Client(idToken, email);
  await client.refresh();
  return { client, userId };
}

/** A brand-new Tutor: Firebase account → POST /api/auth/register → token with the claims. */
export async function newTutor(): Promise<Client> {
  const email = `tutor.${randomUUID().slice(0, 8)}@e2e.test`;
  const { idToken } = await google(email);
  const client = new Client(idToken, email);
  const reg = await client.post('/auth/register', { role: 'TUTOR' });
  if (reg.status !== 201) throw new Error(`register: ${reg.status} ${JSON.stringify(reg.body)}`);
  await client.refresh();
  return client;
}

/** POST to a test-only hook on a service (never through the gateway). */
export async function hook<T = Json>(service: keyof typeof HOOKS, path: string, body?: unknown) {
  const r = await call<T>(`${HOOKS[service]}/internal/test/${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    ...(body !== undefined && json(body)),
  });
  if (r.status >= 300)
    throw new Error(`hook ${service} ${path}: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body;
}

/** Retries `check` until it stops throwing: events travel through RabbitMQ asynchronously. */
export async function eventually<T>(
  check: () => Promise<T>,
  timeoutMs = 30_000,
  everyMs = 500,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  let last: unknown;
  while (Date.now() < deadline) {
    try {
      return await check();
    } catch (err) {
      last = err;
      await new Promise((r) => setTimeout(r, everyMs));
    }
  }
  throw last;
}

/**
 * `docker compose` on the e2e project (used only for the outage scenario). When the services
 * run as plain processes (scripts/e2e-host.mjs), that runner stops and starts them instead.
 */
export function compose(...args: string[]) {
  const control = process.env.E2E_HOST_CONTROL;
  if (control) {
    const action = args[0] === 'stop' ? 'stop' : 'start';
    const url = `${control}/${action}/${args.at(-1)}`;
    const script = 'fetch(process.argv[1]).then((r) => process.exit(r.ok ? 0 : 1))';
    const done = spawnSync(process.execPath, ['-e', script, url], { encoding: 'utf8' });
    if (done.status !== 0) throw new Error(`${url}: ${done.stderr}`);
    return done.stdout;
  }
  const root = resolve(__dirname, '../../..');
  const r = spawnSync(
    'docker',
    [
      'compose',
      '-p',
      'tms-e2e',
      '-f',
      'docker-compose.yml',
      '-f',
      'docker-compose.e2e.yml',
      ...args,
    ],
    { cwd: root, encoding: 'utf8', env: { ...process.env, COMPOSE_BAKE: 'false' } },
  );
  if (r.status !== 0) throw new Error(`docker compose ${args.join(' ')}: ${r.stderr}`);
  return r.stdout;
}

// ---------------------------------------------------------------- dates (Vietnam, UTC+7)

/** `YYYY-MM-DD` in Vietnam for an instant. */
export const vnDate = (d: Date = new Date()) =>
  new Date(d.getTime() + 7 * HOUR).toISOString().slice(0, 10);
export const vnPeriod = (d: Date = new Date()) => vnDate(d).slice(0, 7);
export function addDays(date: string, days: number) {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}
export function nextPeriod(period: string) {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
/** The instant of a local Vietnam date and time. */
export const vnInstant = (date: string, time = '00:00') => new Date(`${date}T${time}:00+07:00`);

// ---------------------------------------------------------------- domain shortcuts

/** A minor Student with a primary Parent (no invitation e-mail). */
export async function newStudent(tutor: Client, fullName = 'Nguyễn An') {
  const r = await tutor.post('/students', {
    fullName,
    dob: '2012-05-04',
    invite: false,
    parents: [
      {
        fullName: 'Trần Lan',
        phone: '0901234567',
        email: `lan.${randomUUID().slice(0, 6)}@e2e.test`,
        isPrimary: true,
      },
    ],
  });
  if (r.status !== 201) throw new Error(`create student: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string; fullName: string };
}

export async function newClass(
  tutor: Client,
  feeType: 'MONTHLY' | 'PER_SESSION',
  feeAmount: number,
) {
  const r = await tutor.post('/classes', {
    name: `${feeType} ${randomUUID().slice(0, 4)}`,
    subject: 'Toán',
    type: 'GROUP',
    maxStudents: 6,
    feeType,
    feeAmount,
    chargeAbsent: true,
  });
  if (r.status !== 201) throw new Error(`create class: ${r.status} ${JSON.stringify(r.body)}`);
  return r.body as { id: string };
}
