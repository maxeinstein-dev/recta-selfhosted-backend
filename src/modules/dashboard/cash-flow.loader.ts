import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { addMonthKey } from '../transactions/credit-card-commitment.js';
import { projectRecurrence, toCents, type ForecastRecurrence, type InvoiceState } from '../transactions/credit-card-invoice-forecast.js';
import { calculateCreditCardInvoice, utcToday } from '../transactions/transactions.service.js';
import { dayString, localDate } from '../recurring-transactions/recurring-dates.js';
import { forecastBatch, referenceMonthOf } from '../recurring-transactions/recurring-forecast.js';
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

export interface InvoiceEventResult {
  /** Whole cents still to leave the payer account for this invoice; never positive-zero (null = no event). */
  amountCents: number;
  certainty: 'confirmed' | 'estimated';
  /** Day the payment is due; null when the card has no due day. */
  dueDate: string | null;
}

/**
 * What one invoice takes out of the payer account, or null when it takes nothing:
 * - a paid invoice, an invoice with credit (refunds above purchases) and a one-cent residue generate no event;
 * - closed: what is posted still owed (the debt the invoice route shows for it);
 * - open or future: posted plus what the recurrences will still add before closing, minus what was already paid;
 * - only the FIRST invoice walked carries `outstandingFromPrevious` (debt of older invoices that no later call covers);
 *   the later ones would count it a second time, since the walk gives each of them its own event.
 */
export function invoiceEventOf(data: InvoiceSnapshot, isFirst: boolean): InvoiceEventResult | null {
  if (data.state === 'paid') return null;
  const forecastCents = data.state === 'open' && data.forecast.applicable ? toCents(data.forecast.total) : 0;
  const carriedCents = isFirst ? toCents(data.outstandingFromPrevious) : 0;
  const amountCents = carriedCents + toCents(data.statementTotal) + forecastCents - toCents(data.currentPayments);
  // One-cent residues of summed decimals are not a debt (same rule as the invoice route)
  if (amountCents <= 1) return null;
  return { amountCents, certainty: data.state === 'open' ? 'estimated' : 'confirmed', dueDate: data.dueDate };
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
  const startingBalanceCents = scope.reduce((sum, a) => sum + toCents(a.balance.toNumber()), 0);

  const events: CashFlowEventInput[] = [];
  const unassignedInvoices: UnassignedInvoiceInput[] = [];

  if (scope.length > 0) {
    events.push(...(await pendingEvents(householdId, [...scopeIds], endUtc, today)));
    events.push(...(await recurrenceEvents(householdId, [...scopeIds], today, end)));
    const invoices = await invoiceEvents(householdId, accounts, scopeIds, today, end);
    events.push(...invoices.events);
    unassignedInvoices.push(...invoices.unassigned);
  }

  const projection = buildCashFlow({ startingBalanceCents, today, days, events, unassignedInvoices });
  return { currency: scope[0]?.currency ?? null, ...projection };
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
async function recurrenceEvents(householdId: string, accountIds: string[], today: string, end: string): Promise<CashFlowEventInput[]> {
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
      amountOn: (day: string) => batch.expected(r, referenceMonthOf(localDate(day), r.competenceOffsetMonths)).amount,
      sign: 1,
    };
    const sign = batch.isIncome(r) ? 1 : -1;
    const staleNext = dayString(r.nextRunAt) < today;
    const items = projectRecurrence(rec, { windowStart: '0001-01-01', windowEnd: end }, today, generated);
    items.forEach((item, index) => {
      events.push({
        date: item.date,
        description: item.description,
        amountCents: sign * toCents(item.amount),
        source: 'recurrence',
        certainty: item.followsLastAmount ? 'estimated' : 'expected',
        // Non-monthly stale recurrences are dated today by the walk, but their first run was due earlier
        overdue: item.date < today || (staleNext && index === 0),
        sourceId: r.id,
        accountId: r.accountId,
      });
    });
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

    for (let month = firstMonth, first = true; month <= lastMonth; month = addMonthKey(month, 1), first = false) {
      const { data } = await calculateCreditCardInvoice(card.id, month, householdId, { limit: 1 }, { today: todayDate });
      const result = invoiceEventOf(data, first);
      if (!result) continue;
      if (result.dueDate === null) {
        unassigned.push({ accountId: card.id, accountName: card.name, month, dueDate: null, amountCents: result.amountCents, reason: 'no_due_date' });
        continue;
      }
      if (result.dueDate > end) continue; // due after the period
      if (!payer) {
        unassigned.push({ accountId: card.id, accountName: card.name, month, dueDate: result.dueDate, amountCents: result.amountCents, reason: 'no_payer_account' });
        continue;
      }
      events.push({
        date: result.dueDate, // before today: the builder moves it to today and marks it overdue
        description: `Fatura ${card.name}`,
        amountCents: -result.amountCents,
        source: 'invoice',
        certainty: result.certainty,
        overdue: result.dueDate < today,
        sourceId: card.id,
        accountId: payer,
        invoiceMonth: month,
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
