/**
 * Where each public API path goes (docs/02-cac-service.md §2). Paths are matched
 * after the `/api` prefix is removed; the downstream service receives the same path.
 */
export type ServiceKey = 'identity' | 'student' | 'class' | 'schedule' | 'billing';

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
  };
}

/** Most distinct route labels the gateway reports; further ones become `OTHER`. */
const MAX_ROUTE_LABELS = 300;
const seenRouteLabels = new Set<string>();

/** A path segment that names a resource (`invoices`, `open-invoices`, `me`), not an id. */
const STATIC_SEGMENT = /^[a-z][a-z-]{0,39}$/;

/**
 * The route template a request is reported under in metrics, e.g.
 * `/billing/invoices/3f…/qr` → `/billing/invoices/:id/qr`. Ids, tokens and anything that
 * is not a plain word become `:id`, so a label never carries user data and the number of
 * series stays bounded even when clients send arbitrary paths.
 */
export function routeLabel(path: string, resolution: Resolution): string {
  if (resolution.kind === 'not-found') return 'UNMATCHED';
  const segments = path.split('/').filter(Boolean);
  if (resolution.kind === 'not-implemented') return `/${segments[0]}/**`;
  const label =
    '/' +
    segments
      .map((s) => (s.endsWith('.ics') ? ':token.ics' : STATIC_SEGMENT.test(s) ? s : ':id'))
      .join('/');
  if (seenRouteLabels.has(label)) return label;
  if (seenRouteLabels.size >= MAX_ROUTE_LABELS) return 'OTHER';
  seenRouteLabels.add(label);
  return label;
}
