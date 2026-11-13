import { prisma } from '../../shared/db/prisma.js';
import { TransactionType } from '../../shared/enums/index.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { effectiveMonthWhere } from '../../shared/utils/competence.js';
import { effectiveClosingDay } from '../accounts/closing-day.js';
import { listReviewQueue } from '../transactions/card-ofx-review.service.js';
import type { ResolvedCardAccount } from '../transactions/card-ofx-import.service.js';
import { calculateCreditCardInvoice, utcToday } from '../transactions/transactions.service.js';

/**
 * Month close: for one month, what still stops it from being "conferred". Read only; nothing here fixes anything.
 * - cash accounts: the balance the system had on the last day of the month, and the unpaid entries of the month;
 * - cards: the invoice of the month (total, state) and the rows still without a bank line (the review queue);
 * - household: rows without a category and bank notifications still waiting for a decision.
 * Every block carries `ok` and the list of what prevents it. The invoice and the review queue are the existing
 * functions; the month rule is the reference month (`effectiveMonthWhere`), like the rest of the planning.
 */

/** Account types the household's money sits in (same set as the cash flow projection). */
const CASH_TYPES = ['CHECKING', 'SAVINGS', 'CASH'];
const MONEY_TYPES = [TransactionType.INCOME, TransactionType.EXPENSE];

export interface MonthCloseBlocker {
  code: 'pending_entries' | 'invoice_open' | 'review_queue' | 'uncategorized' | 'pending_captures';
  count: number;
  /** Sum of the rows, when the blocker is made of rows with an amount. */
  amount?: number;
}

/** The user's conference of one account for the month (see `MonthClosing` in the schema). */
export interface MonthCloseConference {
  informedBalance: number;
  /** What the system computed when the conference was recorded. */
  systemBalance: number;
  /** informed - system, in cents precision. */
  difference: number;
  closedAt: string;
  closedByUserId: string | null;
  /** True when the system figure is no longer the recorded one, or an entry of the month was touched after it. */
  changedSince: boolean;
}

export interface MonthCloseAccount {
  accountId: string;
  name: string;
  type: string;
  /** Cash the account held at the end of the last day of the month (available + allocated). */
  systemBalance: number;
  ok: boolean;
  blockers: MonthCloseBlocker[];
  closing: MonthCloseConference | null;
}

export interface MonthCloseCard {
  accountId: string;
  name: string;
  /** What the bank charges on this invoice (posted statement total). */
  invoiceTotal: number;
  state: 'open' | 'closed' | 'paid';
  reviewQueueCount: number;
  ok: boolean;
  blockers: MonthCloseBlocker[];
  closing: MonthCloseConference | null;
}

export interface MonthClose {
  month: string;
  accounts: MonthCloseAccount[];
  cards: MonthCloseCard[];
  general: { ok: boolean; blockers: MonthCloseBlocker[] };
  ok: boolean;
}

const cents = (n: number) => Math.round(n * 100);

/** First day of the month after `month`, as a UTC-midnight date. */
function nextMonthStart(month: string): Date {
  return new Date(Date.UTC(Number(month.slice(0, 4)), Number(month.slice(5, 7)), 1));
}

