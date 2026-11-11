/**
 * Vacation pay: days of salary plus one third, optional abono (sold days), taxes on the total in a separate calculation,
 * payment two days before the start. Pure: no database, no clock. Cents everywhere.
 */
import {
  computeFgts,
  computeInss,
  computeIrrf,
  DEFAULT_PAYROLL_METHOD,
  resolveTables,
  type PayrollItem,
  type PayrollMethod,
  type PayrollTableSet,
  type PayrollWarning,
  type RoundingMode,
  type UsedTables,
} from './payroll-calc.js';
import { addDays, daysInMonth, diffDays, formatDay, parseDay } from './payroll-dates.js';

export interface VacationInput {
  /** First day of the vacation. Absent when only the month is known (see `month`). */
  start?: string;
  /** 'YYYY-MM': used only when `start` is absent; the period is then assumed to start on day 1 and to be an estimate. */
  month?: string;
  /** Days taken. Default: 30 minus the sold days. */
  days?: number;
  /** Abono pecuniario: days sold, 0..10. Not taxed, not in the FGTS base. */
  sellDays?: number;
  grossCents: number;
  dependents?: number;
  /** One-off lines paid with the vacation (for instance an advance of a raise); earnings follow their base flags. */
  items?: readonly PayrollItem[];
  method?: PayrollMethod;
  tables?: PayrollTableSet;
}

export interface VacationPeriod {
  start: string;
  end: string;
  days: number;
  /** True when the dates were assumed from the month alone. */
  estimated: boolean;
}

export interface Vacation {
  tables: UsedTables;
  warnings: PayrollWarning[];
  period: VacationPeriod;
  /** Two days before the start. */
  paymentDate: string;
  vacationCents: number;
  thirdCents: number;
  abonoCents: number;
  abonoThirdCents: number;
  extraEarningsCents: number;
  fixedDeductionsCents: number;
  bases: { inssCents: number; irrfIncomeCents: number; irrfCents: number; fgtsCents: number };
  inssCents: number;
  irrfCents: number;
  fgtsCents: number;
  netCents: number;
  estimated: boolean;
}

function div(exact: number, by: number, rounding: RoundingMode): number {
  return rounding === 'truncate' ? Math.floor(exact / by) : Math.round(exact / by);
}

export function resolveVacationPeriod(input: Pick<VacationInput, 'start' | 'month' | 'days' | 'sellDays'>): VacationPeriod {
  const sell = input.sellDays ?? 0;
  if (!Number.isInteger(sell) || sell < 0 || sell > 10) throw new Error('sellDays must be 0..10.');
  let start: string;
  let estimated = false;
  if (input.start) {
    start = input.start;
    parseDay(start);
  } else if (input.month) {
    const m = /^(\d{4})-(\d{2})$/.exec(input.month);
    if (!m) throw new Error(`Invalid month: ${input.month}`);
    start = formatDay(Number(m[1]), Number(m[2]), 1);
    estimated = true;
  } else {
    throw new Error('Vacation needs a start date or a month.');
  }
  const days = input.days ?? (estimated ? 30 : 30 - sell);
  if (!Number.isInteger(days) || days < 1 || days > 30) throw new Error('days must be 1..30.');
  if (days + sell > 30) throw new Error('days plus sold days cannot exceed 30.');
  return { start, end: addDays(start, days - 1), days, estimated };
}

export function computeVacation(input: VacationInput): Vacation {
  if (!Number.isInteger(input.grossCents) || input.grossCents < 0) throw new Error('grossCents must be non-negative whole cents.');
  const method = input.method ?? DEFAULT_PAYROLL_METHOD;
  const sell = input.sellDays ?? 0;
  const period = resolveVacationPeriod(input);
  const paymentDate = addDays(period.start, -2);
  const tables = resolveTables(paymentDate, input.tables);
  const items = input.items ?? [];
  for (const i of items) {
    if (!Number.isInteger(i.amountCents) || i.amountCents < 0) throw new Error(`item ${i.label}: amount must be non-negative whole cents.`);
  }

  const vacationCents = div(input.grossCents * period.days, 30, method.rounding);
  const thirdCents = div(vacationCents, 3, method.rounding);
  const abonoCents = div(input.grossCents * sell, 30, method.rounding);
  const abonoThirdCents = div(abonoCents, 3, method.rounding);

  const earnings = items.filter((i) => i.kind === 'earning');
  const sumFlag = (pick: (i: PayrollItem) => boolean) => earnings.filter(pick).reduce((s, i) => s + i.amountCents, 0);
  const extraEarningsCents = earnings.reduce((s, i) => s + i.amountCents, 0);
  const fixedDeductionsCents = items.filter((i) => i.kind === 'deduction').reduce((s, i) => s + i.amountCents, 0);

  const salaryPart = vacationCents + thirdCents;
  const inssBase = Math.min(salaryPart + sumFlag((i) => i.inInssBase), tables.inss.ceilingCents);
  const inssCents = computeInss(inssBase, tables.inss, method);
  const irrfIncome = salaryPart + sumFlag((i) => i.inIrrfBase);
  const irrf = computeIrrf(irrfIncome, inssCents, input.dependents ?? 0, tables.irrf, method);
  const fgtsBase = salaryPart + sumFlag((i) => i.inFgtsBase);
  const fgtsCents = computeFgts(fgtsBase, tables.fgts, method);

  return {
    tables: tables.used,
    warnings: tables.warnings,
    period,
    paymentDate,
    vacationCents,
    thirdCents,
    abonoCents,
    abonoThirdCents,
    extraEarningsCents,
    fixedDeductionsCents,
    bases: { inssCents: inssBase, irrfIncomeCents: irrfIncome, irrfCents: irrf.baseCents, fgtsCents: fgtsBase },
    inssCents,
    irrfCents: irrf.taxCents,
    fgtsCents,
    netCents:
      salaryPart + abonoCents + abonoThirdCents + extraEarningsCents - inssCents - irrf.taxCents - fixedDeductionsCents,
    estimated: period.estimated,
  };
}

/** Calendar days of the vacation that fall inside the month 'YYYY-MM'. */
export function vacationDaysInMonth(period: Pick<VacationPeriod, 'start' | 'end'>, month: string): number {
  const m = /^(\d{4})-(\d{2})$/.exec(month);
  if (!m) throw new Error(`Invalid month: ${month}`);
  const first = formatDay(Number(m[1]), Number(m[2]), 1);
  const last = formatDay(Number(m[1]), Number(m[2]), daysInMonth(Number(m[1]), Number(m[2])));
  const from = period.start > first ? period.start : first;
  const to = period.end < last ? period.end : last;
  return to < from ? 0 : diffDays(from, to) + 1;
}

/**
 * Days of salary owed for the competence month `month` ('YYYY-MM') given the vacation, on the 30-day commercial month:
 * 30 minus the vacation days inside the month, never below 0. The salary paid on day 5 of the next month is the one
 * for this competence month, which is why the month after the vacation pays less.
 */
export function workedDaysWithVacation(period: Pick<VacationPeriod, 'start' | 'end'>, month: string): number {
  return Math.max(0, 30 - vacationDaysInMonth(period, month));
}
