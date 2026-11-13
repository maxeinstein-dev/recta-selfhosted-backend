import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { addMonthKey } from '../transactions/credit-card-commitment.js';
import { projectRecurrence, toCents, type ForecastRecurrence, type InvoiceState } from '../transactions/credit-card-invoice-forecast.js';
import { calculateCreditCardInvoice, utcToday } from '../transactions/transactions.service.js';
import { dayString, localDate } from '../recurring-transactions/recurring-dates.js';
import { earlyDiscountQuoteOf, forecastBatch, referenceMonthOf } from '../recurring-transactions/recurring-forecast.js';
import { amountOnDay, earlyDiscountOf } from '../recurring-transactions/early-discount.js';
import { benefitEvents, benefitPaidInMonth, extraPayrollEvents, salaryPaidInMonth } from '../payroll/payroll-events.js';
import { loadPayrollLinks, type PayrollLink } from '../payroll/payroll.links.js';
import { allocatedCentsByAccount, plannedContributions } from '../savings-goals/savings-goals.planning.js';
import { planGoalOf, type GoalRow } from '../savings-goals/savings-goals.contributions.js';
import { addDays, buildCashFlow, type CashFlowEventInput, type CashFlowProjection, type UnassignedInvoiceInput } from './cash-flow.js';

/** Account types the projection is about: where the household's money sits. Cards and investments are left out. */
const CASH_TYPES = ['CHECKING', 'SAVINGS', 'CASH'] as const;
const INVOICE_PAYMENT_PREFIX = 'invoice_pay:';

/** The part of `calculateCreditCardInvoice(...).data` the projection reads. */
export interface InvoiceSnapshot {
  statementTotal: number;
  outstandingFromPrevious: number;
  currentPayments: number;
  state: InvoiceState;
  dueDate: string | null;
  forecast: { applicable: boolean; total: number };
}

export interface InvoiceSettlement {
  /** 'YYYY-MM' of the invoice the payment is attributed to (the last one of an overdue group). */
  month: string;
  /** Day the payment is due; null when the card has no due day. Before today for the overdue group. */
  dueDate: string | null;
  /** Whole cents leaving the payer account; always above one cent. */
  amountCents: number;
  certainty: 'confirmed' | 'estimated';
  overdue: boolean;
}

/** What one invoice adds to the card's debt on its own: posted, plus the forecast while open, minus what was paid on it. */
export function invoiceOwnCents(data: InvoiceSnapshot): number {
  const forecastCents = data.state === 'open' && data.forecast.applicable ? toCents(data.forecast.total) : 0;
  return toCents(data.statementTotal) + forecastCents - toCents(data.currentPayments);
}

/**
 * Turns the invoices of ONE card, walked in chronological order, into the payments that leave the payer account.
 * The debt is carried from one invoice to the next, so credit and debt offset each other:
 * - the starting debt is the `outstandingFromPrevious` of the FIRST invoice, and only that one. The later invoices carry
 *   the same figure but it is clamped at zero by the invoice route (it drops a credit) and it repeats invoices the walk
 *   already adds one by one, so reading it again would count the past twice and lose the credits;
 * - invoice after invoice the carry grows by the invoice's own amount (`invoiceOwnCents`);
 * - a paid invoice means the card owes nothing up to it (the route computes that with the earlier invoices): the carry resets;
 * - invoices due before today are summed together and give at most ONE overdue payment, today, when the net is above one
 *   cent; a net credit (or a one-cent residue) is not a payment and moves on to the next invoice, reducing its payment;
 * - any other invoice settles on its own due date when the carry is above one cent, and the carry returns to zero; a
 *   credit left at the end of the walk pays nothing (it is not income).
 */
