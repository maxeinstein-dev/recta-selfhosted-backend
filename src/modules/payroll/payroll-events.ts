/**
 * Forecast events of one employment: the salary of each month with its composition, the 13th installments, the
 * marked vacations and the FGTS (deposits and estimated accumulated balance). Pure: no database, no clock (`today` is
 * an argument). Everything is whole cents. Nothing here creates an entry or touches a balance.
 *
 * Rules:
 * - The salary of a competence month is paid on the pay day of the NEXT month (the worst case the user chose is day 5).
 *   The gross is the one in force on the last day of the competence month; the month of a vacation (and of the
 *   admission) is prorated on the 30-day commercial month.
 * - 13th installments and vacations dated before `today` are not forecast (already happened). Without `today` nothing
 *   is filtered. The salary list is never filtered by `today`.
 * - The vacation is paid two days before it starts, moving back to the previous business day when that lands on a
 *   weekend or on a day off of the employment's holiday calendar (without a calendar: weekends only).
 * - FGTS has no interest or monetary correction here. A deposit counts on the last day of its competence month.
 * - With the birthday mode in force, the withdrawal of the birthday month is forecast on the 5th business day of that
 *   month (Monday to Friday minus the days off of the holiday calendar, none without one; the real window runs to the end of the second following month), valued by the official table over the estimated balance, or
 *   by the amount the user informed on the mode record. Always 'estimated'.
 * - Benefits paid per business day (`benefits`) are outside the salary, the 13th, the vacation and the FGTS: each has
 *   its own payment (see payroll-daily-benefit.ts).
 * - Only CLT employments have payroll; the caller must not build data for other regimes.
 */
import {
  computeMonthlyPayroll,
  DEFAULT_PAYROLL_METHOD,
  type MonthlyPayroll,
  type PayrollItem,
  type PayrollMethod,
  type PayrollTableSet,
} from './payroll-calc.js';
import { addDays, addMonths, formatDay, lastDayOfMonth, nthBusinessDay, parseDay, previousBusinessDay } from './payroll-dates.js';
import { benefitPaymentDate, computeDailyBenefit, type DailyBenefitData, type DailyBenefitEvent } from './payroll-daily-benefit.js';
import { offDayChecker, type HolidayConfig } from './payroll-holidays.js';
import { birthdayWithdrawalCents, selectBirthdayTable } from './payroll-fgts-birthday.js';
import { computeThirteenth, countThirteenthAvos, type InstallmentSchedule, type Thirteenth } from './payroll-thirteenth.js';
import { computeVacation, resolveVacationPeriod, vacationDaysInMonth, type Vacation } from './payroll-vacation.js';

export interface DatedAmount {
  /** 'YYYY-MM-DD': the value is in force from this day until the next entry. */
  startDate: string;
  amountCents: number;
}

export interface FixedItemData {
  id: string;
  name: string;
  kind: 'earning' | 'deduction';
  inInssBase: boolean;
  inIrrfBase: boolean;
  inFgtsBase: boolean;
  values: readonly DatedAmount[];
}

export interface VacationMark {
  id: string;
  /** Exact start date; null/absent when only the month is known. */
  start?: string | null;
  /** 'YYYY-MM', used when there is no start date: 30 days from day 1, estimated. */
  month?: string | null;
  days?: number | null;
  sellDays: number;
  /** One-off lines paid with the vacation. */
  items: readonly PayrollItem[];
}

export type FgtsModeData = {
  startDate: string;
  mode: 'termination' | 'birthday';
  birthdayMonth?: number | null;
  /** User-informed forecast of the birthday withdrawal; overrides the table. */
  expectedAmountCents?: number | null;
};

export interface EmploymentData {
  employmentId: string;
  /** Owner of the employment (a person of the household); absent/null = no owner. */
  personId?: string | null;
  /** Account that receives the salary money; used as the destination of benefits without an account of their own. */
  accountId?: string | null;
  /** Holiday calendar of the employment; absent/null = no holidays (weekends only). */
  calendar?: HolidayConfig | null;
  /** Benefits paid per business day. */
  benefits?: readonly DailyBenefitData[];
  admissionDate: string;
  /** Last day of the employment; null/absent = still employed. */
  endDate?: string | null;
  dependents: number;
  /** Pay day of the month after the competence month. */
  payDay: number;
  method: PayrollMethod;
  thirteenth: { first: InstallmentSchedule; second: InstallmentSchedule };
  salaries: readonly DatedAmount[];
  items: readonly FixedItemData[];
  vacations: readonly VacationMark[];
  fgts: {
    balance: { asOfDate: string; amountCents: number } | null;
    withdrawals: ReadonlyArray<{ date: string; amountCents: number; kind?: 'birthday' | 'termination' | 'other' }>;
    modes?: readonly FgtsModeData[];
  };
}

