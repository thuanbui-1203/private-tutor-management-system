import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

// #6 / ADR-0004: Firebase owns credentials. This guards against anyone adding
// password hashing, JWT signing, a refresh-token table or a JWKS endpoint back.
describe('Identity has no home-grown credential handling (ADR-0004)', () => {
  const files = (dir: string): string[] =>
    readdirSync(dir).flatMap((name) => {
      const path = join(dir, name);
      if (name === 'generated') return [];
      return statSync(path).isDirectory() ? files(path) : [path];
    });
  const read = (paths: string[]) =>
    paths.map((path) => ({ path, text: readFileSync(path, 'utf8') }));

  const root = join(__dirname, '..');
  const code = read(files(join(root, 'src')));
  // Schema and migrations: where a table of our own would have to appear.
  const storage = read([
    join(root, 'prisma', 'schema.prisma'),
    ...files(join(root, 'prisma', 'migrations')),
  ]);
  const deps = Object.keys(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {},
  );
  const matching = (sources: { path: string; text: string }[], pattern: RegExp) =>
    sources.filter((s) => pattern.test(s.text)).map((s) => s.path);

  it.each([
    ['password hashing', /bcrypt|argon2|scrypt|password_?hash/i],
    ['JWT signing', /jsonwebtoken|\bjwt\.sign\b|RS256/i],
    ['a JWKS endpoint', /jwks/i],
  ])('has no %s in code, schema or dependencies', (_what, pattern) => {
    expect(matching([...code, ...storage], pattern)).toEqual([]);
    expect(deps.filter((d) => pattern.test(d))).toEqual([]);
  });

  // Revoking Firebase's refresh tokens (auth.revokeRefreshTokens) is required by
  // ADR-0004, so only the schema and migrations are checked for our own table.
  it('has no refresh-token table of its own', () => {
    expect(matching(storage, /refresh_?tokens?/i)).toEqual([]);
  });
});
