/** VND and Asia/Ho_Chi_Minh formatting (BR-SYS-02). */
const TZ = 'Asia/Ho_Chi_Minh';
const money = new Intl.NumberFormat('vi-VN', { style: 'currency', currency: 'VND' });
const dateFmt = new Intl.DateTimeFormat('vi-VN', {
  timeZone: TZ,
  day: '2-digit',
  month: '2-digit',
  year: 'numeric',
});
const timeFmt = new Intl.DateTimeFormat('vi-VN', {
  timeZone: TZ,
  hour: '2-digit',
  minute: '2-digit',
  hourCycle: 'h23',
});
const weekdayFmt = new Intl.DateTimeFormat('vi-VN', { timeZone: TZ, weekday: 'long' });

/** 1500000 → "1.500.000 ₫" */
export const formatMoney = (vnd: number) => money.format(vnd).replace(/ /g, ' ');

/** A calendar date `YYYY-MM-DD` → "19/11/2026" (no time-zone shift: it is already local). */
export function formatDate(date: string | null | undefined): string {
  if (!date) return '—';
  const [y, m, d] = date.slice(0, 10).split('-');
  return `${d}/${m}/${y}`;
}

/** A UTC instant → "19/11/2026 19:00" in Vietnam time. */
export function formatDateTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  const d = new Date(iso);
  return `${dateFmt.format(d)} ${timeFmt.format(d)}`;
}

/** A UTC instant → "19:00" in Vietnam time. */
export const formatTime = (iso: string) => timeFmt.format(new Date(iso));

/** `YYYY-MM-DD` → "Thứ Năm" */
export const weekdayOf = (date: string) => weekdayFmt.format(new Date(`${date}T12:00:00+07:00`));

/** `YYYY-MM` → "11/2026" */
export const formatPeriod = (period: string) => `${period.slice(5, 7)}/${period.slice(0, 4)}`;

/** Today in Vietnam, `YYYY-MM-DD`. */
export const todayVn = (now = new Date()) =>
  new Intl.DateTimeFormat('en-CA', { timeZone: TZ }).format(now);

export function addDays(date: string, days: number): string {
  const [y, m, d] = date.split('-').map(Number);
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** Whole years between a birth date and today (both Vietnam calendar dates). */
export function ageOn(dob: string, today = todayVn()): number {
  const [by, bm, bd] = dob.split('-').map(Number);
  const [ty, tm, td] = today.split('-').map(Number);
  return ty - by - (tm < bm || (tm === bm && td < bd) ? 1 : 0);
}

/** `YYYY-MM` of the month after `period`. */
export function nextPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
}
