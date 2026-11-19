import { ageOn, checkPayer, checkSinglePrimary, todayInVietnam } from '../src/students/rules';

describe('Student rules', () => {
  it('computes age in whole years, birthday inclusive', () => {
    expect(ageOn('2008-11-19', '2026-11-19')).toBe(18);
    expect(ageOn('2008-11-20', '2026-11-19')).toBe(17);
    expect(ageOn('2008-12-01', '2026-11-19')).toBe(17);
    expect(ageOn('2009-02-28', '2027-02-28')).toBe(18);
  });

  it('uses the Vietnamese calendar day (BR-SYS-02)', () => {
    // 2026-11-18T18:30Z is already 19 November in Asia/Ho_Chi_Minh (UTC+7).
    expect(todayInVietnam(new Date('2026-11-18T18:30:00Z'))).toBe('2026-11-19');
  });

  const minorDob = `${new Date().getFullYear() - 10}-01-01`;
  const adultDob = `${new Date().getFullYear() - 30}-01-01`;

  it.each([
    [
      'a minor without a primary Parent',
      { dob: minorDob, payer: 'PRIMARY_PARENT', hasPrimaryParent: false },
      /under 18/,
    ],
    [
      'a minor paying for themselves',
      { dob: minorDob, payer: 'SELF', hasPrimaryParent: true, email: 'a@b.co' },
      /primary Parent \(BR-ST-05\)/,
    ],
    [
      'Payer = primary Parent without one',
      { dob: adultDob, payer: 'PRIMARY_PARENT', hasPrimaryParent: false },
      /there is none/,
    ],
    [
      'a self-paying adult without email',
      { dob: adultDob, payer: 'SELF', hasPrimaryParent: false },
      /needs an email/,
    ],
  ] as const)('rejects %s', (_case, input, message) => {
    expect(() => checkPayer(input)).toThrow(message);
  });

  it.each([
    [
      'a minor paid by the primary Parent',
      { dob: minorDob, payer: 'PRIMARY_PARENT', hasPrimaryParent: true },
    ],
    [
      'a self-paying adult with email',
      { dob: adultDob, payer: 'SELF', hasPrimaryParent: false, email: 'a@b.co' },
    ],
    [
      'an adult paid by a Parent',
      { dob: adultDob, payer: 'PRIMARY_PARENT', hasPrimaryParent: true },
    ],
  ] as const)('accepts %s', (_case, input) => {
    expect(() => checkPayer(input)).not.toThrow();
  });

  it('allows at most one primary Parent', () => {
    expect(() => checkSinglePrimary([{ isPrimary: true }, { isPrimary: false }])).not.toThrow();
    expect(() => checkSinglePrimary([{ isPrimary: true }, { isPrimary: true }])).toThrow(
      /exactly one/,
    );
  });
});
