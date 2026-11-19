/**
 * Calendar arithmetic for Vietnam (Asia/Ho_Chi_Minh, UTC+7 all year: no daylight
 * saving), BR-SYS-02. Dates are YYYY-MM-DD and times HH:MM in local time; instants
 * are real Dates (UTC).
 */
const VN_OFFSET = '+07:00';

/** The UTC instant of a local Vietnam date + time. */
export function toInstant(date: string, time: string): Date {
  return new Date(`${date}T${time}:00${VN_OFFSET}`);
}

/** ISO weekday of a calendar date: 1 = Monday … 7 = Sunday. */
export function isoWeekday(date: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const day = new Date(Date.UTC(y, m - 1, d)).getUTCDay();
  return day === 0 ? 7 : day;
}

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Same day `months` later, clamped to the month's last day (31 Jan + 1 → 28/29 Feb). */
export function addMonths(date: string, months: number): string {
  const [y, m, d] = date.split('-').map(Number);
  const lastDay = new Date(Date.UTC(y, m - 1 + months + 1, 0)).getUTCDate();
  return new Date(Date.UTC(y, m - 1 + months, Math.min(d, lastDay))).toISOString().slice(0, 10);
}

export const dateOnly = (d: Date) => d.toISOString().slice(0, 10);

export interface PlannedSession {
  date: string;
  startTime: string;
  endTime: string;
  startsAt: Date;
  endsAt: Date;
}

/** Every date on `weekday` from `from` to `until` (inclusive), as Sessions. */
export function plan(
  weekday: number,
  startTime: string,
  endTime: string,
  from: string,
  until: string,
): PlannedSession[] {
  const out: PlannedSession[] = [];
  let date = addDays(from, (weekday - isoWeekday(from) + 7) % 7);
  while (date <= until) {
    out.push({
      date,
      startTime,
      endTime,
      startsAt: toInstant(date, startTime),
      endsAt: toInstant(date, endTime),
    });
    date = addDays(date, 7);
  }
  return out;
}