export interface EventOptions {
  /** Both inclusive, 'YYYY-MM-DD'. */
  from: string;
  to: string;
  today?: string;
  tables?: PayrollTableSet;
  /**
   * Also return the 13th installments and vacations dated before `today` (marked `past: true`, the others `past: false`)
   * and the birthday withdrawals already recorded in the period (real amount, `source: 'recorded'`). Default false: the
   * result is exactly the forecast. Without `today` there is no past, so nothing changes.
   */
  includePast?: boolean;
}

/** The entry in force on `day`: the one with the latest start date not after it. */
export function valueInForce<T extends { startDate: string }>(list: readonly T[], day: string): T | undefined {
  let best: T | undefined;
  for (const entry of list) {
    if (entry.startDate <= day && (!best || entry.startDate > best.startDate)) best = entry;
  }
  return best;
}

export function paymentDateOfCompetence(competence: string, payDay: number): string {
  const next = addMonths(competence, 1);
  return formatDay(Number(next.slice(0, 4)), Number(next.slice(5, 7)), payDay);
}

/** Fixed items with a value in force on `day`, as payslip lines. */
export function fixedItemsAt(items: readonly FixedItemData[], day: string): PayrollItem[] {
  const out: PayrollItem[] = [];
  for (const item of items) {
    const v = valueInForce(item.values, day);
    if (!v) continue;
    out.push({
      label: item.name,
      amountCents: v.amountCents,
      kind: item.kind,
      inInssBase: item.inInssBase,
      inIrrfBase: item.inIrrfBase,
      inFgtsBase: item.inFgtsBase,
    });
  }
  return out;
}

function vacationPeriodOf(v: VacationMark) {
  return resolveVacationPeriod({
    start: v.start ?? undefined,
    month: v.start ? undefined : (v.month ?? undefined),
    days: v.days ?? undefined,
    sellDays: v.sellDays,
  });
}

/** The vacation pay lands two days before the start, moved back to a weekday. */
export function vacationCashDate(start: string, calendar?: HolidayConfig | null): string {
  return previousBusinessDay(addDays(start, -2), calendar ? offDayChecker(calendar) : undefined);
}

export interface SalaryEvent {
  competence: string;
  paymentDate: string;
  grossCents: number;
  /** Days worked of the 30-day commercial month. */
  workedDays: number;
  vacationDays: number;
  netCents: number;
  /** True when a table used is a projection with an old table. */
  estimated: boolean;
  payroll: MonthlyPayroll;
}

/** Salary of one competence month; null when the employment has no salary in force then (or had not started). */
export function computeCompetence(data: EmploymentData, competence: string, tables?: PayrollTableSet): SalaryEvent | null {
  const adm = parseDay(data.admissionDate);
  const admMonth = `${String(adm.year).padStart(4, '0')}-${String(adm.month).padStart(2, '0')}`;
  if (competence < admMonth) return null;
  const last = lastDayOfMonth(competence);
  const gross = valueInForce(data.salaries, last);
  if (!gross) return null;

  if (data.endDate && competence > data.endDate.slice(0, 7)) return null;
  const firstDay = competence === admMonth ? adm.day : 1;
  const lastWorked = data.endDate && competence === data.endDate.slice(0, 7) ? Math.min(30, parseDay(data.endDate).day) : 30;
  const base = Math.max(0, Math.min(30, lastWorked - firstDay + 1));
  let vacationDays = 0;
  for (const v of data.vacations) vacationDays += vacationDaysInMonth(vacationPeriodOf(v), competence);
  const workedDays = Math.max(0, base - vacationDays);

  const paymentDate = paymentDateOfCompetence(competence, data.payDay);
  const payroll = computeMonthlyPayroll({
    date: paymentDate,
    grossCents: gross.amountCents,
    dependents: data.dependents,
    items: fixedItemsAt(data.items, last),
    workedDays,
    method: data.method,
    tables,
  });
  return {
    competence,
    paymentDate,
    grossCents: gross.amountCents,
    workedDays,
    vacationDays,
    netCents: payroll.netCents,
    estimated: payroll.warnings.length > 0,
    payroll,
  };
}

