/**
 * Net worth by month: what the household has (cash accounts, investments, reserves, FGTS) minus what it owes on the
 * cards. Pure: no database, no clock (`today` is an argument). Money in whole cents. The loader (net-worth.loader.ts)
 * reads the database and hands the rows to `buildNetWorth`.
 *
 * The rules, so the screen and the tests say the same thing:
 * - Cash accounts: the balance of each account today, walked back through the paid entries dated after the month end
 *   (`balanceAt`). The current month is the balance as it is today. A reserve kept inside an account is already in the
 *   account balance, so reserves are NOT an extra part unless they live outside the accounts (see `reservesByMonth`).
 * - Investments: the latest market value informed up to the month end plus the net contributions after that day; a
 *   month before any value falls back to what was put in (the account balance then) and is flagged as an estimate.
 * - FGTS: the estimated accumulated balance at the month end (informed balance + calculated deposits - withdrawals),
 *   always an estimate.
 * - Cards: net purchases minus invoice payments up to the month end (today for the current month), never below zero
 *   for a card. The same sum the invoice uses for what is carried from one invoice to the next.
 * - Savings: realized income and expense of the month (paid entries; transfers, card invoice payments and balance
 *   adjustments are not income or expense). The surplus is income - expense; what went to investments is shown apart.
 */

export interface Effect {
  /** 'YYYY-MM-DD' */
  date: string;
  /** Signed effect on the account balance (or on the card debt), in cents. */
  cents: number;
}

export interface CashAccountInput {
  id: string;
  name: string;
  balanceCents: number;
  /** Paid entries of the account, from the earliest month shown on. */
  effects: readonly Effect[];
}

export interface InvestmentAccountInput extends CashAccountInput {
  /** Market values informed by the user, on their dates. */
  valuations: readonly Effect[];
}

export interface CardInput {
  id: string;
  name: string;
  /** Debt stored on the card; only used when the card has no entry at all. */
  balanceCents: number;
  /** Net purchases: an expense raises the debt, a refund lowers it. */
  purchases: readonly Effect[];
  /** Invoice payments (positive cents). */
  payments: readonly Effect[];
}

export interface FgtsInput {
  id: string;
  name: string;
  /** Estimated accumulated balance at the end of each month; a missing month counts as zero. */
  byMonth: ReadonlyMap<string, number>;
}

export interface MonthFlows {
  incomeCents: number;
  expenseCents: number;
  /** Net transfers into investment accounts in the month (a withdrawal is negative). */
  contributedCents: number;
}

export interface NetWorthInput {
  /** 'YYYY-MM', oldest first, the last one is the current month. */
  months: readonly string[];
  /** 'YYYY-MM-DD' */
  today: string;
  cashAccounts: readonly CashAccountInput[];
  investmentAccounts: readonly InvestmentAccountInput[];
  cards: readonly CardInput[];
  fgts: readonly FgtsInput[];
  /**
   * Extension point for the reserves (savings goals / piggy banks) that live OUTSIDE the accounts: cents by month. A
   * reserve kept inside an account is already in the account balance and must not be put here.
   */
  reservesByMonth: ReadonlyMap<string, number>;
  flows: ReadonlyMap<string, MonthFlows>;
}

export interface NetWorthMonth {
  month: string;
  cashCents: number;
  investmentsCents: number;
  reservesCents: number;
  fgtsCents: number;
  cardDebtCents: number;
  totalCents: number;
  savings: { incomeCents: number; expenseCents: number; surplusCents: number; contributedCents: number; rate: number | null };
}

export interface CompositionItem {
  kind: 'cash' | 'investment' | 'reserve' | 'fgts' | 'card';
  id: string;
  name: string;
  /** Signed: a card is negative. */
  cents: number;
  estimated: boolean;
  /** Investments: the date of the market value in use; null when there is none. */
  valuationDate?: string | null;
}

export interface NetWorth {
  months: NetWorthMonth[];
  /** The pieces of the last month; they add up to its total. */
  composition: CompositionItem[];
}

const pad = (n: number): string => String(n).padStart(2, '0');

export function lastDayOfMonth(month: string): string {
  const [y, m] = month.split('-').map(Number) as [number, number];
  return `${month}-${pad(new Date(Date.UTC(y, m, 0)).getUTCDate())}`;
}

/** The `count` months ending at `lastMonth` (included), oldest first. */
export function monthsEndingAt(lastMonth: string, count: number): string[] {
  const [y, m] = lastMonth.split('-').map(Number) as [number, number];
  const out: string[] = [];
  for (let i = count - 1; i >= 0; i--) {
    const d = new Date(Date.UTC(y, m - 1 - i, 1));
    out.push(`${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}`);
  }
  return out;
}

const sum = (list: readonly Effect[], keep: (e: Effect) => boolean): number => list.reduce((s, e) => (keep(e) ? s + e.cents : s), 0);

const isCurrentOrLater = (month: string, today: string): boolean => month >= today.slice(0, 7);

/** Balance at the end of `month`: today's balance minus what moved after that day. The current month is today's balance. */
export function balanceAt(balanceCents: number, effects: readonly Effect[], month: string, today: string): number {
  if (isCurrentOrLater(month, today)) return balanceCents;
  const end = lastDayOfMonth(month);
  return balanceCents - sum(effects, (e) => e.date > end);
}

export interface InvestmentValue {
  cents: number;
  source: 'valuation' | 'contributions';
  valuationDate: string | null;
}

