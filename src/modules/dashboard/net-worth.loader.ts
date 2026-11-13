import { prisma } from '../../shared/db/prisma.js';
import { AccountType, TransactionType } from '../../shared/enums/index.js';
import { INVOICE_PAYMENT_PREFIX } from '../budgets/budget-spending.js';
import { dayString } from '../recurring-transactions/recurring-dates.js';
import { buildFgtsForecast } from '../payroll/payroll-events.js';
import { employmentInclude, toEmploymentData } from '../payroll/payroll.links.js';
import { utcToday } from '../transactions/transactions.service.js';
import {
  buildNetWorth,
  lastDayOfMonth,
  monthsEndingAt,
  toNetWorthResponse,
  type CardInput,
  type CashAccountInput,
  type Effect,
  type FgtsInput,
  type InvestmentAccountInput,
  type MonthFlows,
  type NetWorthResponse,
} from './net-worth.js';

/** Opening-balance and manual-adjustment entries (see accounts.service adjustBalance): not income or expense of the month. */
const ADJUSTMENT_NOTE_PREFIX = 'Previous balance:';

const cents = (d: { toNumber(): number }): number => Math.round(d.toNumber() * 100);

/**
 * Extension point for the reserves (savings goals) that live outside the accounts: cents by month. Nothing is
 * registered yet, so reserves count as zero. A reserve kept inside an account is already in the balance of that account.
 */
export type ReservesProvider = (householdId: string, months: readonly string[]) => Promise<ReadonlyMap<string, number>>;
export const noReserves: ReservesProvider = async () => new Map();

export interface NetWorthParams {
  householdId: string;
  months: number;
  today?: Date;
  reserves?: ReservesProvider;
}

interface Row {
  type: string;
  amount: { toNumber(): number };
  date: Date;
  accountId: string | null;
  fromAccountId: string | null;
  toAccountId: string | null;
  attachmentUrl: string | null;
  notes: string | null;
  categoryName: string | null;
}

/** Signed effect of a paid row on the balance of `accountId` (null when it does not touch that account). */
export function effectOn(row: Row, accountId: string): number | null {
  const amount = cents(row.amount);
  if (row.type === TransactionType.INCOME) return row.accountId === accountId ? amount : null;
  if (row.type === TransactionType.EXPENSE) return row.accountId === accountId ? -amount : null;
  if (row.type === TransactionType.TRANSFER) {
    // Two stored shapes: one row per side (accountId set, signed amount), or one row with from and to (positive amount).
    if (row.accountId) return row.accountId === accountId ? amount : null;
    if (row.fromAccountId === accountId) return -amount;
    if (row.toAccountId === accountId) return amount;
  }
  return null;
}

