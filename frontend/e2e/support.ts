/**
 * Test helpers: accounts in the Firebase Auth Emulator, and a stub for the gateway (`/api/*`)
 * that records every request so tests can check method, path, body and Authorization.
 */
import { randomUUID } from 'node:crypto';
import { expect, type Page, type Route } from '@playwright/test';
import { API_URL } from '../playwright.config';

const EMULATOR = 'http://127.0.0.1:9099';
const PROJECT = 'demo-tms';
const KEY = 'demo-key';

export type Role = 'ADMIN' | 'TUTOR' | 'PARENT' | 'STUDENT';

export interface TestUser {
  email: string;
  password: string;
  uid: string;
  userId: string;
  role: Role | null;
}

async function emulator(path: string, body: unknown, admin = false) {
  const res = await fetch(`${EMULATOR}${path}`, {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      ...(admin && { authorization: 'Bearer owner' }),
    },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`emulator ${path}: ${res.status} ${await res.text()}`);
  return res.json();
}

/** Sets `role` + `userId` custom claims, as Identity does. */
export async function setClaims(uid: string, claims: Record<string, string>) {
  await emulator(
    `/identitytoolkit.googleapis.com/v1/projects/${PROJECT}/accounts:update`,
    { localId: uid, customAttributes: JSON.stringify(claims) },
    true,
  );
}

/** A fresh emulator account, with claims unless `role` is null. */
export async function createUser(role: Role | null, password = 'matkhau123'): Promise<TestUser> {
  const email = `${(role ?? 'none').toLowerCase()}.${randomUUID().slice(0, 8)}@example.com`;
  const { localId } = await emulator(
    `/identitytoolkit.googleapis.com/v1/accounts:signUp?key=${KEY}`,
    {
      email,
      password,
      returnSecureToken: true,
    },
  );
  const userId = randomUUID();
  if (role) await setClaims(localId, { role, userId });
  return { email, password, uid: localId, userId, role };
}

/** The Firebase uid inside an ID token (no signature check: the emulator issued it). */
export function uidOf(authorization: string | undefined): string | undefined {
  const token = authorization?.replace(/^Bearer /, '');
  if (!token) return undefined;
  const payload = JSON.parse(Buffer.from(token.split('.')[1], 'base64url').toString());
  return payload.user_id ?? payload.sub;
}

export interface Recorded {
  method: string;
  path: string;
  query: URLSearchParams;
  body: unknown;
  authorization?: string;
}

type Reply = { status?: number; body?: unknown } | undefined;
type Handler = (req: Recorded, route: Route) => Reply | Promise<Reply>;

/**
 * Stubs the gateway. Keys are `METHOD /path` (path after `/api`, `:param` segments allowed).
 * Unmatched requests answer 501 and are recorded, so a forgotten stub fails loudly.
 */
export async function stubApi(page: Page, handlers: Record<string, Handler | Reply>) {
  const calls: Recorded[] = [];
  const unmatched: string[] = [];
  const table = Object.entries(handlers).map(([key, h]) => {
    const [method, pattern] = key.split(' ');
    const re = new RegExp(`^${pattern.replace(/:[^/]+/g, '[^/]+')}$`);
    return { method, re, h };
  });
  await page.route(`${API_URL}/**`, async (route) => {
    const req = route.request();
    const url = new URL(req.url());
    const path = url.pathname.replace(/^\/api/, '');
    const rec: Recorded = {
      method: req.method(),
      path,
      query: url.searchParams,
      body: req.postData() ? JSON.parse(req.postData()!) : undefined,
      authorization: (await req.allHeaders()).authorization,
    };
    calls.push(rec);
    const match = table.find((t) => t.method === rec.method && t.re.test(path));
    if (!match) {
      unmatched.push(`${rec.method} ${path}`);
      return route.fulfill({ status: 501, json: { message: `no stub for ${rec.method} ${path}` } });
    }
    const reply = typeof match.h === 'function' ? await match.h(rec, route) : match.h;
    await route.fulfill({ status: reply?.status ?? 200, json: reply?.body ?? {} });
  });
  return {
    calls,
    unmatched,
    /** The recorded calls for `METHOD /path`. */
    find: (method: string, path: string) =>
      calls.filter((c) => c.method === method && c.path === path),
  };
}

export async function signIn(page: Page, user: TestUser) {
  await page.goto('/login');
  await page.getByLabel('Email').fill(user.email);
  await page.getByLabel('Mật khẩu').fill(user.password);
  await page.getByRole('button', { name: 'Đăng nhập' }).click();
}

/** Every recorded API call carried the signed-in user's ID token. */
export function expectBearer(calls: Recorded[], user: TestUser) {
  for (const c of calls) expect(uidOf(c.authorization), `${c.method} ${c.path}`).toBe(user.uid);
}

export const meOf = (u: TestUser) => ({
  id: u.userId,
  email: u.email,
  role: u.role,
  status: 'ACTIVE',
  createdAt: '2026-11-01T00:00:00.000Z',
});