export function investmentAt(account: InvestmentAccountInput, month: string, today: string): InvestmentValue {
  const end = isCurrentOrLater(month, today) ? today : lastDayOfMonth(month);
  let latest: Effect | null = null;
  for (const v of account.valuations) {
    if (v.date <= end && (!latest || v.date > latest.date)) latest = v;
  }
  if (!latest) {
    return { cents: balanceAt(account.balanceCents, account.effects, month, today), source: 'contributions', valuationDate: null };
  }
  const after = sum(account.effects, (e) => e.date > latest!.date && e.date <= end);
  return { cents: latest.cents + after, source: 'valuation', valuationDate: latest.date };
}

/** Debt of one card at the end of `month` (today for the current month). */
export function cardDebtAt(card: CardInput, month: string, today: string): number {
  if (card.purchases.length === 0 && card.payments.length === 0) return Math.max(0, card.balanceCents);
  const end = isCurrentOrLater(month, today) ? today : lastDayOfMonth(month);
  const debt = sum(card.purchases, (e) => e.date <= end) - sum(card.payments, (e) => e.date <= end);
  return Math.max(0, debt);
}

const rateOf = (income: number, surplus: number): number | null => (income > 0 ? Math.round((surplus / income) * 10_000) / 10_000 : null);

const reais = (cents: number): number => cents / 100;

export interface NetWorthResponse {
  currency: 'BRL';
  /** Income of the savings figures is the realized one (paid entries of the month), not the expected one. */
  incomeBasis: 'realized';
  months: Array<{
    month: string;
    cash: number;
    investments: number;
    reserves: number;
    fgts: number;
    cardDebt: number;
    total: number;
    savings: { income: number; expense: number; surplus: number; contributed: number; rate: number | null };
  }>;
  composition: Array<{ kind: CompositionItem['kind']; id: string; name: string; amount: number; estimated: boolean; valuationDate: string | null }>;
}

/** The API shape: reais instead of cents. */
export function toNetWorthResponse(netWorth: NetWorth): NetWorthResponse {
  return {
    currency: 'BRL',
    incomeBasis: 'realized',
    months: netWorth.months.map((m) => ({
      month: m.month,
      cash: reais(m.cashCents),
      investments: reais(m.investmentsCents),
      reserves: reais(m.reservesCents),
      fgts: reais(m.fgtsCents),
      cardDebt: reais(m.cardDebtCents),
      total: reais(m.totalCents),
      savings: {
        income: reais(m.savings.incomeCents),
        expense: reais(m.savings.expenseCents),
        surplus: reais(m.savings.surplusCents),
        contributed: reais(m.savings.contributedCents),
        rate: m.savings.rate,
      },
    })),
    composition: netWorth.composition.map((c) => ({
      kind: c.kind,
      id: c.id,
      name: c.name,
      amount: reais(c.cents),
      estimated: c.estimated,
      valuationDate: c.valuationDate ?? null,
    })),
  };
}

export function buildNetWorth(input: NetWorthInput): NetWorth {
  const { months, today } = input;
  const result: NetWorthMonth[] = months.map((month) => {
    const cashCents = input.cashAccounts.reduce((s, a) => s + balanceAt(a.balanceCents, a.effects, month, today), 0);
    const investmentsCents = input.investmentAccounts.reduce((s, a) => s + investmentAt(a, month, today).cents, 0);
    const fgtsCents = input.fgts.reduce((s, f) => s + (f.byMonth.get(month) ?? 0), 0);
    const cardDebtCents = input.cards.reduce((s, c) => s + cardDebtAt(c, month, today), 0);
    const reservesCents = input.reservesByMonth.get(month) ?? 0;
    const flows = input.flows.get(month) ?? { incomeCents: 0, expenseCents: 0, contributedCents: 0 };
    const surplusCents = flows.incomeCents - flows.expenseCents;
    return {
      month,
      cashCents,
      investmentsCents,
      reservesCents,
      fgtsCents,
      cardDebtCents,
      totalCents: cashCents + investmentsCents + reservesCents + fgtsCents - cardDebtCents,
      savings: {
        incomeCents: flows.incomeCents,
        expenseCents: flows.expenseCents,
        surplusCents,
        contributedCents: flows.contributedCents,
        rate: rateOf(flows.incomeCents, surplusCents),
      },
    };
  });

  const last = months[months.length - 1];
  const composition: CompositionItem[] = [];
  if (last) {
    for (const a of input.cashAccounts) {
      composition.push({ kind: 'cash', id: a.id, name: a.name, cents: balanceAt(a.balanceCents, a.effects, last, today), estimated: false });
    }
    for (const a of input.investmentAccounts) {
      const v = investmentAt(a, last, today);
      composition.push({ kind: 'investment', id: a.id, name: a.name, cents: v.cents, estimated: v.source === 'contributions', valuationDate: v.valuationDate });
    }
    const reserves = input.reservesByMonth.get(last) ?? 0;
    if (reserves !== 0) composition.push({ kind: 'reserve', id: 'reserves', name: 'Reservas', cents: reserves, estimated: false });
    for (const f of input.fgts) {
      composition.push({ kind: 'fgts', id: f.id, name: f.name, cents: f.byMonth.get(last) ?? 0, estimated: true });
    }
    for (const c of input.cards) {
      composition.push({ kind: 'card', id: c.id, name: c.name, cents: -cardDebtAt(c, last, today), estimated: false });
    }
  }
  return { months: result, composition };
}