export function settleInvoices(walk: ReadonlyArray<{ month: string; data: InvoiceSnapshot }>, today: string): InvoiceSettlement[] {
  const out: InvoiceSettlement[] = [];
  let carry = walk.length > 0 ? toCents(walk[0]!.data.outstandingFromPrevious) : 0;
  let overdueLast: { month: string; dueDate: string | null } | null = null;

  const settle = (month: string, dueDate: string | null, certainty: 'confirmed' | 'estimated', overdue: boolean): void => {
    if (carry > 1) {
      out.push({ month, dueDate, amountCents: carry, certainty, overdue });
      carry = 0;
    } else if (carry >= 0) {
      carry = 0; // a one-cent residue is not a debt; a credit (below zero) stays for the next invoice
    }
  };

  for (const { month, data } of walk) {
    if (data.state === 'paid') {
      carry = 0;
      overdueLast = null;
      continue;
    }
    const overdue = data.dueDate !== null && data.dueDate < today;
    if (!overdue && overdueLast) {
      settle(overdueLast.month, overdueLast.dueDate, 'confirmed', true);
      overdueLast = null;
    }
    carry += invoiceOwnCents(data);
    if (overdue) {
      overdueLast = { month, dueDate: data.dueDate };
      continue;
    }
    settle(month, data.dueDate, data.state === 'open' ? 'estimated' : 'confirmed', false);
  }
  if (overdueLast) settle(overdueLast.month, overdueLast.dueDate, 'confirmed', true);
  return out;
}

export interface CashFlowParams {
  householdId: string;
  accountId?: string;
  days: number;
  today?: Date;
}

/**
 * Loads what the projection needs and builds it. One account, or all the active cash accounts of the household (a
 * transfer between two of them is always paid, so it never shows as a pending entry and adds up to zero in the set).
 * Queries are per kind, never per day: accounts, pending entries, recurrences (+ the occurrences already generated),
 * the last payment of each card, and one invoice calculation per card and month of the period.
 */
export async function loadCashFlow(params: CashFlowParams): Promise<CashFlowProjection & { currency: string | null }> {
  const { householdId, days } = params;
  const today = dayString(params.today ?? utcToday());
  const end = addDays(today, days);
  const endUtc = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)) - 1, Number(end.slice(8, 10))));

  const accounts = await prisma.account.findMany({ where: { householdId, isActive: true } });
  const isCash = (a: (typeof accounts)[number]) => (CASH_TYPES as readonly string[]).includes(a.type);

  let scope = accounts.filter(isCash);
  if (params.accountId) {
    const chosen = accounts.find((a) => a.id === params.accountId);
    if (!chosen) throw new NotFoundError('Account');
    if (!isCash(chosen)) throw new BadRequestError('The projection is for cash accounts (checking, savings or cash), not cards or investments');
    scope = [chosen];
  }
  const currencies = new Set(scope.map((a) => a.currency));
  if (currencies.size > 1) {
    throw new BadRequestError('The cash accounts use different currencies: ask for one account (accountId)');
  }
  const scopeIds = new Set(scope.map((a) => a.id));
  const totalBalanceCents = scope.reduce((sum, a) => sum + toCents(a.balance.toNumber()), 0);

  // Savings goals kept inside these accounts: the projection runs on the FREE balance (what the account holds minus what
  // the goals keep), and each goal's planned contribution not yet made this month leaves it on its day.
  const goals =
    scope.length > 0
      ? (await prisma.savingsGoal.findMany({ where: { householdId, accountId: { in: [...scopeIds] } } })).map((g) => planGoalOf(g as unknown as GoalRow))
      : [];
  const allocatedCents = [...allocatedCentsByAccount(goals).values()].reduce((sum, c) => sum + c, 0);
  const startingBalanceCents = totalBalanceCents - allocatedCents;

  const events: CashFlowEventInput[] = [];
  const unassignedInvoices: UnassignedInvoiceInput[] = [];

  if (scope.length > 0) {
    // Employments feeding a salary recurrence set the value of its occurrences and add the 13th, vacation and FGTS
    // birthday events. With none, nothing below differs from a household without payroll.
    const payroll = await loadPayrollLinks(householdId);
    events.push(...(await pendingEvents(householdId, [...scopeIds], endUtc, today)));
    events.push(...(await recurrenceEvents(householdId, [...scopeIds], today, end, payroll)));
    events.push(...payrollEvents(payroll, scopeIds, today, end));
    const invoices = await invoiceEvents(householdId, accounts, scopeIds, today, end);
    events.push(...invoices.events);
    unassignedInvoices.push(...invoices.unassigned);
    events.push(...(await reserveEvents(householdId, goals, today, end)));
  }

  const projection = buildCashFlow({ startingBalanceCents, allocatedCents, today, days, events, unassignedInvoices });
  return { currency: scope[0]?.currency ?? null, ...projection };
}

