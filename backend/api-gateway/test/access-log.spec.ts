import { queryKeysOf, sanitizePath } from '../src/gateway/access-log';

describe('Access record fields (#55)', () => {
  it('drops the query string and keeps ids in the path', () => {
    expect(sanitizePath('/students/00000000-0000-4000-8000-000000000001?x=1')).toBe(
      '/students/00000000-0000-4000-8000-000000000001',
    );
    expect(sanitizePath('')).toBe('/');
  });

  it('replaces secret path segments with :token', () => {
    expect(sanitizePath('/auth/invitations/abc.DEF-123/accept')).toBe(
      '/auth/invitations/:token/accept',
    );
    expect(sanitizePath('/calendar/s3cr3t.ics?download=1')).toBe('/calendar/:token.ics');
    expect(sanitizePath('/auth/invitations')).toBe('/auth/invitations');
  });

  it('caps the path length', () => {
    expect(sanitizePath('/' + 'a'.repeat(1000))).toHaveLength(512);
  });

  it('keeps query parameter names once each, never values', () => {
    expect(queryKeysOf('/students?q=Nguyen&status=ACTIVE&q=Tran')).toEqual(['q', 'status']);
    expect(queryKeysOf('/students')).toEqual([]);
    const many = '/x?' + Array.from({ length: 40 }, (_, i) => `k${i}=v`).join('&');
    expect(queryKeysOf(many)).toHaveLength(32);
  });
});
