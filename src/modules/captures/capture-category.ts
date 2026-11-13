import { CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { normalizeDescription } from '../recurring-transactions/detect.js';

/**
 * Category hint of a capture: the household's own history is the rule. A recurrence that names the place (its
 * description or one of its aliases) wins; else the latest transaction of the same type whose normalized description
 * equals the normalized place. No table, no scoring: fixing the category of a transaction fixes the next hint.
 */

export type HintType = 'INCOME' | 'EXPENSE';
export type CategorySource = 'history' | 'recurrence';

export interface CategoryHint {
  categoryName: string;
  source: CategorySource;
}

export interface CategoryHistoryRow {
  type: string;
  description: string | null;
  categoryName: string | null;
  date: Date;
  createdAt: Date;
}

export interface CategoryRecurrenceRow {
  description: string | null;
  aliases: readonly string[];
  categoryName: string;
}

export interface CustomCategoryRow {
  id: string;
  type: string;
}

export interface CategoryHints {
  lookup(type: HintType, place: string): CategoryHint | null;
}

const SYSTEM: Record<HintType, ReadonlySet<string>> = {
  INCOME: new Set(getCategoriesByType(CategoryType.INCOME)),
  EXPENSE: new Set(getCategoriesByType(CategoryType.EXPENSE)),
};

/** INCOME or EXPENSE for a category that exists in the household; null for a deleted custom one or an internal one. */
function typeOfCategory(categoryName: string, customTypes: ReadonlyMap<string, string>): HintType | null {
  if (isCustomCategoryName(categoryName)) {
    const type = customTypes.get(toCustomCategoryId(categoryName) ?? '');
    return type === 'INCOME' || type === 'EXPENSE' ? type : null;
  }
  if (SYSTEM.INCOME.has(categoryName)) return 'INCOME';
  if (SYSTEM.EXPENSE.has(categoryName)) return 'EXPENSE';
  return null;
}

const keyOf = (type: HintType, place: string | null | undefined): string | null => {
  const normalized = normalizeDescription(place);
  return normalized ? `${type}\n${normalized}` : null;
};

/**
 * Pure. `recurrences` are taken in the order given (the first one of a place wins); `history` is sorted here, newest
 * date first and newest created first within a day, so the caller's order does not matter.
 */
export function buildCategoryHints(input: {
  history: readonly CategoryHistoryRow[];
  recurrences: readonly CategoryRecurrenceRow[];
  customCategories: readonly CustomCategoryRow[];
}): CategoryHints {
  const customTypes = new Map(input.customCategories.map((c) => [c.id, c.type]));
  const hints = new Map<string, CategoryHint>();

  for (const rec of input.recurrences) {
    const type = typeOfCategory(rec.categoryName, customTypes);
    if (!type) continue;
    for (const name of [rec.description, ...rec.aliases]) {
      const key = keyOf(type, name);
      if (key && !hints.has(key)) hints.set(key, { categoryName: rec.categoryName, source: 'recurrence' });
    }
  }

  const newestFirst = [...input.history].sort(
    (a, b) => b.date.getTime() - a.date.getTime() || b.createdAt.getTime() - a.createdAt.getTime()
  );
  for (const row of newestFirst) {
    if (row.type !== 'INCOME' && row.type !== 'EXPENSE') continue;
    if (!row.categoryName || typeOfCategory(row.categoryName, customTypes) !== row.type) continue;
    const key = keyOf(row.type, row.description);
    if (key && !hints.has(key)) hints.set(key, { categoryName: row.categoryName, source: 'history' });
  }

  return {
    lookup(type, place) {
      const key = keyOf(type, place);
      return key ? (hints.get(key) ?? null) : null;
    },
  };
}
