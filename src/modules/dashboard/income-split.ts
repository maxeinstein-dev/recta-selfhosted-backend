/**
 * Where the month's income goes (pure part of GET /dashboard/income-split): the spending of each group, the leftover and
 * the housing share. Everything is added in whole cents, so the groups plus the leftover are the income to the cent.
 */
import { ownAmountCents, type TheirShare } from '../people/own-share.js';
import { storedToCents } from '../people/money.js';
import { OTHER_GROUP_KEY, OTHER_GROUP_NAME } from '../category-groups/category-groups.defaults.js';
import type { GroupRow } from '../category-groups/category-groups.service.js';

/** Housing above this share of the income is the usual warning line. */
export const HOUSING_REFERENCE = 0.3;

/** Which income the split is measured against. Only the expected one for now (see the loader). */
export type IncomeBasis = 'expected';

export interface IncomeSplitInput {
  month: string;
  incomeCents: number;
  groups: readonly GroupRow[];
  /** categoryName -> group id; a name not here (or pointing at a group that is gone) is "Outros". */
  groupOf: ReadonlyMap<string, string>;
  /** Own-share cents spent per categoryName (null = no category) in the month. */
  realizedByCategory: ReadonlyMap<string | null, number>;
  /** Cents still committed in the month per categoryName: expense occurrences not generated yet. */
  committedByCategory: ReadonlyMap<string | null, number>;
}

export interface IncomeSplitGroup {
  /** Group id; null for "Outros". */
  id: string | null;
  /** Group id, or 'OTHER' for "Outros": a stable key for the screen. */
  key: string;
  name: string;
  color: string | null;
  isHousing: boolean;
  sortOrder: number;
  /** Spent so far in the month (own share). */
  realized: number;
  /** Still committed in the month (bills and card recurrences not posted yet). */
  committed: number;
  /** realized + committed: the part of the bar. */
  amount: number;
  /** amount / income, four decimals; null when there is no income. */
  percentOfIncome: number | null;
}

export interface IncomeSplit {
  month: string;
  income: { amount: number; basis: IncomeBasis };
  /** The household's groups in order, then "Outros" (always last, possibly zero). */
  groups: IncomeSplitGroup[];
  /** Sum of the groups. */
  totalSpent: number;
  /** income - totalSpent; negative when the spending passes the income. */
  leftover: { amount: number; percentOfIncome: number | null };
  /** Sum of the groups marked as housing, against the 0.30 reference. */
  housing: { amount: number; percentOfIncome: number | null; reference: number; housingGroups: number };
}

const fromCents = (c: number): number => c / 100;
const shareOf = (cents: number, incomeCents: number): number | null => (incomeCents > 0 ? Math.round((cents / incomeCents) * 10000) / 10000 : null);

/**
 * The single "spending of a group" sum: the own share of each expense (what others owe on it taken off, never below
 * zero), added per category in whole cents. The rows are the ones `budgetSpendingWhere` selects (see the loader).
 */
export function ownCentsByCategory(
  rows: ReadonlyArray<{ id: string; categoryName: string | null; amount: { toNumber(): number } }>,
  theirShares: ReadonlyMap<string, Pick<TheirShare, 'theirCents'>>,
): Map<string | null, number> {
  const out = new Map<string | null, number>();
  for (const row of rows) {
    const cents = ownAmountCents(storedToCents(row.amount), theirShares.get(row.id)?.theirCents ?? 0);
    out.set(row.categoryName, (out.get(row.categoryName) ?? 0) + cents);
  }
  return out;
}

export function buildIncomeSplit(input: IncomeSplitInput): IncomeSplit {
  const known = new Set(input.groups.map((g) => g.id));
  const keyOf = (categoryName: string | null): string => {
    const id = categoryName === null ? undefined : input.groupOf.get(categoryName);
    return id && known.has(id) ? id : OTHER_GROUP_KEY;
  };
  const realized = new Map<string, number>();
  const committed = new Map<string, number>();
  const add = (into: Map<string, number>, from: ReadonlyMap<string | null, number>) => {
    for (const [categoryName, cents] of from) into.set(keyOf(categoryName), (into.get(keyOf(categoryName)) ?? 0) + cents);
  };
  add(realized, input.realizedByCategory);
  add(committed, input.committedByCategory);

  const income = input.incomeCents;
  const lines = [
    ...input.groups.map((g) => ({ id: g.id as string | null, key: g.id, name: g.name, color: g.color, isHousing: g.isHousing, sortOrder: g.sortOrder })),
    { id: null, key: OTHER_GROUP_KEY, name: OTHER_GROUP_NAME, color: null, isHousing: false, sortOrder: input.groups.reduce((max, g) => Math.max(max, g.sortOrder + 1), 0) },
  ];
  let spentCents = 0;
  let housingCents = 0;
  const groups = lines.map((line): IncomeSplitGroup => {
    const r = realized.get(line.key) ?? 0;
    const c = committed.get(line.key) ?? 0;
    spentCents += r + c;
    if (line.isHousing) housingCents += r + c;
    return { ...line, realized: fromCents(r), committed: fromCents(c), amount: fromCents(r + c), percentOfIncome: shareOf(r + c, income) };
  });
  return {
    month: input.month,
    income: { amount: fromCents(income), basis: 'expected' },
    groups,
    totalSpent: fromCents(spentCents),
    leftover: { amount: fromCents(income - spentCents), percentOfIncome: shareOf(income - spentCents, income) },
    housing: {
      amount: fromCents(housingCents),
      percentOfIncome: shareOf(housingCents, income),
      reference: HOUSING_REFERENCE,
      housingGroups: input.groups.filter((g) => g.isHousing).length,
    },
  };
}
