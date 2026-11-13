/**
 * Projected cash flow: the balance of the cash accounts, day by day, from today, using only what is already known
 * (pending entries, the occurrences the recurrences will still generate, and the payment of each card invoice on its
 * due date). Pure part: no database, no clock. Everything is summed in whole cents; amounts go out in money units.
 * Read-only by design: nothing here creates an entry or touches a balance.
 */

import type { EarlyDiscountQuote } from '../recurring-transactions/early-discount.js';

/** The discount of a recurrence event, plus what the screen needs to pay it ahead (POST /recurring-transactions/:recurringId/pay-next). */
export interface CashFlowEarlyDiscount extends EarlyDiscountQuote {
  recurringId: string;
  /** 'YYYY-MM-DD' of the occurrence (its due date). */
  occurrenceDate: string;
  /** True when this is the occurrence pay-next would pay (the one of the recurrence's nextRunAt). */
  canPayNow: boolean;
}

/**
 * 'payroll': 13th, vacation and FGTS birthday withdrawal forecast by an employment (never a recorded entry).
 * 'reserve': the planned contribution of a savings goal not yet made this month (sourceId = the goal). It leaves the FREE
 * balance (see `allocated`); it never leaves the account.
 */
export type CashFlowSource = 'pending' | 'recurrence' | 'payroll' | 'invoice' | 'reserve';
export type CashFlowCertainty = 'confirmed' | 'expected' | 'estimated';

/** An event as the loader hands it over: dates are 'YYYY-MM-DD', the amount is signed whole cents (income +, outflow -). */
export interface CashFlowEventInput {
  date: string;
  description: string;
  amountCents: number;
  source: CashFlowSource;
  certainty: CashFlowCertainty;
  /** True when the loader already knows the event was due before today (it is also derived from `date`). */
  overdue?: boolean;
  /** Id of the pending entry, of the recurrence, of the employment (payroll) or of the card (invoices). */
  sourceId: string;
  /** The cash account the event moves. */
  accountId: string;
  /** Invoices only: 'YYYY-MM' of the invoice. */
  invoiceMonth?: string | null;
  /** Recurrences with an early-payment discount that can still be had: the amount above is the discounted one. */
  earlyDiscount?: CashFlowEarlyDiscount;
}

/** An unpaid invoice with nobody to pay it: it is listed apart and never enters the balance. */
export interface UnassignedInvoiceInput {
  accountId: string;
  accountName: string;
  month: string;
  dueDate: string | null;
  amountCents: number;
  reason: 'no_payer_account' | 'no_due_date';
}

export interface CashFlowInput {
  /** The FREE balance: what the accounts hold minus what the savings goals keep in them (`allocatedCents`). */
  startingBalanceCents: number;
  /** What the savings goals of these accounts keep; only reported (the balance above already excludes it). Default 0. */
  allocatedCents?: number;
  /** 'YYYY-MM-DD' (UTC) */
  today: string;
  /** Length of the period in days after today; the period runs from today to today + days, both inclusive. */
  days: number;
  events: readonly CashFlowEventInput[];
  unassignedInvoices?: readonly UnassignedInvoiceInput[];
}

export interface CashFlowEvent {
  /** Day the money moves in the projection (an overdue item is moved to today). */
  date: string;
  description: string;
  /** Signed, in money units. */
  amount: number;
  source: CashFlowSource;
  certainty: CashFlowCertainty;
  overdue: boolean;
  /** Overdue items only: the day they were due. */
  originalDate: string | null;
  sourceId: string;
  accountId: string;
  invoiceMonth: string | null;
  /**
   * Only present on a recurrence occurrence whose early-payment discount can still be had (today <= limitDate): `amount`
   * is then the discounted one, `fullAmount` what it costs after `limitDate`. Absent otherwise.
   */
  earlyDiscount?: CashFlowEarlyDiscount;
}

export interface CashFlowDay {
  date: string;
  events: CashFlowEvent[];
  inflow: number;
  outflow: number;
  net: number;
  /** Balance at the end of the day. */
  endBalance: number;
}

export interface CashFlowSummary {
  /** Lowest end-of-day balance of the period and the first day it happens. */
  lowestBalance: { date: string; amount: number };
  /** First day the end-of-day balance is below zero; null when it never is. */
  firstNegativeDate: string | null;
  endingBalance: number;
  /** End-of-day balance after 30, 60 and 90 days, for the ones that fit in the period. */
  balanceAfterDays: Array<{ days: number; date: string; balance: number }>;
  totalInflow: number;
  /** Magnitude of the outflows (positive). */
  totalOutflow: number;
  eventCount: number;
  /** Events whose value is not firm (certainty 'estimated'): the screen should warn that the number is not exact. */
  estimatedCount: number;
  overdueCount: number;
}

export interface CashFlowProjection {
  period: { from: string; to: string; days: number };
  /** Free balance at the start (what the accounts hold minus `allocated`); every balance below is free balance too. */
  startingBalance: number;
  /** Kept in savings goals inside these accounts right now (one definition: modules/savings-goals/savings-goals.planning.ts). */
  allocated: number;
  /** What the accounts hold (matches the statements): `startingBalance + allocated`. */
  totalBalance: number;
  days: CashFlowDay[];
  summary: CashFlowSummary;
  unassignedInvoices: Array<{
    accountId: string;
    accountName: string;
    month: string;
    dueDate: string | null;
    amount: number;
    reason: UnassignedInvoiceInput['reason'];
  }>;
}

export const CASH_FLOW_HORIZONS = [30, 60, 90] as const;

const fromCents = (cents: number): number => cents / 100;

