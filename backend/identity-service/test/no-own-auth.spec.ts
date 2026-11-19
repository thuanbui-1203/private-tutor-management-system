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

  const root = join(__dirname, '..');
  const sources = [...files(join(root, 'src')), join(root, 'prisma', 'schema.prisma')].map(
    (path) => ({ path, text: readFileSync(path, 'utf8') }),
  );
  const deps = Object.keys(
    JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {},
  );

  it.each([
    ['password hashing', /bcrypt|argon2|scrypt|password_?hash/i],
    ['JWT signing', /jsonwebtoken|\bjwt\.sign\b|RS256/i],
    ['a refresh-token table', /refresh_?tokens?/i],
    ['a JWKS endpoint', /jwks/i],
  ])('has no %s', (_what, pattern) => {
    expect(sources.filter((s) => pattern.test(s.text)).map((s) => s.path)).toEqual([]);
    expect(deps.filter((d) => pattern.test(d))).toEqual([]);
  });
});
