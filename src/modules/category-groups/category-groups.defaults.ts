import { CategoryName, CategoryType, getCategoriesByType } from '../../shared/enums/index.js';
import { normalizeCategoryName, toCustomCategoryName } from '../../shared/utils/categoryHelpers.js';

/**
 * Spending groups: a level above the expense categories (where the month's income goes). Income categories never
 * belong to a group. A category without a group falls in the virtual group "Outros", which has no row.
 */
export const OTHER_GROUP_NAME = 'Outros';
/** Key of the virtual group in the API (its id is null). */
export const OTHER_GROUP_KEY = 'OTHER';

export function isReservedGroupName(name: string): boolean {
  return normalizeCategoryName(name) === normalizeCategoryName(OTHER_GROUP_NAME);
}

export interface DefaultGroup {
  name: string;
  color: string;
  isHousing: boolean;
  /** System expense categories placed in the group. */
  system: readonly CategoryName[];
  /** Custom category names (normalized: lower case, no accents) placed in the group. */
  customNames: readonly string[];
}

/**
 * Created once per household, on demand (never by the migration), and then adjustable by the user. Every system expense
 * category has a default group; a custom one is placed only when its name matches.
 */
export const DEFAULT_GROUPS: readonly DefaultGroup[] = [
  {
    name: 'Casa',
    color: '#2457E6',
    isHousing: true,
    system: [CategoryName.HOUSING, CategoryName.UTILITIES],
    customNames: ['casa', 'moradia', 'contas', 'condominio', 'aluguel', 'luz', 'energia', 'internet', 'financiamento'],
  },
  {
    name: 'Pessoal',
    color: '#8B5CF6',
    isHousing: false,
    system: [
      CategoryName.HEALTHCARE,
      CategoryName.PHARMACY,
      CategoryName.EDUCATION,
      CategoryName.TRANSPORTATION,
      CategoryName.FUEL,
      CategoryName.CLOTHING,
      CategoryName.SUBSCRIPTIONS,
    ],
    customNames: ['saude', 'educacao', 'carro', 'servico', 'servicos', 'mimos'],
  },
  {
    name: 'Dia a dia',
    color: '#F59E0B',
    isHousing: false,
    system: [
      CategoryName.FOOD,
      CategoryName.GROCERIES,
      CategoryName.RESTAURANT,
      CategoryName.ENTERTAINMENT,
      CategoryName.ONLINE_SHOPPING,
      CategoryName.OTHER_EXPENSES,
    ],
    customNames: ['alimentacao', 'mercado', 'lazer', 'outras', 'outros'],
  },
];

/** categoryName (system value or CUSTOM:<id>) -> default group name, for the expense categories a default group takes. */
export function defaultAssignments(custom: ReadonlyArray<{ id: string; name: string; type: string }>): Map<string, string> {
  const out = new Map<string, string>();
  const expense = new Set<string>(getCategoriesByType(CategoryType.EXPENSE));
  for (const group of DEFAULT_GROUPS) {
    for (const name of group.system) if (expense.has(name)) out.set(name, group.name);
  }
  for (const category of custom) {
    if (category.type !== CategoryType.EXPENSE) continue;
    const wanted = normalizeCategoryName(category.name);
    const group = DEFAULT_GROUPS.find((g) => g.customNames.includes(wanted));
    if (group) out.set(toCustomCategoryName(category.id), group.name);
  }
  return out;
}