/** 'YYYY-MM-DD' + n days (calendar arithmetic in UTC, free of daylight saving). */
export function addDays(day: string, n: number): string {
  const d = new Date(Date.UTC(Number(day.slice(0, 4)), Number(day.slice(5, 7)) - 1, Number(day.slice(8, 10)) + n));
  return `${String(d.getUTCFullYear()).padStart(4, '0')}-${String(d.getUTCMonth() + 1).padStart(2, '0')}-${String(d.getUTCDate()).padStart(2, '0')}`;
}

const SOURCE_ORDER: Record<CashFlowSource, number> = { pending: 0, recurrence: 1, payroll: 2, invoice: 3, reserve: 4 };

/**
 * Builds the projection. An event dated before today is moved to today and marked overdue (the money is still due, and
 * it leaves the account today at the earliest); an event after the end of the period is left out. Days without events
 * are omitted: the balance holds from the last listed day. Events of the same day add up; the day's balance is the one
 * at its end.
 */
export function buildCashFlow(input: CashFlowInput): CashFlowProjection {
  const { today, days: horizon } = input;
  const end = addDays(today, horizon);

  const events: CashFlowEvent[] = [];
  for (const e of input.events) {
    if (!Number.isInteger(e.amountCents)) throw new Error('Cash flow amounts must be whole cents');
    if (e.date > end) continue;
    const late = e.date < today;
    events.push({
      date: late ? today : e.date,
      description: e.description,
      amount: fromCents(e.amountCents),
      source: e.source,
      certainty: e.certainty,
      overdue: late || e.overdue === true,
      originalDate: late ? e.date : null,
      sourceId: e.sourceId,
      accountId: e.accountId,
      invoiceMonth: e.invoiceMonth ?? null,
      ...(e.earlyDiscount && { earlyDiscount: e.earlyDiscount }),
    });
  }
  // Same order everywhere: day, kind of source, description, id (a stable list for the screen and for the tests)
  const centsOf = new Map<CashFlowEvent, number>();
  const withCents = events.map((event) => ({ event, cents: Math.round(event.amount * 100) }));
  for (const w of withCents) centsOf.set(w.event, w.cents);
  events.sort(
    (a, b) =>
      a.date.localeCompare(b.date) ||
      SOURCE_ORDER[a.source] - SOURCE_ORDER[b.source] ||
      a.description.localeCompare(b.description) ||
      a.sourceId.localeCompare(b.sourceId) ||
      (centsOf.get(a)! - centsOf.get(b)!),
  );

  const byDay = new Map<string, CashFlowEvent[]>();
  for (const event of events) {
    const list = byDay.get(event.date);
    if (list) list.push(event);
    else byDay.set(event.date, [event]);
  }

  let balanceCents = input.startingBalanceCents;
  let inflowCents = 0;
  let outflowCents = 0;
  let lowest = { date: today, cents: Number.POSITIVE_INFINITY };
  let firstNegative: string | null = null;
  const dayList: CashFlowDay[] = [];
  // End-of-day balance in cents of every day that changes it (plus today, the first day of the period)
  const checkpoints: Array<{ date: string; cents: number }> = [];

  const consider = (date: string): void => {
    if (balanceCents < lowest.cents) lowest = { date, cents: balanceCents };
    if (balanceCents < 0 && firstNegative === null) firstNegative = date;
  };

  const dates = [...byDay.keys()].sort();
  if (!byDay.has(today)) {
    checkpoints.push({ date: today, cents: balanceCents });
    consider(today);
  }
  for (const date of dates) {
    const list = byDay.get(date)!;
    let dayIn = 0;
    let dayOut = 0;
    for (const event of list) {
      const cents = centsOf.get(event)!;
      if (cents >= 0) dayIn += cents;
      else dayOut += -cents;
    }
    balanceCents += dayIn - dayOut;
    inflowCents += dayIn;
    outflowCents += dayOut;
    checkpoints.push({ date, cents: balanceCents });
    consider(date);
    dayList.push({
      date,
      events: list,
      inflow: fromCents(dayIn),
      outflow: fromCents(dayOut),
      net: fromCents(dayIn - dayOut),
      endBalance: fromCents(balanceCents),
    });
  }

  // Balance at the end of a given day: the last checkpoint on or before it
  const balanceAt = (date: string): number => {
    let cents = input.startingBalanceCents;
    for (const c of checkpoints) {
      if (c.date <= date) cents = c.cents;
      else break;
    }
    return cents;
  };

  const summary: CashFlowSummary = {
    lowestBalance: { date: lowest.date, amount: fromCents(lowest.cents) },
    firstNegativeDate: firstNegative,
    endingBalance: fromCents(balanceCents),
    balanceAfterDays: CASH_FLOW_HORIZONS.filter((h) => h <= horizon).map((h) => {
      const date = addDays(today, h);
      return { days: h, date, balance: fromCents(balanceAt(date)) };
    }),
    totalInflow: fromCents(inflowCents),
    totalOutflow: fromCents(outflowCents),
    eventCount: events.length,
    estimatedCount: events.filter((e) => e.certainty === 'estimated').length,
    overdueCount: events.filter((e) => e.overdue).length,
  };

  return {
    period: { from: today, to: end, days: horizon },
    startingBalance: fromCents(input.startingBalanceCents),
    allocated: fromCents(input.allocatedCents ?? 0),
    totalBalance: fromCents(input.startingBalanceCents + (input.allocatedCents ?? 0)),
    days: dayList,
    summary,
    unassignedInvoices: (input.unassignedInvoices ?? []).map((u) => ({
      accountId: u.accountId,
      accountName: u.accountName,
      month: u.month,
      dueDate: u.dueDate,
      amount: fromCents(u.amountCents),
      reason: u.reason,
    })),
  };
}