/**
 * The planned contribution of each savings goal in each month of the period that has none recorded yet, on the goal's
 * contribution day (before today: overdue, the builder moves it to today). The month is "done" once any contribution
 * exists for it, so a contributed month never shows again.
 */
async function reserveEvents(householdId: string, goals: ReturnType<typeof planGoalOf>[], today: string, end: string): Promise<CashFlowEventInput[]> {
  const planned = goals.filter((g) => g.accountId && g.contributionDay !== null);
  if (planned.length === 0) return [];
  const rows = await prisma.savingsGoalContribution.findMany({
    where: { householdId, goalId: { in: planned.map((g) => g.id) }, month: { gte: today.slice(0, 7), lte: end.slice(0, 7) } },
    select: { goalId: true, month: true },
  });
  const doneMonths = new Set(rows.map((r) => `${r.goalId}:${r.month}`));
  return plannedContributions(planned, { today, end, doneMonths }).map((p) => ({
    date: p.date,
    description: `Guardar: ${p.goalName}`,
    amountCents: -p.amountCents,
    source: 'reserve' as const,
    certainty: 'expected' as const,
    overdue: p.date < today,
    sourceId: p.goalId,
    accountId: p.accountId,
  }));
}

/**
 * Pending (unpaid) income and expense entries of the accounts. Dated before today they are due now (overdue, moved to
 * today by the builder). A pending invoice payment dated after today is left out: the invoice calculation ignores a
 * payment dated in the future, so the invoice event already carries that money.
 */
async function pendingEvents(householdId: string, accountIds: string[], endUtc: Date, today: string): Promise<CashFlowEventInput[]> {
  const rows = await prisma.transaction.findMany({
    where: { householdId, paid: false, accountId: { in: accountIds }, type: { in: ['INCOME', 'EXPENSE'] }, date: { lte: endUtc } },
    orderBy: [{ date: 'asc' }, { createdAt: 'asc' }],
  });
  const events: CashFlowEventInput[] = [];
  for (const t of rows) {
    const date = dayString(t.date);
    if (t.attachmentUrl?.startsWith(INVOICE_PAYMENT_PREFIX) && date > today) continue;
    const cents = toCents(t.amount.toNumber());
    events.push({
      date,
      description: t.description?.trim() || t.categoryName || '',
      amountCents: t.type === 'INCOME' ? cents : -cents,
      source: 'pending',
      certainty: 'confirmed',
      overdue: date < today,
      sourceId: t.id,
      accountId: t.accountId!,
    });
  }
  return events;
}

/**
 * Occurrences the recurrences of the accounts have not generated yet, up to the end of the period. The date walk is the
 * one of the invoice forecast (`projectRecurrence`), with an open start: occurrences before today (a stale recurrence
 * the job has not caught up with) all count today, as overdue. A month that already holds a transaction of the
 * recurrence (generated, or adopted from an import) is not counted again.
 */
