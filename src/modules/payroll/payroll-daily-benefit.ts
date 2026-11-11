/**
 * Benefit paid per business day (vale-alimentação and the like). Pure: no database, no clock. Whole cents.
 *
 * - Days counted in the REFERENCE month = Monday-to-Friday days of the month inside the employment (admission to end
 *   date), minus the days off of the employment's holiday calendar, minus the business days covered by marked
 *   vacations, minus the prudence margin (`marginDays`, per benefit); never below zero.
 * - Value per day: the entry of the history in force on the first day of the reference month inside the employment
 *   (a new value starting in the middle of a month takes effect from the next month; past months never change).
 * - The payment month is the reference month minus `referenceMonthOffset` (offset 1 = paid in the month before the one
 *   it refers to, e.g. paid on day 25 for the next month); the payment date is `payDay` of that month (no business-day
 *   move). Always `estimated`: it is a forecast, the real amount comes with the entry.
 * - Outside every base (INSS, IRRF, FGTS) and outside the net salary: it has its own payment.
 */
import { addMonths, diffDays, formatDay, parseDay } from './payroll-dates.js';
import { countsAsOff, holidaysOfYear, tablesFor, type HolidayConfig, type HolidayLevel, type HolidayWarning } from './payroll-holidays.js';

export interface DailyBenefitData {
  id: string;
  name: string;
  /** Value per day, dated; the one in force on the first day of the reference month applies. */
  values: ReadonlyArray<{ startDate: string; amountCents: number }>;
  /** Day of the payment month the money arrives (clamped to the month length). */
  payDay: number;
  /** Reference month minus payment month, in months: 1 = paid the month before the days it counts. */
  referenceMonthOffset: number;
  /** Destination account when there is no linked recurrence; null = the employment's account. */
  accountId: string | null;
  /** Counts as available money in the cash flow and in the card's expected income; false = shown only in the events. */
  isAvailableCash: boolean;
  /** Recurrence whose occurrences take the calculated value; null = the benefit has its own event. */
  recurringTransactionId: string | null;
  recurrenceActive: boolean;
  marginDays: number;
}

export interface BenefitHoliday {
  date: string;
  name: string;
  level: HolidayLevel;
  optional: boolean;
}

export interface DailyBenefitWarning {
  code: HolidayWarning['code'] | 'unconfirmed_holiday';
  message: string;
  date?: string;
}

export interface DailyBenefitEvent {
  itemId: string;
  name: string;
  /** 'YYYY-MM' the counted days belong to. */
  referenceMonth: string;
  paymentDate: string;
  ratePerDayCents: number;
  /** Monday-to-Friday days of the month inside the employment. */
  weekdays: number;
  /** Weekdays removed by the holiday calendar. */
  holidayDays: number;
  /** Weekdays removed by marked vacations. */
  vacationDays: number;
  marginDays: number;
  countedDays: number;
  amountCents: number;
  estimated: true;
  isAvailableCash: boolean;
  accountId: string | null;
  recurringTransactionId: string | null;
  /** The holidays removed from the count. */
  holidays: BenefitHoliday[];
  warnings: DailyBenefitWarning[];
}

export interface BenefitContext {
  admissionDate: string;
  endDate?: string | null;
  calendar?: HolidayConfig | null;
  /** Periods of marked vacations, inclusive. */
  vacations?: ReadonlyArray<{ start: string; end: string }>;
}

function rateOn(values: DailyBenefitData['values'], day: string): number | null {
  let best: { startDate: string; amountCents: number } | undefined;
  for (const v of values) if (v.startDate <= day && (!best || v.startDate > best.startDate)) best = v;
  return best ? best.amountCents : null;
}

export function benefitPaymentDate(benefit: Pick<DailyBenefitData, 'payDay' | 'referenceMonthOffset'>, referenceMonth: string): string {
  const pay = addMonths(referenceMonth, -benefit.referenceMonthOffset);
  return formatDay(Number(pay.slice(0, 4)), Number(pay.slice(5, 7)), benefit.payDay);
}

/** The benefit of one reference month ('YYYY-MM'); null when the employment is not there then or no value is in force. */
export function computeDailyBenefit(benefit: DailyBenefitData, referenceMonth: string, ctx: BenefitContext): DailyBenefitEvent | null {
  const year = Number(referenceMonth.slice(0, 4));
  const monthNumber = Number(referenceMonth.slice(5, 7));
  const first = formatDay(year, monthNumber, 1);
  const last = formatDay(year, monthNumber, 31);
  const from = ctx.admissionDate > first ? ctx.admissionDate : first;
  const to = ctx.endDate && ctx.endDate < last ? ctx.endDate : last;
  if (to < from) return null;
  const rate = rateOn(benefit.values, from);
  if (rate === null) return null;

  const calendar = ctx.calendar ?? null;
  const holidays = holidaysOfYear(calendar, year).filter((h) => h.date >= from && h.date <= to);
  const offByDate = new Map(holidays.filter((h) => countsAsOff(h, calendar)).map((h) => [h.date, h]));
  const warnings: DailyBenefitWarning[] = [...(tablesFor(calendar)?.warnings ?? [])];

  let weekdays = 0;
  let holidayDays = 0;
  let vacationDays = 0;
  const removed: BenefitHoliday[] = [];
  const span = diffDays(from, to);
  for (let i = 0; i <= span; i++) {
    const d = parseDay(from);
    const day = formatDay(d.year, d.month, d.day + i);
    const weekday = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)))).getUTCDay();
    if (weekday === 0 || weekday === 6) continue;
    weekdays++;
    const off = offByDate.get(day);
    if (off) {
      holidayDays++;
      removed.push({ date: day, name: off.name, level: off.level, optional: off.optional });
      continue;
    }
    const unconfirmed = holidays.find((h) => h.date === day && !h.confirmed);
    if (unconfirmed) warnings.push({ code: 'unconfirmed_holiday', date: day, message: `${unconfirmed.name} (${day}) não está confirmado em fonte oficial e não foi descontado` });
    if ((ctx.vacations ?? []).some((v) => v.start <= day && day <= v.end)) vacationDays++;
  }

  const margin = Math.max(0, Math.trunc(benefit.marginDays));
  const countedDays = Math.max(0, weekdays - holidayDays - vacationDays - margin);
  return {
    itemId: benefit.id,
    name: benefit.name,
    referenceMonth,
    paymentDate: benefitPaymentDate(benefit, referenceMonth),
    ratePerDayCents: rate,
    weekdays,
    holidayDays,
    vacationDays,
    marginDays: margin,
    countedDays,
    amountCents: rate * countedDays,
    estimated: true,
    isAvailableCash: benefit.isAvailableCash,
    accountId: benefit.accountId,
    recurringTransactionId: benefit.recurringTransactionId,
    holidays: removed,
    warnings,
  };
}
