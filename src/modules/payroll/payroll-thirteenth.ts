/**
 * 13th salary: avos, two installments, taxes on the whole amount deducted from the second one.
 * Pure: no database, no clock. Cents everywhere.
 */
import {
  computeFgts,
  computeInss,
  computeIrrf,
  DEFAULT_PAYROLL_METHOD,
  resolveTables,
  type PayrollMethod,
  type PayrollTableSet,
  type PayrollWarning,
  type UsedTables,
} from './payroll-calc.js';
import { daysInMonth, formatDay, parseDay } from './payroll-dates.js';

/**
 * Avos of the 13th for `year`: months with 15 days or more worked. A month before the admission month does not count;
 * the admission month counts when the days from the admission day to its end are 15 or more. A termination date, when
 * given, closes the count the same way (days up to and including it).
 */
export function countThirteenthAvos(admission: string, year: number, termination?: string | null): number {
  const a = parseDay(admission);
  const t = termination ? parseDay(termination) : null;
  let avos = 0;
  for (let month = 1; month <= 12; month++) {
    const total = daysInMonth(year, month);
    let first = 1;
    let last = total;
    if (a.year > year || (a.year === year && a.month > month)) continue;
    if (a.year === year && a.month === month) first = a.day;
    if (t) {
      if (t.year < year || (t.year === year && t.month < month)) continue;
      if (t.year === year && t.month === month) last = t.day;
    }
    if (last - first + 1 >= 15) avos++;
  }
  return avos;
}

export interface InstallmentSchedule {
  month: number; // 1..12
  day: number; // clamped to the month length
}

export interface ThirteenthInput {
  year: number;
  /** Salary in force in December. */
  grossCents: number;
  avos: number;
  dependents?: number;
  /** Defaults to June 30 (the user's habit; the legal deadline is November 30). */
  first?: InstallmentSchedule;
  /** Defaults to December 20. */
  second?: InstallmentSchedule;
  method?: PayrollMethod;
  tables?: PayrollTableSet;
}

export interface ThirteenthFirst {
  date: string;
  /** Half of the proportional amount, no deductions. */
  amountCents: number;
}

export interface ThirteenthSecond {
  date: string;
  grossCents: number;
  inssCents: number;
  irrfCents: number;
  /** Total net of the 13th minus the first installment already paid. */
  netCents: number;
}

export interface Thirteenth {
  tables: UsedTables;
  warnings: PayrollWarning[];
  avos: number;
  /** Proportional 13th, before the split and the taxes. */
  totalCents: number;
  /** INSS and IRRF of the whole 13th (separate from the month's salary). */
  inssCents: number;
  irrfCents: number;
  fgtsCents: number;
  first: ThirteenthFirst;
  second: ThirteenthSecond;
  /** First + second: what reaches the account in the year. */
  netCents: number;
}

export function computeThirteenth(input: ThirteenthInput): Thirteenth {
  if (!Number.isInteger(input.grossCents) || input.grossCents < 0) throw new Error('grossCents must be non-negative whole cents.');
  if (!Number.isInteger(input.avos) || input.avos < 0 || input.avos > 12) throw new Error('avos must be 0..12.');
  const method = input.method ?? DEFAULT_PAYROLL_METHOD;
  const first = input.first ?? { month: 6, day: 30 };
  const second = input.second ?? { month: 12, day: 20 };
  const firstDate = formatDay(input.year, first.month, first.day);
  const secondDate = formatDay(input.year, second.month, second.day);
  // The taxes are charged on the second installment, so its date picks the tables.
  const tables = resolveTables(secondDate, input.tables);

  const exact = input.grossCents * input.avos;
  const totalCents = method.rounding === 'truncate' ? Math.floor(exact / 12) : Math.round(exact / 12);
  const firstCents = Math.floor(totalCents / 2);

  const inssCents = computeInss(Math.min(totalCents, tables.inss.ceilingCents), tables.inss, method);
  const irrf = computeIrrf(totalCents, inssCents, input.dependents ?? 0, tables.irrf, method);
  const fgtsCents = computeFgts(totalCents, tables.fgts, method);

  const secondNet = totalCents - inssCents - irrf.taxCents - firstCents;
  return {
    tables: tables.used,
    warnings: tables.warnings,
    avos: input.avos,
    totalCents,
    inssCents,
    irrfCents: irrf.taxCents,
    fgtsCents,
    first: { date: firstDate, amountCents: firstCents },
    second: {
      date: secondDate,
      grossCents: totalCents - firstCents,
      inssCents,
      irrfCents: irrf.taxCents,
      netCents: secondNet,
    },
    netCents: firstCents + secondNet,
  };
}
