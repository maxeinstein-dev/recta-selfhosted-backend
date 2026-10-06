import type { Prisma } from '../../generated/prisma/client.js';
import { CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { addMonthsClamped, anchorDayOf, dayString, daysInMonth, localDate } from '../recurring-transactions/recurring-dates.js';
import { calculateNextRunDate, occurrenceDateFor } from '../recurring-transactions/recurring-transactions.service.js';

/** Upper bound of occurrences walked per recurrence (a daily one over a month, or a very stale monthly one). */
const MAX_STEPS = 800;

export type InvoiceState = 'open' | 'closed' | 'paid';

export interface ForecastItem {
  recurringTransactionId: string;
  description: string;
  categoryName: string;
  /** 'YYYY-MM-DD' the occurrence is expected on. */
  date: string;
  /** Whole-cent amount: positive raises the invoice, negative (an income / refund recurrence) lowers it. */
  amount: number;
  /** True when the recurrence follows the last amount, so the value is an estimate. */
  followsLastAmount: boolean;
}

export interface InvoiceForecast {
  /** False when the invoice already closed: nothing is expected any more. */
  applicable: boolean;
  items: ForecastItem[];
  /** Sum of the items. */
  total: number;
  /** Already posted statement amount + forecast total (the expected statement total at closing). */
  expectedClosingTotal: number;
}

export interface InvoiceDates {
  /** First day of the window, 'YYYY-MM-DD' (the previous closing day). */
  windowStart: string;
  /** Last day of the window, 'YYYY-MM-DD' (the day before the closing day). */
  windowEnd: string;
  /** Closing day of this invoice: the first day that already belongs to the next one. */
  closingDate: string;
  /** First due day strictly after the closing date; null when the card has no due day. */
  dueDate: string | null;
}

const toDay = (date: Date) => dayString(date);

/** Whole cents of a money value (sums of cents drift in binary). */
export const toCents = (value: number) => Math.round(value * 100);
export const fromCents = (cents: number) => cents / 100;

/** Window, closing and due dates of an invoice, from the window helper's UTC bounds. */
export function invoiceDates(window: { start: Date; end: Date }, dueDay: number | null | undefined): InvoiceDates {
  const windowStart = toDay(window.start);
  const windowEnd = toDay(window.end);
  const closingDate = nextDay(windowEnd);
  let dueDate: string | null = null;
  if (dueDay && Number.isInteger(dueDay) && dueDay >= 1 && dueDay <= 31) {
    const year = Number(closingDate.slice(0, 4));
    const month = Number(closingDate.slice(5, 7));
    const sameMonth = clampDay(year, month, dueDay);
    dueDate = sameMonth > closingDate ? sameMonth : addMonthsClamped(closingDate.slice(0, 8) + '01', 1, dueDay);
  }
  return { windowStart, windowEnd, closingDate, dueDate };
}

function clampDay(year: number, month: number, day: number): string {
  const d = Math.min(day, daysInMonth(year, month));
  return `${String(year).padStart(4, '0')}-${String(month).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
}

function nextDay(day: string): string {
  return toDay(new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + 1)));
}

/** Lifecycle of an invoice as of `today`: open until its closing date, then closed, or paid when nothing is owed. */
export function invoiceState(closingDate: string, today: string, isPaid: boolean): InvoiceState {
  if (today < closingDate) return 'open';
  return isPaid ? 'paid' : 'closed';
}

export interface ForecastRecurrence {
  id: string;
  description: string | null;
  categoryName: string;
  amount: number;
  frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY';
  startDate: Date;
  endDate: Date | null;
  nextRunAt: Date;
  followLastAmount: boolean;
  /** Sign of the amount on the card: -1 for an income / refund recurrence. */
  sign: 1 | -1;
}

/**
 * Occurrences of one recurrence expected inside the invoice window that have not been generated yet.
 * `generated` holds `<recurrenceId>:<YYYY-MM>` (monthly) and `<recurrenceId>:<YYYY-MM-DD>` keys of transactions that
 * already exist: executing a monthly recurrence in a month that already holds one creates nothing, so it must not be
 * counted either. Dates before today are occurrences still waiting for the cron (they will be dated on their scheduled
 * day), those from the window start on are counted.
 */
export function projectRecurrence(
  rec: ForecastRecurrence,
  win: { windowStart: string; windowEnd: string },
  today: string,
  generated: ReadonlySet<string>,
): ForecastItem[] {
  const items: ForecastItem[] = [];
  const anchor = anchorDayOf(rec.startDate);
  const end = rec.endDate ? dayString(rec.endDate) : null;
  const next = dayString(rec.nextRunAt);
  const todayDate = localDate(today);

  let date = next <= today ? dayString(occurrenceDateFor(rec.frequency, localDate(next), todayDate)) : next;
  for (let step = 0; step < MAX_STEPS && date <= win.windowEnd; step += 1) {
    if (end && date > end) break;
    if (date >= win.windowStart) {
      const key = rec.frequency === 'MONTHLY' ? `${rec.id}:${date.slice(0, 7)}` : `${rec.id}:${date}`;
      if (!generated.has(key)) {
        items.push({
          recurringTransactionId: rec.id,
          description: rec.description?.trim() || rec.categoryName,
          categoryName: rec.categoryName,
          date,
          amount: fromCents(toCents(rec.amount) * rec.sign),
          followsLastAmount: rec.followLastAmount,
        });
      }
    }
    date = dayString(calculateNextRunDate(localDate(date), rec.frequency, anchor));
  }
  return items;
}

/** Pure part: forecast of a list of recurrences for an invoice. */
export function buildForecast(
  recurrences: ForecastRecurrence[],
  generated: ReadonlySet<string>,
  dates: InvoiceDates,
  today: string,
  statementTotalCents: number,
): InvoiceForecast {
  // The window's closing day starts the next invoice: an invoice that already closed has no forecast.
  if (today >= dates.closingDate) {
    return { applicable: false, items: [], total: 0, expectedClosingTotal: fromCents(statementTotalCents) };
  }
  const items = recurrences
    .flatMap((rec) => projectRecurrence(rec, dates, today, generated))
    .sort((a, b) => a.date.localeCompare(b.date) || a.description.localeCompare(b.description));
  const totalCents = items.reduce((sum, item) => sum + toCents(item.amount), 0);
  return {
    applicable: true,
    items,
    total: fromCents(totalCents),
    expectedClosingTotal: fromCents(statementTotalCents + totalCents),
  };
}

type Client = Pick<Prisma.TransactionClient, 'recurringTransaction' | 'transaction'> & Partial<Pick<Prisma.TransactionClient, 'category'>>;

/**
 * Loads the card's active recurrences and the occurrences already generated, then builds the forecast.
 * `today` is a UTC date-only 'YYYY-MM-DD' (the recurrence cron uses the server's local date, so late in the evening the
 * two can differ by a day). Only the invoice asked for is forecast: the debt of a future invoice does not include the
 * forecast of the invoices before it.
 */
export async function loadInvoiceForecast(
  client: Client,
  params: { householdId: string; accountId: string; dates: InvoiceDates; today: string; statementTotalCents: number },
): Promise<InvoiceForecast> {
  const { householdId, accountId, dates, today, statementTotalCents } = params;
  if (today >= dates.closingDate) return buildForecast([], new Set(), dates, today, statementTotalCents);

  const rows = await client.recurringTransaction.findMany({
    where: { householdId, accountId, isActive: true },
  });
  if (rows.length === 0) return buildForecast([], new Set(), dates, today, statementTotalCents);

  const customIds = rows.filter((r) => isCustomCategoryName(r.categoryName)).map((r) => toCustomCategoryId(r.categoryName)!);
  const customTypes = new Map<string, string>();
  if (customIds.length > 0 && client.category) {
    const cats = await client.category.findMany({ where: { householdId, id: { in: customIds } }, select: { id: true, type: true } });
    for (const c of cats) customTypes.set(c.id, c.type);
  }
  const incomeBuiltIn = new Set<string>(getCategoriesByType(CategoryType.INCOME));
  const signOf = (categoryName: string): 1 | -1 => {
    if (isCustomCategoryName(categoryName)) return customTypes.get(toCustomCategoryId(categoryName)!) === CategoryType.INCOME ? -1 : 1;
    return incomeBuiltIn.has(categoryName) ? -1 : 1;
  };

  // Occurrences already created inside the window months (a monthly one counts per calendar month).
  const monthStart = localUtc(dates.windowStart.slice(0, 7) + '-01');
  const afterEnd = localUtc(addMonthsClamped(dates.windowEnd.slice(0, 7) + '-01', 1, 1));
  const existing = await client.transaction.findMany({
    where: {
      householdId,
      recurringTransactionId: { in: rows.map((r) => r.id) },
      date: { gte: monthStart, lt: afterEnd },
    },
    select: { recurringTransactionId: true, date: true },
  });
  const generated = new Set<string>();
  for (const t of existing) {
    if (!t.recurringTransactionId) continue;
    const d = dayString(t.date);
    generated.add(`${t.recurringTransactionId}:${d}`);
    generated.add(`${t.recurringTransactionId}:${d.slice(0, 7)}`);
  }
  // The month key only guards monthly recurrences (see projectRecurrence), so the extra keys are harmless to others.

  const recurrences: ForecastRecurrence[] = rows.map((r) => ({
    id: r.id,
    description: r.description,
    categoryName: r.categoryName,
    amount: r.amount.toNumber(),
    frequency: r.frequency,
    startDate: r.startDate,
    endDate: r.endDate,
    nextRunAt: r.nextRunAt,
    followLastAmount: r.followLastAmount,
    sign: signOf(r.categoryName),
  }));
  return buildForecast(recurrences, generated, dates, today, statementTotalCents);
}

function localUtc(day: string): Date {
  return new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10))));
}
