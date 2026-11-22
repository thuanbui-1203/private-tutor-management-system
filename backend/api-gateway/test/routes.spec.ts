import { resolveRoute, routeLabel } from '../src/gateway/routes';

describe('gateway route table (docs/02 §2)', () => {
  it.each([
    ['GET', '/users/me', 'identity', 'role'],
    ['POST', '/auth/register', 'identity', 'token-only'],
    ['POST', '/auth/invitations/abc/accept', 'identity', 'public'],
    ['POST', '/auth/invitations', 'identity', 'role'],
    ['GET', '/students', 'student', 'role'],
    ['GET', '/parents/me/children', 'student', 'role'],
    ['GET', '/students/42/classes', 'class', 'role'],
    ['GET', '/students/42/attendance', 'schedule', 'role'],
    ['POST', '/classes/1/enrollments', 'class', 'role'],
    ['PUT', '/sessions/1/attendance', 'schedule', 'role'],
    ['GET', '/schedules', 'schedule', 'role'],
    ['GET', '/calendar/tok.ics', 'schedule', 'public'],
    ['GET', '/billing/invoices', 'billing', 'role'],
    ['GET', '/audit/access', 'audit', 'role'],
  ])('%s %s → %s (%s)', (method, path, service, access) => {
    expect(resolveRoute(method, path)).toEqual({ kind: 'service', service, access });
  });

  it('never exposes /internal paths', () => {
    expect(resolveRoute('GET', '/internal/students/1').kind).toBe('not-found');
    expect(resolveRoute('GET', '/students/internal').kind).toBe('not-found');
    expect(resolveRoute('POST', '/auth/internal/x').kind).toBe('not-found');
  });

  it('answers 501 for services outside the MVP and 404 for unknown prefixes', () => {
    expect(resolveRoute('GET', '/academic/grades').kind).toBe('not-implemented');
    expect(resolveRoute('GET', '/notifications/me').kind).toBe('not-implemented');
    expect(resolveRoute('GET', '/nope').kind).toBe('not-found');
  });

  it('only GET is public on the iCal feed, only POST on invitation accept', () => {
    expect(resolveRoute('DELETE', '/calendar/tok.ics').kind).toBe('not-found');
    expect(resolveRoute('GET', '/auth/invitations/abc/accept')).toMatchObject({ access: 'role' });
  });
});

describe('routeLabel (metrics)', () => {
  const label = (method: string, path: string) => routeLabel(path, resolveRoute(method, path));

  it.each([
    [
      'GET',
      '/billing/invoices/3f2c1a9e-0000-4000-8000-000000000001/qr',
      '/billing/invoices/:id/qr',
    ],
    ['GET', '/students/42/classes', '/students/:id/classes'],
    ['POST', '/auth/invitations/AbC_123xyz/accept', '/auth/invitations/:id/accept'],
    ['GET', '/calendar/secret-token.ics', '/calendar/:token.ics'],
    ['GET', '/users/me', '/users/me'],
    ['GET', '/billing/students/1/open-invoices', '/billing/students/:id/open-invoices'],
    ['GET', '/academic/grades/1', '/academic/**'],
    ['GET', '/wp-admin/setup.php', 'UNMATCHED'],
    ['GET', '/students/internal/x', 'UNMATCHED'],
  ])('%s %s → %s', (method, path, expected) => {
    expect(label(method, path)).toBe(expected);
  });
});
