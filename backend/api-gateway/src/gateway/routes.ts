/**
 * Where each public API path goes (docs/02-cac-service.md §2). Paths are matched
 * after the `/api` prefix is removed; the downstream service receives the same path.
 */
export type ServiceKey = 'identity' | 'student' | 'class' | 'schedule' | 'billing' | 'audit';

export type Access =
  /** No token at all (invitation accept, iCal feed with its own token). */
  | 'public'
  /** A valid ID token without a role yet (Tutor self-signup); the token is forwarded. */
  | 'token-only'
  /** A valid ID token with `userId` + `role` claims (everything else). */
  | 'role';

export type Resolution =
  | { kind: 'service'; service: ServiceKey; access: Access }
  | { kind: 'not-implemented' }
  | { kind: 'not-found' };

/** Specific paths that belong to another service than their first segment suggests. */
const EXCEPTIONS: { method?: string; pattern: RegExp; service: ServiceKey; access: Access }[] = [
  {
    method: 'POST',
    pattern: /^\/auth\/invitations\/[^/]+\/accept$/,
    service: 'identity',
    access: 'public',
  },
  { method: 'POST', pattern: /^\/auth\/register$/, service: 'identity', access: 'token-only' },
  { pattern: /^\/students\/[^/]+\/classes$/, service: 'class', access: 'role' },
  { pattern: /^\/students\/[^/]+\/attendance$/, service: 'schedule', access: 'role' },
  { method: 'GET', pattern: /^\/calendar\/[^/]+\.ics$/, service: 'schedule', access: 'public' },
];

const BY_PREFIX: Record<string, ServiceKey | 'not-implemented'> = {
  auth: 'identity',
  users: 'identity',
  students: 'student',
  parents: 'student',
  classes: 'class',
  schedules: 'schedule',
  sessions: 'schedule',
  billing: 'billing',
  audit: 'audit', // Admin-only audit trail (ADR-0005)
  // Out of MVP scope (BR-SYS-03).
  academic: 'not-implemented',
  notifications: 'not-implemented',
  webhooks: 'not-implemented',
};

export function resolveRoute(method: string, path: string): Resolution {
  // Service-to-service endpoints are never reachable through the gateway.
  if (/(^|\/)internal(\/|$)/.test(path)) return { kind: 'not-found' };

  for (const route of EXCEPTIONS) {
    if ((!route.method || route.method === method) && route.pattern.test(path)) {
      return { kind: 'service', service: route.service, access: route.access };
    }
  }
  const target = BY_PREFIX[path.split('/')[1] ?? ''];
  if (!target) return { kind: 'not-found' };
  if (target === 'not-implemented') return { kind: 'not-implemented' };
  return { kind: 'service', service: target, access: 'role' };
}

export function serviceUrls(env: NodeJS.ProcessEnv = process.env): Record<ServiceKey, string> {
  return {
    identity: env.IDENTITY_SERVICE_URL ?? 'http://identity-service:3001',
    student: env.STUDENT_SERVICE_URL ?? 'http://student-service:3002',
    class: env.CLASS_SERVICE_URL ?? 'http://class-service:3003',
    schedule: env.SCHEDULE_SERVICE_URL ?? 'http://schedule-service:3004',
    billing: env.BILLING_SERVICE_URL ?? 'http://billing-service:3006',
    audit: env.AUDIT_SERVICE_URL ?? 'http://audit-service:3008',
  };
}
