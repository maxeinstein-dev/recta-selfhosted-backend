/**
 * Brazilian business-day calendar, computed in code (no external dependency).
 *
 * Business day = Monday to Friday that is not a holiday. Holidays:
 *  - national fixed: 01/01, 21/04, 01/05, 07/09, 12/10, 02/11, 15/11, 20/11 (Consciencia Negra, national since 2024), 25/12;
 *  - national movable: Good Friday (Easter - 2 days), always on;
 *  - optional, chosen per recurrence: Carnaval (Monday and Tuesday, Easter - 48 / - 47) and Corpus Christi (Easter + 60);
 *  - "dias sem vale" of the recurrence: local dates that do not count either, 'MM-DD' (every year) or 'YYYY-MM-DD' (that year).
 * Everything is calendar arithmetic on UTC dates, so the time zone of the server never shifts a day.
 */

export const OPTIONAL_HOLIDAYS = ['CARNIVAL', 'CORPUS_CHRISTI'] as const;
export type OptionalHoliday = (typeof OPTIONAL_HOLIDAYS)[number];

export interface CalendarOptions {
  /** Optional holidays that also count as non-business days. */
  optionalHolidays?: readonly string[] | null;
  /** "Dias sem vale": 'MM-DD' or 'YYYY-MM-DD'. */
  nonWorkingDays?: readonly string[] | null;
}

/** First year Consciencia Negra (20/11) is a national holiday (Lei 14.759/2023). */
const BLACK_AWARENESS_FROM = 2024;

/** 'YYYY-MM-DD' of the UTC date. */
function key(date: Date): string {
  return `${String(date.getUTCFullYear()).padStart(4, '0')}-${String(date.getUTCMonth() + 1).padStart(2, '0')}-${String(date.getUTCDate()).padStart(2, '0')}`;
}

function utc(year: number, month: number, day: number): Date {
  return new Date(Date.UTC(year, month - 1, day));
}

function shift(date: Date, days: number): Date {
  return new Date(date.getTime() + days * 86_400_000);
}

/** Easter Sunday of `year` (Gregorian calendar; Meeus/Jones/Butcher form of the Gauss algorithm), as 'YYYY-MM-DD'. */
export function easterSunday(year: number): string {
  const a = year % 19;
  const b = Math.floor(year / 100);
  const c = year % 100;
  const d = Math.floor(b / 4);
  const e = b % 4;
  const f = Math.floor((b + 8) / 25);
  const g = Math.floor((b - f + 1) / 3);
  const h = (19 * a + b - d - g + 15) % 30;
  const i = Math.floor(c / 4);
  const k = c % 4;
  const l = (32 + 2 * e + 2 * i - h - k) % 7;
  const m = Math.floor((a + 11 * h + 22 * l) / 451);
  const month = Math.floor((h + l - 7 * m + 114) / 31);
  const day = ((h + l - 7 * m + 114) % 31) + 1;
  return key(utc(year, month, day));
}

const FIXED_HOLIDAYS: ReadonlyArray<readonly [number, number]> = [
  [1, 1], [4, 21], [5, 1], [9, 7], [10, 12], [11, 2], [11, 15], [11, 20], [12, 25],
];

/** National holidays of `year` as 'YYYY-MM-DD' (fixed ones plus Good Friday), sorted. */
export function nationalHolidays(year: number): string[] {
  const days = FIXED_HOLIDAYS
    .filter(([month, day]) => !(month === 11 && day === 20 && year < BLACK_AWARENESS_FROM))
    .map(([month, day]) => key(utc(year, month, day)));
  const [ey, em, ed] = easterSunday(year).split('-').map(Number) as [number, number, number];
  days.push(key(shift(utc(ey, em, ed), -2)));
  return days.sort();
}

/** The optional holidays of `year` that are switched on, as 'YYYY-MM-DD'. */
export function optionalHolidayDays(year: number, enabled: readonly string[] | null | undefined): string[] {
  if (!enabled || enabled.length === 0) return [];
  const [ey, em, ed] = easterSunday(year).split('-').map(Number) as [number, number, number];
  const easter = utc(ey, em, ed);
  const days: string[] = [];
  if (enabled.includes('CARNIVAL')) days.push(key(shift(easter, -48)), key(shift(easter, -47)));
  if (enabled.includes('CORPUS_CHRISTI')) days.push(key(shift(easter, 60)));
  return days.sort();
}

const FULL_DAY = /^(\d{4})-(\d{2})-(\d{2})$/;
const YEARLESS_DAY = /^(\d{2})-(\d{2})$/;

/** True for 'MM-DD' (a day that exists in some year: 02-29 is accepted) or a real 'YYYY-MM-DD'. */
export function isValidNonWorkingDay(value: string): boolean {
  const full = FULL_DAY.exec(value);
  if (full) {
    const d = utc(Number(full[1]), Number(full[2]), Number(full[3]));
    return key(d) === value;
  }
  const part = YEARLESS_DAY.exec(value);
  if (part) {
    const month = Number(part[1]);
    const day = Number(part[2]);
    // 2000 is a leap year, so 02-29 is accepted
    return key(utc(2000, month, day)) === `2000-${part[1]}-${part[2]}` && month >= 1 && month <= 12;
  }
  return false;
}

/** Sorted, de-duplicated list of "dias sem vale" (invalid entries dropped). */
export function normalizeNonWorkingDays(values: readonly string[] | null | undefined): string[] {
  return [...new Set((values ?? []).map((v) => v.trim()).filter(isValidNonWorkingDay))].sort();
}

/** Every non-business weekday of a month: holidays plus the recurrence's own days, as a Set of 'YYYY-MM-DD'. */
export function offDaysOfMonth(month: string, options: CalendarOptions = {}): Set<string> {
  const year = Number(month.slice(0, 4));
  const off = new Set<string>([...nationalHolidays(year), ...optionalHolidayDays(year, options.optionalHolidays)]);
  for (const entry of options.nonWorkingDays ?? []) {
    const full = FULL_DAY.exec(entry);
    if (full) {
      if (full[1] === month.slice(0, 4)) off.add(entry);
    } else if (YEARLESS_DAY.test(entry)) {
      off.add(`${month.slice(0, 4)}-${entry}`);
    }
  }
  return off;
}

/** True when `day` ('YYYY-MM-DD') is Monday to Friday and not a holiday / "dia sem vale". */
export function isBusinessDay(day: string, options: CalendarOptions = {}): boolean {
  const m = FULL_DAY.exec(day);
  if (!m) return false;
  const weekday = utc(Number(m[1]), Number(m[2]), Number(m[3])).getUTCDay();
  if (weekday === 0 || weekday === 6) return false;
  return !offDaysOfMonth(day.slice(0, 7), options).has(day);
}

/** Number of business days in a month ('YYYY-MM'). 0 for a malformed month. */
export function businessDaysInMonth(month: string, options: CalendarOptions = {}): number {
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) return 0;
  const year = Number(month.slice(0, 4));
  const monthIndex = Number(month.slice(5, 7));
  const off = offDaysOfMonth(month, options);
  const last = utc(year, monthIndex + 1, 0).getUTCDate();
  let count = 0;
  for (let day = 1; day <= last; day += 1) {
    const date = utc(year, monthIndex, day);
    const weekday = date.getUTCDay();
    if (weekday !== 0 && weekday !== 6 && !off.has(key(date))) count += 1;
  }
  return count;
}
