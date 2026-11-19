import { addDays, addMonths, isoWeekday, plan, toInstant } from '../src/schedules/calendar';

describe('calendar (Asia/Ho_Chi_Minh)', () => {
  it('converts local Vietnam time to UTC (UTC+7, no DST)', () => {
    expect(toInstant('2026-11-19', '19:00').toISOString()).toBe('2026-11-19T12:00:00.000Z');
    expect(toInstant('2026-06-01', '06:30').toISOString()).toBe('2026-05-31T23:30:00.000Z'); // previous UTC day
  });

  it('knows ISO weekdays', () => {
    expect(isoWeekday('2026-11-16')).toBe(1); // Monday
    expect(isoWeekday('2026-11-22')).toBe(7); // Sunday
  });

  it('adds days and months across boundaries', () => {
    expect(addDays('2026-12-30', 3)).toBe('2027-01-02');
    expect(addMonths('2026-01-31', 1)).toBe('2026-02-28');
    expect(addMonths('2028-01-31', 1)).toBe('2028-02-29'); // leap year
    expect(addMonths('2026-11-19', 3)).toBe('2027-02-19');
  });

  it('plans every Monday and Thursday across a month and year boundary', () => {
    const mondays = plan(1, '19:00', '20:30', '2026-12-20', '2027-01-12').map((s) => s.date);
    expect(mondays).toEqual(['2026-12-21', '2026-12-28', '2027-01-04', '2027-01-11']);
    const thursdays = plan(4, '19:00', '20:30', '2026-11-26', '2026-12-03');
    expect(thursdays.map((s) => s.date)).toEqual(['2026-11-26', '2026-12-03']);
    expect(thursdays[0].startsAt.toISOString()).toBe('2026-11-26T12:00:00.000Z');
    expect(thursdays[0].endsAt.toISOString()).toBe('2026-11-26T13:30:00.000Z');
  });

  it('plans nothing when the window has no matching weekday', () => {
    expect(plan(7, '08:00', '09:00', '2026-11-16', '2026-11-21')).toEqual([]);
  });
});