export interface ThirteenthEvent {
  year: number;
  installment: 1 | 2;
  date: string;
  /** What reaches the account on that date. */
  netCents: number;
  estimated: boolean;
  thirteenth: Thirteenth;
  /** Only with `includePast`: true when the date is before `today`. */
  past?: boolean;
}

export interface VacationEvent {
  id: string;
  paymentDate: string;
  period: Vacation['period'];
  netCents: number;
  /** Dates assumed from the month alone, or a table projected from an old one. */
  estimated: boolean;
  vacation: Vacation;
  /** Only with `includePast`: true when the payment date is before `today`. */
  past?: boolean;
}

function thirteenthOfYear(data: EmploymentData, year: number, tables?: PayrollTableSet): Thirteenth | null {
  const avos = countThirteenthAvos(data.admissionDate, year, data.endDate);
  if (avos === 0) return null;
  const gross = valueInForce(data.salaries, `${String(year).padStart(4, '0')}-12-31`);
  if (!gross) return null;
  return computeThirteenth({
    year,
    grossCents: gross.amountCents,
    avos,
    dependents: data.dependents,
    first: data.thirteenth.first,
    second: data.thirteenth.second,
    method: data.method,
    tables,
  });
}

function vacationOf(data: EmploymentData, v: VacationMark, tables?: PayrollTableSet): VacationEvent | null {
  const period = vacationPeriodOf(v);
  const gross = valueInForce(data.salaries, period.start);
  if (!gross) return null;
  const vacation = computeVacation({
    start: v.start ?? undefined,
    month: v.start ? undefined : (v.month ?? undefined),
    days: v.days ?? undefined,
    sellDays: v.sellDays,
    grossCents: gross.amountCents,
    dependents: data.dependents,
    items: v.items,
    method: data.method,
    tables,
  });
  return {
    id: v.id,
    paymentDate: vacationCashDate(period.start, data.calendar),
    period: vacation.period,
    netCents: vacation.netCents,
    estimated: vacation.estimated || vacation.warnings.length > 0,
    vacation,
  };
}

export interface FgtsMonth {
  month: string;
  salaryDepositCents: number;
  thirteenthDepositCents: number;
  vacationDepositCents: number;
  /** Recorded withdrawals of the month. */
  withdrawalsCents: number;
  /** Forecast birthday withdrawal of the month. */
  forecastWithdrawalCents: number;
  /** Estimated balance at the end of the month. */
  accumulatedCents: number;
}

export interface BirthdayForecast {
  year: number;
  /** 5th business day of the birthday month. */
  date: string;
  amountCents: number;
  /** 'table': official table over the estimated balance; 'informed': the amount on the mode record; 'recorded': a real withdrawal already registered (only with `includePast`). */
  source: 'table' | 'informed' | 'recorded';
  /** Estimated balance the table was applied to (0 when informed). */
  balanceCents: number;
  tableId: string | null;
  /** Only with `includePast`: true for a recorded withdrawal dated before `today`. */
  past?: boolean;
}

export interface FgtsForecast {
  /** The informed balance the estimate starts from, when there is one. */
  basis: { asOfDate: string; amountCents: number } | null;
  months: FgtsMonth[];
  /** Estimated balance at the end of `today` (movements dated up to it); absent without `today`. */
  accumulatedTodayCents?: number;
}

export interface PayrollEvents {
  employmentId: string;
  salary: SalaryEvent[];
  thirteenth: ThirteenthEvent[];
  vacations: VacationEvent[];
  birthdayWithdrawals: BirthdayForecast[];
  fgts: FgtsForecast;
  /** Per-business-day benefits paid in the period, by payment date (not filtered by `today`). */
  benefits: DailyBenefitEvent[];
}

interface Movement {
  date: string;
  cents: number;
  kind: 'salary' | 'thirteenth' | 'vacation' | 'withdrawal' | 'forecast';
}

function monthOf(day: string): string {
  return day.slice(0, 7);
}

