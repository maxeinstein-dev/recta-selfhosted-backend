/** Calendar helpers on 'YYYY-MM-DD' strings (UTC, no clock, no timezone surprises). */
import { addDays } from '../dashboard/cash-flow.js';

export { addDays };

export function daysInMonth(year: number, month: number): number {
  return new Date(Date.UTC(year, month, 0)).getUTCDate();
}

export function parseDay(day: string): { year: number; month: number; day: number } {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(day);
  if (!m) throw new Error(`Invalid date: ${day}`);
  return { year: Number(m[1]), month: Number(m[2]), day: Number(m[3]) };
}

export function formatDay(year: number, month: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

/** Whole days between two days, `to` minus `from`. */
export function diffDays(from: string, to: string): number {
  const a = parseDay(from);
  const b = parseDay(to);
  return Math.round((Date.UTC(b.year, b.month - 1, b.day) - Date.UTC(a.year, a.month - 1, a.day)) / 86_400_000);
}

/** Day of the week of a day: 0 = Sunday ... 6 = Saturday. */
export function weekdayOf(day: string): number {
  const d = parseDay(day);
  return new Date(Date.UTC(d.year, d.month - 1, d.day)).getUTCDay();
}

/** True for a weekday that is not an off day (`isOff`: holidays of the employment calendar; default none). */
export function isBusinessDay(day: string, isOff?: (day: string) => boolean): boolean {
  const w = weekdayOf(day);
  return w !== 0 && w !== 6 && !(isOff?.(day) ?? false);
}

/**
 * The day itself when it is a business day, else the closest business day before it. Without `isOff` only weekends
 * are skipped (Saturday -1, Sunday -2); with it, holidays are skipped too.
 */
export function previousBusinessDay(day: string, isOff?: (day: string) => boolean): string {
  let d = day;
  while (!isBusinessDay(d, isOff)) d = addDays(d, -1);
  return d;
}

export function lastDayOfMonth(month: string): string {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  return formatDay(Number(m[1]), Number(m[2]), 31);
}

/** 'YYYY-MM' + n months. */
export function addMonths(month: string, n: number): string {
  const index = Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1) + n;
  return `${String(Math.floor(index / 12)).padStart(4, '0')}-${String((index % 12) + 1).padStart(2, '0')}`;
}

/**
 * The n-th business day (Monday to Friday, minus the days `isOff` flags) of the month 'YYYY-MM', as 'YYYY-MM-DD'.
 * @throws when n is not 1..20 (every month has at least 20 weekdays; with holidays 15 would always exist, and the
 * guard stays at 20 for the calendar-free case).
 */
export function nthBusinessDay(month: string, n: number, isOff?: (day: string) => boolean): string {
  if (!Number.isInteger(n) || n < 1 || n > 20) throw new Error('n must be 1..20.');
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  let count = 0;
  for (let d = 1; d <= 31; d++) {
    const day = formatDay(Number(m[1]), Number(m[2]), d);
    if (Number(day.slice(8, 10)) !== d) break; // past the end of the month
    if (isBusinessDay(day, isOff) && ++count === n) return day;
  }
  throw new Error('That business day does not exist in the month.');
}