export async function loadNetWorth(params: NetWorthParams): Promise<NetWorthResponse> {
  const { householdId } = params;
  const today = dayString(params.today ?? utcToday());
  const months = monthsEndingAt(today.slice(0, 7), params.months);
  const first = months[0]!;
  const last = months[months.length - 1]!;

  const accounts = await prisma.account.findMany({
    where: { householdId, isActive: true },
    select: { id: true, name: true, type: true, balance: true },
    orderBy: { createdAt: 'asc' },
  });
  const cash = accounts.filter((a) => a.type === AccountType.CHECKING || a.type === AccountType.SAVINGS || a.type === AccountType.CASH);
  const invest = accounts.filter((a) => a.type === AccountType.INVESTMENT);
  const cards = accounts.filter((a) => a.type === AccountType.CREDIT);
  const balanceIds = [...cash, ...invest].map((a) => a.id);
  const cardIds = cards.map((a) => a.id);

  const valuationRows = invest.length
    ? await prisma.accountValuation.findMany({ where: { accountId: { in: invest.map((a) => a.id) } }, orderBy: { date: 'asc' } })
    : [];
  const valuationsOf = (id: string): Effect[] =>
    valuationRows.filter((v) => v.accountId === id).map((v) => ({ date: dayString(v.date), cents: cents(v.amount) }));

  // Entries that moved the balances after the first month end; investments also need what came after their old values.
  const earliestValuation = valuationRows[0] ? dayString(valuationRows[0].date) : lastDayOfMonth(first);
  const threshold = earliestValuation < lastDayOfMonth(first) ? earliestValuation : lastDayOfMonth(first);
  const thresholdDate = new Date(`${threshold}T00:00:00.000Z`);

  const movedRows: Row[] = balanceIds.length
    ? await prisma.transaction.findMany({
        where: {
          householdId,
          paid: true,
          date: { gt: thresholdDate },
          type: { in: [TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER] },
          OR: [{ accountId: { in: balanceIds } }, { fromAccountId: { in: balanceIds } }, { toAccountId: { in: balanceIds } }],
        },
        select: { type: true, amount: true, date: true, accountId: true, fromAccountId: true, toAccountId: true, attachmentUrl: true, notes: true, categoryName: true },
      })
    : [];
  const effectsOf = (id: string): Effect[] => {
    const out: Effect[] = [];
    for (const r of movedRows) {
      const c = effectOn(r, id);
      if (c !== null) out.push({ date: dayString(r.date), cents: c });
    }
    return out;
  };

  const cashAccounts: CashAccountInput[] = cash.map((a) => ({ id: a.id, name: a.name, balanceCents: cents(a.balance), effects: effectsOf(a.id) }));
  const investmentAccounts: InvestmentAccountInput[] = invest.map((a) => ({
    id: a.id,
    name: a.name,
    balanceCents: cents(a.balance),
    effects: effectsOf(a.id),
    valuations: valuationsOf(a.id),
  }));

  // Cards: the same sums the invoice uses for what it carries (net purchases without the tagged rows, minus the tagged payments).
  const cardRows = cardIds.length
    ? await prisma.transaction.findMany({
        where: { householdId, accountId: { in: cardIds }, attachmentUrl: null, categoryName: { not: null } },
        select: { type: true, amount: true, date: true, accountId: true },
      })
    : [];
  const paymentRows = cardIds.length
    ? await prisma.transaction.findMany({
        where: { householdId, OR: cardIds.map((id) => ({ attachmentUrl: { startsWith: `${INVOICE_PAYMENT_PREFIX}${id}:` } })) },
        select: { amount: true, date: true, attachmentUrl: true },
      })
    : [];
  const cardInputs: CardInput[] = cards.map((c) => ({
    id: c.id,
    name: c.name,
    balanceCents: cents(c.balance),
    purchases: cardRows
      .filter((r) => r.accountId === c.id)
      .map((r) => ({ date: dayString(r.date), cents: r.type === TransactionType.INCOME ? -cents(r.amount) : cents(r.amount) })),
    payments: paymentRows
      .filter((r) => r.attachmentUrl?.startsWith(`${INVOICE_PAYMENT_PREFIX}${c.id}:`))
      .map((r) => ({ date: dayString(r.date), cents: cents(r.amount) })),
  }));

  // FGTS: every active CLT employment of the household, by the same forecast the Income area shows.
  const employments = await prisma.employment.findMany({
    where: { householdId, isActive: true, regime: 'CLT' },
    include: employmentInclude,
    orderBy: { createdAt: 'asc' },
  });
  const fgts: FgtsInput[] = employments.map((row) => {
    const forecast = buildFgtsForecast(toEmploymentData(row), first, last, today);
    return { id: row.id, name: row.employer, byMonth: new Map(forecast.months.map((m) => [m.month, m.accumulatedCents])) };
  });

  // Realized income and expense of each month, and what went into the investment accounts.
  const flows = new Map<string, MonthFlows>();
  const flowOf = (month: string): MonthFlows => {
    let f = flows.get(month);
    if (!f) flows.set(month, (f = { incomeCents: 0, expenseCents: 0, contributedCents: 0 }));
    return f;
  };
  const windowStart = new Date(`${first}-01T00:00:00.000Z`);
  const windowEnd = new Date(`${lastDayOfMonth(last)}T00:00:00.000Z`);
  const flowRows = await prisma.transaction.findMany({
    where: {
      householdId,
      paid: true,
      date: { gte: windowStart, lte: windowEnd },
      type: { in: [TransactionType.INCOME, TransactionType.EXPENSE, TransactionType.TRANSFER] },
    },
    select: { type: true, amount: true, date: true, accountId: true, fromAccountId: true, toAccountId: true, attachmentUrl: true, notes: true, categoryName: true },
  });
  const investIds = new Set(invest.map((a) => a.id));
  for (const r of flowRows) {
    const month = dayString(r.date).slice(0, 7);
    if (r.type === TransactionType.TRANSFER) {
      for (const id of investIds) {
        const c = effectOn(r, id);
        if (c !== null) flowOf(month).contributedCents += c;
      }
      continue;
    }
    if (r.attachmentUrl?.startsWith(INVOICE_PAYMENT_PREFIX)) continue; // the purchases already count on their own dates
    if (r.notes?.startsWith(ADJUSTMENT_NOTE_PREFIX)) continue; // a balance adjustment is not income or expense
    if (r.type === TransactionType.INCOME) flowOf(month).incomeCents += cents(r.amount);
    else flowOf(month).expenseCents += cents(r.amount);
  }

  const reservesByMonth = await (params.reserves ?? noReserves)(householdId, months);

  return toNetWorthResponse(
    buildNetWorth({ months, today, cashAccounts, investmentAccounts, cards: cardInputs, fgts, reservesByMonth, flows }),
  );
}
