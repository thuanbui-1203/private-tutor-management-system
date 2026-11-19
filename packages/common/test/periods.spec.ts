import { currentPeriod, nextPeriod, periodOf, todayInVietnam } from '../src';

describe('periods (Vietnam time)', () => {
  it('uses the Vietnamese calendar day', () => {
    expect(todayInVietnam(new Date('2026-11-30T17:30:00Z'))).toBe('2026-12-01'); // already 1 Dec in UTC+7
    expect(currentPeriod(new Date('2026-11-30T17:30:00Z'))).toBe('2026-12');
  });

  it('rolls the period over months and years', () => {
    expect(nextPeriod('2026-11')).toBe('2026-12');
    expect(nextPeriod('2026-12')).toBe('2027-01');
    expect(periodOf('2026-02-28')).toBe('2026-02');
  });
});
