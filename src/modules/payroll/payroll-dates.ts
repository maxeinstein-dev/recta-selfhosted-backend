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