export async function recurrenceEvents(
  householdId: string,
  accountIds: string[],
  today: string,
  end: string,
  payroll: readonly PayrollLink[] = [],
): Promise<CashFlowEventInput[]> {
  const rows = await prisma.recurringTransaction.findMany({ where: { householdId, isActive: true, accountId: { in: accountIds } } });
  if (rows.length === 0) return [];
  const batch = await forecastBatch(prisma, rows);

  // Transactions of these recurrences from the first month still to walk (the earliest scheduled run) to the end month
  const firstDay = rows.map((r) => dayString(r.nextRunAt)).reduce((min, d) => (d < min ? d : min));
  const from = new Date(Date.UTC(Number(firstDay.slice(0, 4)), Number(firstDay.slice(5, 7)) - 1, 1));
  const until = new Date(Date.UTC(Number(end.slice(0, 4)), Number(end.slice(5, 7)), 1));
  const existing = await prisma.transaction.findMany({
    where: { householdId, recurringTransactionId: { in: rows.map((r) => r.id) }, date: { gte: from, lt: until } },
    select: { recurringTransactionId: true, date: true },
  });
  const generated = new Set<string>();
  for (const t of existing) {
    if (!t.recurringTransactionId) continue;
    const d = dayString(t.date);
    generated.add(`${t.recurringTransactionId}:${d}`);
    generated.add(`${t.recurringTransactionId}:${d.slice(0, 7)}`);
  }

  const fullAmountOn = (r: (typeof rows)[number], day: string): number => batch.expected(r, referenceMonthOf(localDate(day), r.competenceOffsetMonths)).amount;

  const events: CashFlowEventInput[] = [];
  for (const r of rows) {
    const strategy = r.forecastStrategy ?? 'LAST';
    // Estimated: it follows the last value or reads the history; fixed and per-business-day amounts are expected
    const estimated = (r.followLastAmount && strategy === 'LAST') || strategy === 'CONSERVATIVE';
    const rec: ForecastRecurrence = {
      id: r.id,
      description: r.description,
      categoryName: r.categoryName,
      amount: r.amount.toNumber(),
      frequency: r.frequency,
      startDate: r.startDate,
      endDate: r.endDate,
      nextRunAt: r.nextRunAt,
      followLastAmount: estimated,
      // Early-payment discount: until its limit day (from `today` on) the occurrence costs the discounted amount
      amountOn: (day: string) => amountOnDay(fullAmountOn(r, day), earlyDiscountOf(r), day, today),
      sign: 1,
    };
    const sign = batch.isIncome(r) ? 1 : -1;
    const link = payroll.find((l) => l.recurringTransactionId === r.id);
    // A benefit paid per business day linked to this recurrence takes the value calculated for the month it pays
    const benefitOwner = link ? undefined : payroll.find((l) => (l.data.benefits ?? []).some((b) => b.recurringTransactionId === r.id));
    const benefit = benefitOwner?.data.benefits?.find((b) => b.recurringTransactionId === r.id);
    const staleNext = dayString(r.nextRunAt) < today;
    const items = projectRecurrence(rec, { windowStart: '0001-01-01', windowEnd: end }, today, generated);
    items.forEach((item, index) => {
      // A salary recurrence fed by an employment takes the calculated net of the month it pays (raise, month after vacation)
      const calc = link ? salaryPaidInMonth(link.data, item.date.slice(0, 7)) : null;
      const benefitCalc = benefit && benefitOwner ? benefitPaidInMonth(benefitOwner.data, benefit, item.date.slice(0, 7)) : null;
      // What the screens show beside the discounted amount; a salary or benefit calculated value has no discount
      const quote = calc || benefitCalc ? null : earlyDiscountQuoteOf(r, fullAmountOn(r, item.date), item.date, today);
      const earlyDiscount = quote ? { ...quote, recurringId: r.id, occurrenceDate: item.date, canPayNow: item.date === dayString(r.nextRunAt) } : null;
      events.push({
        date: item.date,
        description: item.description,
        amountCents: calc ? calc.netCents : benefitCalc ? benefitCalc.amountCents : sign * toCents(item.amount),
        source: 'recurrence',
        certainty: calc ? (calc.estimated ? 'estimated' : 'expected') : benefitCalc ? 'estimated' : item.followsLastAmount ? 'estimated' : 'expected',
        // Non-monthly stale recurrences are dated today by the walk, but their first run was due earlier
        overdue: item.date < today || (staleNext && index === 0),
        sourceId: r.id,
        accountId: r.accountId,
        ...(earlyDiscount && { earlyDiscount }),
      });
    });
  }
  return events;
}

/**
 * 13th installments, vacations and FGTS birthday withdrawals of the employments linked to an active salary recurrence,
 * from today on (what already happened is not forecast), on the account that receives them (when it is in the set);
 * plus the own events of the per-business-day benefits.
 */
function payrollEvents(links: readonly PayrollLink[], scopeIds: ReadonlySet<string>, today: string, end: string): CashFlowEventInput[] {
  const events: CashFlowEventInput[] = [];
  for (const link of links) {
    const receiving = link.receivingAccountId;
    if (link.recurrenceActive && receiving && scopeIds.has(receiving)) {
      for (const e of extraPayrollEvents(link.data, { from: today, to: end, today })) {
        events.push({
          date: e.date,
          description: e.description,
          amountCents: e.netCents,
          source: 'payroll',
          certainty: e.estimated ? 'estimated' : 'expected',
          overdue: false,
          sourceId: e.employmentId,
          accountId: receiving,
        });
      }
    }
    // Own events of the benefits paid per business day: only the ones that are available money and have no recurrence
    // (a linked one is already the recurrence's occurrence). Destination: the benefit's account, else the employment's.
    for (const b of benefitEvents(link.data, today, end, (x) => !x.recurringTransactionId && x.isAvailableCash)) {
      const accountId = b.accountId ?? link.data.accountId ?? null;
      if (!accountId || !scopeIds.has(accountId) || b.amountCents === 0) continue;
      events.push({
        date: b.paymentDate,
        description: b.name,
        amountCents: b.amountCents,
        source: 'payroll',
        certainty: 'estimated',
        overdue: false,
        sourceId: link.employmentId,
        accountId,
      });
    }
  }
  return events;
}