/** Every recorded or computed FGTS movement from the admission to the end of `throughMonth` (withdrawals negative). */
function baseMovements(data: EmploymentData, throughMonth: string, tables?: PayrollTableSet): Movement[] {
  const out: Movement[] = [];
  const adm = parseDay(data.admissionDate);
  const first = `${String(adm.year).padStart(4, '0')}-${String(adm.month).padStart(2, '0')}`;
  for (let c = first; c <= throughMonth; c = addMonths(c, 1)) {
    const ev = computeCompetence(data, c, tables);
    if (ev) out.push({ date: lastDayOfMonth(c), cents: ev.payroll.fgtsCents, kind: 'salary' });
  }
  for (let year = adm.year; year <= Number(throughMonth.slice(0, 4)); year++) {
    const t = thirteenthOfYear(data, year, tables);
    if (!t) continue;
    out.push({ date: lastDayOfMonth(monthOf(t.second.date)), cents: t.fgtsCents, kind: 'thirteenth' });
  }
  for (const v of data.vacations) {
    const e = vacationOf(data, v, tables);
    if (e) out.push({ date: lastDayOfMonth(monthOf(e.paymentDate)), cents: e.vacation.fgtsCents, kind: 'vacation' });
  }
  for (const w of data.fgts.withdrawals) out.push({ date: w.date, cents: -w.amountCents, kind: 'withdrawal' });
  return out.filter((m) => monthOf(m.date) <= throughMonth || m.kind === 'withdrawal');
}

/** Estimated balance at the end of `day`: the informed balance plus what moved after its date, or everything since the admission. */
function accumulatedAt(movements: readonly Movement[], basis: FgtsForecast['basis'], day: string): number {
  if (basis && day >= basis.asOfDate) {
    return basis.amountCents + movements.filter((m) => m.date > basis.asOfDate && m.date <= day).reduce((s, m) => s + m.cents, 0);
  }
  return movements.filter((m) => m.date <= day).reduce((s, m) => s + m.cents, 0);
}

/**
 * Birthday withdrawals forecast up to `range.to` (every one from the anchor year on, so a later year sees the earlier
 * ones leave the balance). The anchor is `today`, else the informed balance date, else `range.from`. A year is skipped
 * when its date is before the anchor, before or on the informed balance date, outside the employment, or when a
 * birthday withdrawal is already recorded in that calendar year.
 */
function forecastBirthday(
  data: EmploymentData,
  base: readonly Movement[],
  range: { from: string; to: string; today?: string },
): { forecasts: BirthdayForecast[]; movements: Movement[] } {
  const modes = data.fgts.modes ?? [];
  const basis = data.fgts.balance;
  const forecasts: BirthdayForecast[] = [];
  const movements: Movement[] = [];
  if (!modes.some((m) => m.mode === 'birthday')) return { forecasts, movements };
  const anchor = range.today ?? basis?.asOfDate ?? range.from;
  const recordedYears = new Set(data.fgts.withdrawals.filter((w) => w.kind === 'birthday').map((w) => Number(w.date.slice(0, 4))));
  const all = [...base];
  const isOff = offDayChecker(data.calendar);
  for (let year = Number(anchor.slice(0, 4)); year <= Number(range.to.slice(0, 4)); year++) {
    const candidates = modes
      .filter((m) => m.mode === 'birthday' && m.birthdayMonth)
      .map((m) => ({ m, date: nthBusinessDay(`${String(year).padStart(4, '0')}-${String(m.birthdayMonth).padStart(2, '0')}`, 5, isOff) }))
      .filter(({ m, date }) => valueInForce(modes, date) === m)
      .sort((a, b) => a.date.localeCompare(b.date));
    for (const { m, date } of candidates) {
      if (date > range.to || date < anchor || (basis && date <= basis.asOfDate)) continue;
      if (date < data.admissionDate || (data.endDate && date > data.endDate) || recordedYears.has(year)) continue;
      let amountCents: number;
      let balanceCents = 0;
      let tableId: string | null = null;
      if (m.expectedAmountCents != null) {
        amountCents = m.expectedAmountCents;
      } else {
        balanceCents = accumulatedAt(all, basis, addDays(date, -1));
        const table = selectBirthdayTable(date);
        tableId = table.id;
        amountCents = birthdayWithdrawalCents(balanceCents, table);
      }
      if (amountCents <= 0) continue;
      const movement: Movement = { date, cents: -amountCents, kind: 'forecast' };
      all.push(movement);
      movements.push(movement);
      forecasts.push({ year, date, amountCents, source: m.expectedAmountCents != null ? 'informed' : 'table', balanceCents, tableId });
    }
  }
  return { forecasts, movements };
}