export async function loadMonthClose(params: { householdId: string; month: string; today?: Date }): Promise<MonthClose> {
  const { householdId, month } = params;
  const today = params.today ?? utcToday();
  const after = nextMonthStart(month);

  const all = await prisma.account.findMany({ where: { householdId, isActive: true } });
  const cash = all.filter((a) => CASH_TYPES.includes(a.type));
  const cards = all.filter((a) => a.type === 'CREDIT');
  const cashIds = new Set(cash.map((a) => a.id));
  const cardIds = new Set(cards.map((a) => a.id));

  // Balance on the last day: the cash the account holds today (available + allocated; `totalBalance` is left stale by a
  // transfer until the next ordinary entry, so it is not used), walked back over what moved cash after the month:
  // paid income and expenses and transfers in or out. Allocations only move cash between available and allocated.
  const later = cash.length === 0 ? [] : await prisma.transaction.findMany({
    where: { householdId, accountId: { in: [...cashIds] }, type: { in: MONEY_TYPES }, paid: true, date: { gte: after } },
    select: { accountId: true, type: true, amount: true },
  });
  const transfers = cash.length === 0 ? [] : await prisma.transaction.findMany({
    where: { householdId, type: TransactionType.TRANSFER, date: { gte: after }, OR: [{ fromAccountId: { in: [...cashIds] } }, { toAccountId: { in: [...cashIds] } }] },
    select: { fromAccountId: true, toAccountId: true, amount: true },
  });
  const undoCents = new Map<string, number>(); // cents the account gained after the month
  const gained = (id: string | null, c: number) => {
    if (id && cashIds.has(id)) undoCents.set(id, (undoCents.get(id) ?? 0) + c);
  };
  for (const t of later) gained(t.accountId, (t.type === TransactionType.INCOME ? 1 : -1) * cents(t.amount.toNumber()));
  for (const t of transfers) {
    gained(t.fromAccountId, -cents(t.amount.toNumber()));
    gained(t.toAccountId, cents(t.amount.toNumber()));
  }

  const pending = await prisma.transaction.findMany({
    where: { householdId, paid: false, type: { in: MONEY_TYPES }, AND: [effectiveMonthWhere(month)] },
    select: { accountId: true, amount: true },
  });
  const pendingBy = new Map<string, { count: number; cents: number }>();
  const pendingOther = { count: 0, cents: 0 };
  for (const t of pending) {
    if (t.accountId && cardIds.has(t.accountId)) continue; // card purchases are paid with the invoice
    const slot = t.accountId && cashIds.has(t.accountId) ? (pendingBy.get(t.accountId) ?? pendingBy.set(t.accountId, { count: 0, cents: 0 }).get(t.accountId)!) : pendingOther;
    slot.count += 1;
    slot.cents += cents(t.amount.toNumber());
  }
  const pendingBlocker = (s: { count: number; cents: number }): MonthCloseBlocker[] =>
    s.count > 0 ? [{ code: 'pending_entries', count: s.count, amount: s.cents / 100 }] : [];

  const accounts: MonthCloseAccount[] = cash.map((a) => {
    const blockers = pendingBlocker(pendingBy.get(a.id) ?? { count: 0, cents: 0 });
    return {
      accountId: a.id,
      name: a.name,
      type: a.type,
      systemBalance: (cents(a.availableBalance.toNumber()) + cents(a.allocatedBalance.toNumber()) - (undoCents.get(a.id) ?? 0)) / 100,
      ok: blockers.length === 0,
      blockers,
      closing: null,
    };
  });

  const cardBlocks: MonthCloseCard[] = [];
  for (const card of cards) {
    const resolved: ResolvedCardAccount = {
      id: card.id,
      name: card.name,
      type: card.type as ResolvedCardAccount['type'],
      householdId,
      dueDay: card.dueDay ?? null,
      closingDay: effectiveClosingDay(card),
    };
    const invoice = (await calculateCreditCardInvoice(card.id, month, householdId, { limit: 1 }, { today })).data;
    const queue = await listReviewQueue({ account: resolved, monthKey: month, limit: 1 });
    const blockers: MonthCloseBlocker[] = [];
    if (invoice.state === 'open') blockers.push({ code: 'invoice_open', count: 1 });
    if (queue.totals.count > 0) blockers.push({ code: 'review_queue', count: queue.totals.count });
    cardBlocks.push({
      accountId: card.id,
      name: card.name,
      invoiceTotal: invoice.statementTotal,
      state: invoice.state,
      reviewQueueCount: queue.totals.count,
      ok: blockers.length === 0,
      blockers,
      closing: null,
    });
  }

  const uncategorized = await prisma.transaction.findMany({
    where: { householdId, categoryName: null, type: { in: MONEY_TYPES }, AND: [effectiveMonthWhere(month)] },
    select: { id: true },
  });
  const captures = await prisma.capturedNotification.count({ where: { householdId, status: 'PENDING', postedAt: { lt: after } } });

  const general: MonthClose['general']['blockers'] = [...pendingBlocker(pendingOther)];
  if (uncategorized.length > 0) general.push({ code: 'uncategorized', count: uncategorized.length });
  if (captures > 0) general.push({ code: 'pending_captures', count: captures });

  // Conferences recorded for this month, and whether anything moved since each one
  const closings = await prisma.monthClosing.findMany({ where: { householdId, month } });
  if (closings.length > 0) {
    const minClosedAt = new Date(Math.min(...closings.map((c) => c.closedAt.getTime())));
    const touched = await prisma.transaction.findMany({
      where: { householdId, accountId: { in: closings.map((c) => c.accountId) }, updatedAt: { gt: minClosedAt }, AND: [effectiveMonthWhere(month)] },
      select: { accountId: true, updatedAt: true },
    });
    const conferenceOf = (accountId: string, currentSystem: number): MonthCloseConference | null => {
      const c = closings.find((row) => row.accountId === accountId);
      if (!c) return null;
      const recorded = c.systemBalance.toNumber();
      const touchedAfter = touched.some((t) => t.accountId === accountId && t.updatedAt.getTime() > c.closedAt.getTime());
      return {
        informedBalance: c.informedBalance.toNumber(),
        systemBalance: recorded,
        difference: c.difference.toNumber(),
        closedAt: c.closedAt.toISOString(),
        closedByUserId: c.closedByUserId,
        changedSince: cents(currentSystem) !== cents(recorded) || touchedAfter,
      };
    };
    for (const a of accounts) a.closing = conferenceOf(a.accountId, a.systemBalance);
    for (const c of cardBlocks) c.closing = conferenceOf(c.accountId, c.invoiceTotal);
  }

  const generalOk = general.length === 0;
  return {
    month,
    accounts,
    cards: cardBlocks,
    general: { ok: generalOk, blockers: general },
    ok: generalOk && accounts.every((a) => a.ok) && cardBlocks.every((c) => c.ok),
  };
}

/**
 * Records the conference of one account (or card) for a month: what the statement says, what the system computes now,
 * and the difference. The system figure is computed here, never taken from the request. Conferring again replaces the
 * record (one per household, month and account); nothing of the month is locked or edited.
 */
export async function saveMonthClosing(params: { householdId: string; month: string; accountId: string; informedBalance: number; userId: string | null }) {
  const { householdId, month, accountId, userId } = params;
  const close = await loadMonthClose({ householdId, month });
  const system = close.accounts.find((a) => a.accountId === accountId)?.systemBalance ?? close.cards.find((c) => c.accountId === accountId)?.invoiceTotal;
  if (system === undefined) throw new NotFoundError('Account');

  const informedCents = cents(params.informedBalance);
  const data = {
    informedBalance: informedCents / 100,
    systemBalance: system,
    difference: (informedCents - cents(system)) / 100,
    closedByUserId: userId,
    closedAt: new Date(),
  };
  await prisma.monthClosing.upsert({
    where: { householdId_month_accountId: { householdId, month, accountId } },
    create: { householdId, month, accountId, ...data },
    update: data,
  });
  return { month, accountId, informedBalance: data.informedBalance, systemBalance: data.systemBalance, difference: data.difference, closedAt: data.closedAt.toISOString() };
}