/**
 * The payment of each card invoice on its due date, from the account that pays it: the card's linked account; else the
 * account the card's latest invoice payment came from; else nobody (listed apart, never in the balance). Cards paid by
 * an account outside the projection are skipped without calculating them.
 */
async function invoiceEvents(
  householdId: string,
  accounts: Array<{ id: string; name: string; type: string; linkedAccountId: string | null }>,
  scopeIds: ReadonlySet<string>,
  today: string,
  end: string,
): Promise<{ events: CashFlowEventInput[]; unassigned: UnassignedInvoiceInput[] }> {
  const cards = accounts.filter((a) => a.type === 'CREDIT');
  const events: CashFlowEventInput[] = [];
  const unassigned: UnassignedInvoiceInput[] = [];
  if (cards.length === 0) return { events, unassigned };

  const cashIds = new Set(accounts.filter((a) => (CASH_TYPES as readonly string[]).includes(a.type)).map((a) => a.id));
  const lastPayerOfCard = await lastPayers(householdId, cards.map((c) => c.id), today);
  const todayDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))));

  // The newest invoice is already closed in the month before today's; the walk ends in the month of the period end
  const firstMonth = addMonthKey(today.slice(0, 7), -1);
  const lastMonth = end.slice(0, 7);

  for (const card of cards) {
    const payer =
      card.linkedAccountId && cashIds.has(card.linkedAccountId)
        ? card.linkedAccountId
        : (lastPayerOfCard.get(card.id) && cashIds.has(lastPayerOfCard.get(card.id)!) ? lastPayerOfCard.get(card.id)! : null);
    if (payer && !scopeIds.has(payer)) continue;

    const walk: Array<{ month: string; data: InvoiceSnapshot }> = [];
    for (let month = firstMonth; month <= lastMonth; month = addMonthKey(month, 1)) {
      const { data } = await calculateCreditCardInvoice(card.id, month, householdId, { limit: 1 }, { today: todayDate });
      walk.push({ month, data });
    }
    for (const result of settleInvoices(walk, today)) {
      if (result.dueDate === null) {
        unassigned.push({ accountId: card.id, accountName: card.name, month: result.month, dueDate: null, amountCents: result.amountCents, reason: 'no_due_date' });
        continue;
      }
      if (result.dueDate > end) continue; // due after the period
      if (!payer) {
        unassigned.push({ accountId: card.id, accountName: card.name, month: result.month, dueDate: result.dueDate, amountCents: result.amountCents, reason: 'no_payer_account' });
        continue;
      }
      events.push({
        date: result.dueDate, // before today: the builder moves it to today and marks it overdue
        description: `Fatura ${card.name}`,
        amountCents: -result.amountCents,
        source: 'invoice',
        certainty: result.certainty,
        overdue: result.overdue,
        sourceId: card.id,
        accountId: payer,
        invoiceMonth: result.month,
      });
    }
  }
  return { events, unassigned };
}

/** Account each card's most recent invoice payment (dated up to today) came out of. */
async function lastPayers(householdId: string, cardIds: string[], today: string): Promise<Map<string, string>> {
  const todayDate = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)) - 1, Number(today.slice(8, 10))));
  const rows = await prisma.transaction.findMany({
    where: {
      householdId,
      OR: cardIds.map((id) => ({ attachmentUrl: { startsWith: `${INVOICE_PAYMENT_PREFIX}${id}:` } })),
      accountId: { not: null },
      date: { lte: todayDate },
    },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
    select: { accountId: true, attachmentUrl: true },
  });
  const result = new Map<string, string>();
  for (const row of rows) {
    const cardId = cardIds.find((id) => row.attachmentUrl?.startsWith(`${INVOICE_PAYMENT_PREFIX}${id}:`));
    if (cardId && !result.has(cardId)) result.set(cardId, row.accountId!);
  }
  return result;
}