export function buildFgtsForecast(
  data: EmploymentData,
  fromMonth: string,
  toMonth: string,
  today?: string,
  tables?: PayrollTableSet,
): FgtsForecast & { birthday: BirthdayForecast[] } {
  const basis = data.fgts.balance;
  const through = today && monthOf(today) > toMonth ? monthOf(today) : toMonth;
  const base = baseMovements(data, through, tables);
  const bday = forecastBirthday(data, base, { from: `${fromMonth}-01`, to: lastDayOfMonth(through), today });
  const movements = [...base, ...bday.movements];
  const months: FgtsMonth[] = [];
  for (let m = fromMonth; m <= toMonth; m = addMonths(m, 1)) {
    const inMonth = movements.filter((x) => monthOf(x.date) === m);
    const sum = (kind: Movement['kind']) => inMonth.filter((x) => x.kind === kind).reduce((s, x) => s + x.cents, 0);
    months.push({
      month: m,
      salaryDepositCents: sum('salary'),
      thirteenthDepositCents: sum('thirteenth'),
      vacationDepositCents: sum('vacation'),
      withdrawalsCents: -sum('withdrawal'),
      forecastWithdrawalCents: -sum('forecast'),
      accumulatedCents: accumulatedAt(movements, basis, lastDayOfMonth(m)),
    });
  }
  return {
    basis,
    months,
    birthday: bday.forecasts,
    ...(today ? { accumulatedTodayCents: accumulatedAt(movements, basis, today) } : {}),
  };
}

/** Salary, 13th, vacation, birthday withdrawal and FGTS events of the period. See the module comment for the rules. */
export function buildPayrollEvents(data: EmploymentData, options: EventOptions): PayrollEvents {
  const { from, to, today, tables, includePast = false } = options;
  const alive = (day: string) => !data.endDate || day <= data.endDate;
  const inRange = (day: string) => day >= from && day <= to;
  const isPast = (day: string) => today !== undefined && day < today;
  const notPast = (day: string) => includePast || !isPast(day);
  const mark = <T extends object>(event: T, day: string): T => (includePast ? { ...event, past: isPast(day) } : event);

  const salary: SalaryEvent[] = [];
  for (let c = addMonths(monthOf(from), -1); c <= addMonths(monthOf(to), -1); c = addMonths(c, 1)) {
    const ev = computeCompetence(data, c, tables);
    if (ev && inRange(ev.paymentDate)) salary.push(ev);
  }

  const thirteenth: ThirteenthEvent[] = [];
  for (let year = Number(from.slice(0, 4)); year <= Number(to.slice(0, 4)); year++) {
    const t = thirteenthOfYear(data, year, tables);
    if (!t) continue;
    const estimated = t.warnings.length > 0;
    if (inRange(t.first.date) && notPast(t.first.date) && alive(t.first.date)) {
      thirteenth.push(mark({ year, installment: 1, date: t.first.date, netCents: t.first.amountCents, estimated, thirteenth: t }, t.first.date));
    }
    if (inRange(t.second.date) && notPast(t.second.date) && alive(t.second.date)) {
      thirteenth.push(mark({ year, installment: 2, date: t.second.date, netCents: t.second.netCents, estimated, thirteenth: t }, t.second.date));
    }
  }
  thirteenth.sort((a, b) => a.date.localeCompare(b.date));

  const vacations: VacationEvent[] = [];
  for (const v of data.vacations) {
    const e = vacationOf(data, v, tables);
    if (e && inRange(e.paymentDate) && notPast(e.paymentDate) && alive(e.paymentDate)) vacations.push(mark(e, e.paymentDate));
  }
  vacations.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate));

  const { birthday, ...fgts } = buildFgtsForecast(data, monthOf(from), monthOf(to), today, tables);
  const birthdayWithdrawals = birthday.filter((b) => inRange(b.date)).map((b) => mark(b, b.date));
  if (includePast && today !== undefined) {
    // A past year is never recalculated: only what was really withdrawn, with the amount registered.
    for (const w of data.fgts.withdrawals) {
      if (w.kind !== 'birthday' || w.amountCents <= 0 || !isPast(w.date) || !inRange(w.date)) continue;
      birthdayWithdrawals.push({ year: Number(w.date.slice(0, 4)), date: w.date, amountCents: w.amountCents, source: 'recorded', balanceCents: 0, tableId: null, past: true });
    }
    birthdayWithdrawals.sort((a, b) => a.date.localeCompare(b.date));
  }
  return { employmentId: data.employmentId, salary, thirteenth, vacations, birthdayWithdrawals, fgts, benefits: benefitEvents(data, from, to) };
}

