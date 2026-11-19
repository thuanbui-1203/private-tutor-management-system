/** Calendar helpers in Vietnam time (BR-SYS-02): dates are YYYY-MM-DD, billing periods YYYY-MM. */

export function todayInVietnam(now: Date = new Date()): string {
  return new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Ho_Chi_Minh' }).format(now);
}

export function periodOf(date: string): string {
  return date.slice(0, 7);
}

export function currentPeriod(now: Date = new Date()): string {
  return periodOf(todayInVietnam(now));
}

export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