/** Periods of the marked vacations, as inclusive days. */
function vacationSpans(data: EmploymentData): Array<{ start: string; end: string }> {
  return data.vacations.map((v) => {
    const p = vacationPeriodOf(v);
    return { start: p.start, end: p.end };
  });
}

/** The benefit of one reference month, or null when it does not apply then. */
export function benefitOfReference(data: EmploymentData, benefit: DailyBenefitData, referenceMonth: string): DailyBenefitEvent | null {
  return computeDailyBenefit(benefit, referenceMonth, {
    admissionDate: data.admissionDate,
    endDate: data.endDate,
    calendar: data.calendar,
    vacations: vacationSpans(data),
  });
}

/** The benefit paid in `paymentMonth` ('YYYY-MM'): the one of the reference month `offset` months later. */
export function benefitPaidInMonth(data: EmploymentData, benefit: DailyBenefitData, paymentMonth: string): DailyBenefitEvent | null {
  return benefitOfReference(data, benefit, addMonths(paymentMonth, benefit.referenceMonthOffset));
}

/** Per-business-day benefits whose payment date is in [from, to], sorted by payment date then name. */
export function benefitEvents(data: EmploymentData, from: string, to: string, only?: (b: DailyBenefitData) => boolean): DailyBenefitEvent[] {
  const out: DailyBenefitEvent[] = [];
  for (const benefit of data.benefits ?? []) {
    if (only && !only(benefit)) continue;
    for (let pay = addMonths(monthOf(from), -1); pay <= addMonths(monthOf(to), 1); pay = addMonths(pay, 1)) {
      const ev = benefitPaidInMonth(data, benefit, pay);
      if (ev && ev.paymentDate >= from && ev.paymentDate <= to) out.push(ev);
    }
  }
  return out.sort((a, b) => a.paymentDate.localeCompare(b.paymentDate) || a.name.localeCompare(b.name));
}

export interface ExtraPayrollEvent {
  employmentId: string;
  kind: 'thirteenth_first' | 'thirteenth_second' | 'vacation' | 'fgts_birthday';
  date: string;
  description: string;
  netCents: number;
  estimated: boolean;
}

/** The 13th, vacation and birthday-withdrawal events as plain dated amounts (what the cash flow and the card commitment consume). */
export function extraPayrollEvents(data: EmploymentData, options: EventOptions): ExtraPayrollEvent[] {
  // Cash flow and card income only want what is still to come: the past flag never applies here.
  const ev = buildPayrollEvents(data, { ...options, includePast: false });
  const id = data.employmentId;
  const out: ExtraPayrollEvent[] = [
    ...ev.thirteenth.map(
      (t): ExtraPayrollEvent => ({
        employmentId: id,
        kind: t.installment === 1 ? 'thirteenth_first' : 'thirteenth_second',
        date: t.date,
        description: `13º salário (${t.installment}ª parcela)`,
        netCents: t.netCents,
        estimated: t.estimated,
      }),
    ),
    ...ev.vacations.map(
      (v): ExtraPayrollEvent => ({ employmentId: id, kind: 'vacation', date: v.paymentDate, description: 'Férias', netCents: v.netCents, estimated: v.estimated }),
    ),
    ...ev.birthdayWithdrawals.map(
      (b): ExtraPayrollEvent => ({ employmentId: id, kind: 'fgts_birthday', date: b.date, description: 'Saque-aniversário FGTS', netCents: b.amountCents, estimated: true }),
    ),
  ];
  return out.filter((e) => e.netCents !== 0).sort((a, b) => a.date.localeCompare(b.date) || a.kind.localeCompare(b.kind));
}

/** Net salary paid in `paymentMonth` ('YYYY-MM'), i.e. the competence of the month before; null when none applies. */
export function salaryPaidInMonth(data: EmploymentData, paymentMonth: string, tables?: PayrollTableSet): SalaryEvent | null {
  return computeCompetence(data, addMonths(paymentMonth, -1), tables);
}

export { benefitPaymentDate, DEFAULT_PAYROLL_METHOD };
