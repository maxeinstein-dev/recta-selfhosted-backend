import { describe, expect, it } from 'vitest';

import { CategoryName } from '../../shared/enums/index.js';
import type { MaxFinInstallment, MaxFinMonth, MaxFinRow, MaxFinSectionKey } from './parsers/maxfin.types.js';
import {
  addMonths,
  buildCategoryMap,
  buildFutureInstallments,
  coveredInstallmentNumbers,
  firstDayOfMonth,
  invoiceTechnicalId,
  isFutureDraftRef,
  legacyKey,
  mergeCategoryMaps,
  missingFutureNumbers,
  parseLocalDateString,
  storedDateString,
  toLocalDateString,
  invoicePaymentDate,
  isClosedMonth,
  lastDayOfMonth,
  monthKey,
  normalizeLabel,
  suggestCategory,
  sumAmounts,
  invoiceNetAmount,
  type CustomCategoryRef,
} from './maxfin-import.helpers.js';

const SHEET_MONTH: MaxFinMonth = { year: 2026, month: 9 };

/** Same shape the parser emits for `installmentId` (slug of the base description). */
function slug(s: string): string {
  return normalizeLabel(s).replace(/[^a-z0-9]+/g, '-');
}

function makeInstallment(
  baseDescription: string,
  number: number,
  total: number,
  prepaid = 0,
): MaxFinInstallment {
  return {
    number,
    total,
    prepaid,
    baseDescription,
    installmentId: `maxfin:${slug(baseDescription)}:${total}`,
    futureCount: total - (number + prepaid),
  };
}

function makeRow(overrides: Partial<MaxFinRow> = {}): MaxFinRow {
  const sourceLine = overrides.sourceLine ?? 1;
  const section = overrides.section ?? 'debit';
  const type = overrides.type ?? (section === 'income' ? 'INCOME' : 'EXPENSE');
  return {
    sourceLine,
    section,
    type,
    description: 'Mercado',
    categoryKey: 'Alimentação',
    amount: 100,
    planned: null,
    realized: 100,
    paid: true,
    date: new Date(2026, 8, 1),
    rawNote: null,
    notes: null,
    flag: 'ok',
    installment: null,
    shareHint: null,
    sourceRef: `maxfin:2026-09:${section}:${sourceLine}`,
    ...overrides,
  };
}

function ymd(d: Date): [number, number, number] {
  return [d.getFullYear(), d.getMonth() + 1, d.getDate()];
}

function monthKeyOf(d: Date): string {
  return monthKey({ year: d.getFullYear(), month: d.getMonth() + 1 });
}

describe('normalizeLabel', () => {
  it('strips accents, lowercases, trims and collapses inner whitespace', () => {
    expect(normalizeLabel('  Educação   Física ')).toBe('educacao fisica');
    expect(normalizeLabel('SAÚDE')).toBe('saude');
    expect(normalizeLabel('Cartão\tde\n crédito')).toBe('cartao de credito');
    expect(normalizeLabel('Ação')).toBe('acao');
  });

  it('returns an empty string for blank input', () => {
    expect(normalizeLabel('')).toBe('');
    expect(normalizeLabel('   ')).toBe('');
  });
});

describe('suggestCategory', () => {
  const customs: CustomCategoryRef[] = [
    { id: 'c-pets', name: 'Pets', type: 'EXPENSE' },
    { id: 'c-bonus', name: 'Bônus anual', type: 'INCOME' },
  ];

  it('maps an empty key to the default category of each type', () => {
    expect(suggestCategory('', 'INCOME', customs)).toEqual({
      kind: 'default',
      categoryName: CategoryName.OTHER_INCOME,
    });
    expect(suggestCategory('   ', 'EXPENSE', customs)).toEqual({
      kind: 'default',
      categoryName: CategoryName.OTHER_EXPENSES,
    });
  });

  it('matches pt-BR system labels regardless of accents and case', () => {
    for (const key of ['Saúde', 'saude', 'SAÚDE', ' saúde ']) {
      expect(suggestCategory(key, 'EXPENSE', customs), key).toEqual({
        kind: 'system',
        categoryName: CategoryName.HEALTHCARE,
      });
    }
    expect(suggestCategory('Educação', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.EDUCATION,
    });
    expect(suggestCategory('Lazer', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.ENTERTAINMENT,
    });
    expect(suggestCategory('Alimentação', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.FOOD,
    });
  });

  it('matches the enum key itself (English names)', () => {
    expect(suggestCategory('HOUSING', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.HOUSING,
    });
    expect(suggestCategory('housing', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.HOUSING,
    });
    expect(suggestCategory('Online Shopping', 'EXPENSE', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.ONLINE_SHOPPING,
    });
    expect(suggestCategory('other_income', 'INCOME', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.OTHER_INCOME,
    });
  });

  it('only matches system labels of the requested type', () => {
    expect(suggestCategory('Salário', 'INCOME', customs)).toEqual({
      kind: 'system',
      categoryName: CategoryName.SALARY,
    });
    expect(suggestCategory('Salário', 'EXPENSE', customs)).toEqual({
      kind: 'create',
      name: 'Salário',
    });
    expect(suggestCategory('Saúde', 'INCOME', customs)).toEqual({
      kind: 'create',
      name: 'Saúde',
    });
  });

  it('matches an existing custom category by normalized name and same type', () => {
    expect(suggestCategory('PETS', 'EXPENSE', customs)).toEqual({
      kind: 'custom',
      categoryId: 'c-pets',
      categoryName: 'CUSTOM:c-pets',
      name: 'Pets',
    });
    expect(suggestCategory('bonus   anual', 'INCOME', customs)).toEqual({
      kind: 'custom',
      categoryId: 'c-bonus',
      categoryName: 'CUSTOM:c-bonus',
      name: 'Bônus anual',
    });
    expect(suggestCategory('Pets', 'INCOME', customs)).toEqual({
      kind: 'create',
      name: 'Pets',
    });
  });

  it('prefers a system match over a custom with the same label', () => {
    const shadowing: CustomCategoryRef[] = [{ id: 'c-saude', name: 'Saúde', type: 'EXPENSE' }];
    expect(suggestCategory('Saúde', 'EXPENSE', shadowing)).toEqual({
      kind: 'system',
      categoryName: CategoryName.HEALTHCARE,
    });
  });

  it('suggests creating a custom category with the trimmed name when nothing matches', () => {
    expect(suggestCategory('Casa', 'EXPENSE', customs)).toEqual({ kind: 'create', name: 'Casa' });
    expect(suggestCategory('  Mimos ', 'EXPENSE', [])).toEqual({ kind: 'create', name: 'Mimos' });
  });

  it('truncates the suggested name to 100 characters', () => {
    expect(suggestCategory('x'.repeat(120), 'EXPENSE', [])).toEqual({
      kind: 'create',
      name: 'x'.repeat(100),
    });
  });
});

describe('buildCategoryMap', () => {
  it('dedupes keys across spellings, keeps the first-seen spelling and counts rows', () => {
    const rows = [
      makeRow({ section: 'bills', categoryKey: 'Saúde' }),
      makeRow({ section: 'credit', categoryKey: 'saude' }),
      makeRow({ section: 'credit', categoryKey: 'SAÚDE' }),
    ];

    const map = buildCategoryMap(rows, []);

    expect(map).toEqual([
      {
        key: 'Saúde',
        type: 'EXPENSE',
        count: 3,
        sections: ['bills', 'credit'],
        suggestion: { kind: 'system', categoryName: CategoryName.HEALTHCARE },
      },
    ]);
  });

  it('includes an entry for rows without a category key', () => {
    const rows = [
      makeRow({ section: 'debit', categoryKey: '' }),
      makeRow({ section: 'debit', categoryKey: '' }),
    ];

    expect(buildCategoryMap(rows, [])).toEqual([
      {
        key: '',
        type: 'EXPENSE',
        count: 2,
        sections: ['debit'],
        suggestion: { kind: 'default', categoryName: CategoryName.OTHER_EXPENSES },
      },
    ]);
  });

  it('suggests the default category for an unknown label used only by refunds', () => {
    const rows = [
      makeRow({ section: 'credit', type: 'INCOME', categoryKey: 'Lazer Teste' }),
      makeRow({ section: 'income', type: 'EXPENSE', categoryKey: 'Ajuste Teste' }),
    ];

    expect(buildCategoryMap(rows, []).map((e) => [e.type, e.key, e.suggestion])).toEqual([
      ['INCOME', 'Lazer Teste', { kind: 'default', categoryName: CategoryName.OTHER_INCOME }],
      ['EXPENSE', 'Ajuste Teste', { kind: 'default', categoryName: CategoryName.OTHER_EXPENSES }],
    ]);
  });

  it('keeps creating the category when the label is also used by regular rows of that type', () => {
    const rows = [
      makeRow({ section: 'income', type: 'INCOME', categoryKey: 'Bico Teste' }),
      makeRow({ section: 'credit', type: 'INCOME', categoryKey: 'Bico Teste' }),
    ];

    expect(buildCategoryMap(rows, [])[0]?.suggestion).toEqual({ kind: 'create', name: 'Bico Teste' });
  });

  it('keeps the same key separate per type', () => {
    const rows = [
      makeRow({ section: 'income', categoryKey: 'Aluguel' }),
      makeRow({ section: 'bills', categoryKey: 'Aluguel' }),
    ];

    const map = buildCategoryMap(rows, []);

    expect(map.map((e) => [e.type, e.count, e.suggestion])).toEqual([
      ['INCOME', 1, { kind: 'system', categoryName: CategoryName.RENTAL_INCOME }],
      ['EXPENSE', 1, { kind: 'create', name: 'Aluguel' }],
    ]);
  });

  it('sorts INCOME first, then by section of first appearance, then by normalized key', () => {
    const rows = [
      makeRow({ section: 'debit', categoryKey: 'Mimos' }),
      makeRow({ section: 'credit', categoryKey: 'Lazer' }),
      makeRow({ section: 'credit', categoryKey: 'casa' }),
      makeRow({ section: 'bills', categoryKey: 'Moradia' }),
      makeRow({ section: 'debit', categoryKey: 'Casa' }),
      makeRow({ section: 'income', categoryKey: 'Salário' }),
      makeRow({ section: 'income', categoryKey: '' }),
      makeRow({ section: 'bills', categoryKey: '' }),
    ];

    const map = buildCategoryMap(rows, []);

    expect(map.map((e) => `${e.type}:${e.sections.join('+')}:${e.key}`)).toEqual([
      'INCOME:income:',
      'INCOME:income:Salário',
      'EXPENSE:bills:',
      'EXPENSE:bills:Moradia',
      'EXPENSE:credit+debit:casa',
      'EXPENSE:credit:Lazer',
      'EXPENSE:debit:Mimos',
    ]);
  });

  it('passes the custom categories through to the suggestion', () => {
    const customs: CustomCategoryRef[] = [{ id: 'c-pets', name: 'Pets', type: 'EXPENSE' }];

    const map = buildCategoryMap([makeRow({ categoryKey: 'pets' })], customs);

    expect(map[0]?.suggestion).toEqual({
      kind: 'custom',
      categoryId: 'c-pets',
      categoryName: 'CUSTOM:c-pets',
      name: 'Pets',
    });
  });

  it('returns an empty map for no rows', () => {
    expect(buildCategoryMap([], [])).toEqual([]);
  });
});

describe('month helpers', () => {
  it('monthKey zero-pads the month', () => {
    expect(monthKey({ year: 2026, month: 9 })).toBe('2026-09');
    expect(monthKey({ year: 2026, month: 12 })).toBe('2026-12');
  });

  it('addMonths rolls the year over in both directions', () => {
    expect(addMonths({ year: 2026, month: 12 }, 1)).toEqual({ year: 2027, month: 1 });
    expect(addMonths({ year: 2026, month: 1 }, -1)).toEqual({ year: 2025, month: 12 });
    expect(addMonths({ year: 2026, month: 9 }, 15)).toEqual({ year: 2027, month: 12 });
    expect(addMonths({ year: 2026, month: 9 }, -21)).toEqual({ year: 2024, month: 12 });
    expect(addMonths({ year: 2026, month: 9 }, 0)).toEqual({ year: 2026, month: 9 });
  });

  it('firstDayOfMonth returns local midnight on day 1', () => {
    const d = firstDayOfMonth({ year: 2026, month: 2 });
    expect(ymd(d)).toEqual([2026, 2, 1]);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });

  it('lastDayOfMonth handles February in leap and non-leap years', () => {
    expect(lastDayOfMonth({ year: 2024, month: 2 })).toBe(29);
    expect(lastDayOfMonth({ year: 2026, month: 2 })).toBe(28);
    expect(lastDayOfMonth({ year: 2100, month: 2 })).toBe(28);
    expect(lastDayOfMonth({ year: 2026, month: 4 })).toBe(30);
    expect(lastDayOfMonth({ year: 2026, month: 12 })).toBe(31);
  });

  it('isClosedMonth compares against the calendar month of the injected today', () => {
    const today = new Date(2026, 9, 3, 15, 30); // 2026-10-03
    expect(isClosedMonth({ year: 2026, month: 10 }, today)).toBe(false);
    expect(isClosedMonth({ year: 2026, month: 9 }, today)).toBe(true);
    expect(isClosedMonth({ year: 2025, month: 12 }, today)).toBe(true);
    expect(isClosedMonth({ year: 2026, month: 11 }, today)).toBe(false);
    expect(isClosedMonth({ year: 2027, month: 1 }, today)).toBe(false);
  });

  it('isClosedMonth defaults today to now', () => {
    const now = new Date();
    const current: MaxFinMonth = { year: now.getFullYear(), month: now.getMonth() + 1 };
    expect(isClosedMonth(current)).toBe(false);
    expect(isClosedMonth(addMonths(current, -1))).toBe(true);
  });

  it('invoicePaymentDate clamps the due day to the month at local midnight', () => {
    const april: MaxFinMonth = { year: 2026, month: 4 };
    expect(ymd(invoicePaymentDate(april, 31))).toEqual([2026, 4, 30]);
    expect(ymd(invoicePaymentDate(april, null))).toEqual([2026, 4, 30]);
    expect(ymd(invoicePaymentDate(april, undefined))).toEqual([2026, 4, 30]);
    expect(ymd(invoicePaymentDate(april, 9))).toEqual([2026, 4, 9]);
    expect(ymd(invoicePaymentDate(april, 0))).toEqual([2026, 4, 1]);
    expect(ymd(invoicePaymentDate({ year: 2026, month: 2 }, 31))).toEqual([2026, 2, 28]);

    const d = invoicePaymentDate(april, 9);
    expect([d.getHours(), d.getMinutes(), d.getSeconds(), d.getMilliseconds()]).toEqual([
      0, 0, 0, 0,
    ]);
  });
});

describe('buildFutureInstallments', () => {
  it('returns nothing for rows without an installment', () => {
    expect(buildFutureInstallments(makeRow({ section: 'credit' }), SHEET_MONTH)).toEqual([]);
  });

  it('returns nothing when the plan is already settled (5/12 +7)', () => {
    const row = makeRow({
      section: 'credit',
      description: 'Curso B 5/12 +7',
      installment: makeInstallment('Curso B', 5, 12, 7),
    });

    expect(buildFutureInstallments(row, SHEET_MONTH)).toEqual([]);
  });

  it('generates the remaining installments month by month (3/10)', () => {
    const row = makeRow({
      section: 'credit',
      sourceLine: 42,
      description: 'Notebook 3/10',
      categoryKey: 'Compras',
      amount: 250.5,
      installment: makeInstallment('Notebook', 3, 10),
    });

    const drafts = buildFutureInstallments(row, SHEET_MONTH);

    expect(drafts).toHaveLength(7);
    expect(drafts.map((d) => d.installmentNumber)).toEqual([4, 5, 6, 7, 8, 9, 10]);
    expect(drafts.map((d) => monthKeyOf(d.date))).toEqual([
      '2026-10',
      '2026-11',
      '2026-12',
      '2027-01',
      '2027-02',
      '2027-03',
      '2027-04',
    ]);
    expect(drafts.map((d) => d.sourceRef)).toEqual(
      [1, 2, 3, 4, 5, 6, 7].map((i) => `maxfin:2026-09:credit:42:f${i}`),
    );
    expect(drafts.every((d) => d.date.getDate() === 1 && d.date.getHours() === 0)).toBe(true);
    expect(drafts.every((d) => d.amount === 250.5)).toBe(true);
    expect(drafts[0]).toEqual({
      date: new Date(2026, 9, 1),
      description: 'Notebook 4/10',
      amount: 250.5,
      installmentId: 'maxfin:notebook:10',
      installmentNumber: 4,
      totalInstallments: 10,
      categoryKey: 'Compras',
      notes: 'parcela futura gerada na importação de "Notebook 3/10"',
      paid: true,
      sourceRef: 'maxfin:2026-09:credit:42:f1',
      section: 'credit',
    });
    expect(drafts[6]?.description).toBe('Notebook 10/10');
  });

  it('skips the prepaid installments on a partial prepayment (2/6 +2)', () => {
    const row = makeRow({
      section: 'credit',
      sourceLine: 7,
      description: 'Sofá 2/6 +2',
      amount: 300,
      installment: makeInstallment('Sofá', 2, 6, 2),
    });

    const drafts = buildFutureInstallments(row, SHEET_MONTH);

    expect(drafts.map((d) => d.description)).toEqual(['Sofá 5/6', 'Sofá 6/6']);
    // The row amount covers installments 2..4, so each future one is a third of it.
    expect(drafts.map((d) => d.amount)).toEqual([100, 100]);
    expect(drafts[0]?.notes).toContain('valor estimado');
    expect(drafts.map((d) => d.installmentNumber)).toEqual([5, 6]);
    expect(drafts.map((d) => d.totalInstallments)).toEqual([6, 6]);
    expect(drafts.map((d) => d.sourceRef)).toEqual([
      'maxfin:2026-09:credit:7:f1',
      'maxfin:2026-09:credit:7:f2',
    ]);
    expect(drafts.map((d) => monthKeyOf(d.date))).toEqual(['2026-10', '2026-11']);
  });
});

describe('day strings', () => {
  it('formats a local-midnight date as YYYY-MM-DD', () => {
    expect(toLocalDateString(new Date(2026, 2, 9))).toBe('2026-03-09');
  });

  it('reads the day of a @db.Date value (UTC midnight) in UTC, whatever the host timezone', () => {
    expect(storedDateString(new Date('2026-03-09T00:00:00.000Z'))).toBe('2026-03-09');
  });

  it('gives the same legacy key to a parsed row and to the stored row of the same day', () => {
    const parsed = legacyKey('acc', toLocalDateString(new Date(2026, 1, 1)), 12.34, ' Padaria ', 'EXPENSE');
    const stored = legacyKey('acc', storedDateString(new Date('2026-02-01T00:00:00.000Z')), 12.34, 'Padaria', 'EXPENSE');
    expect(stored).toBe(parsed);
    expect(parsed).toBe('acc|2026-02-01|12.34|Padaria|EXPENSE');
  });

  it('keeps cents in the legacy key', () => {
    expect(legacyKey('acc', '2026-02-01', 4.2, 'x', 'EXPENSE')).toBe('acc|2026-02-01|4.20|x|EXPENSE');
    // Amounts are absolute: an expense and a credit of the same value are different rows.
    expect(legacyKey('acc', '2026-02-01', 4.2, 'x', 'INCOME')).not.toBe(legacyKey('acc', '2026-02-01', 4.2, 'x', 'EXPENSE'));
  });

  it('parses a real calendar day and rejects roll-overs and bad formats', () => {
    const date = parseLocalDateString('2026-10-01');
    expect([date.getFullYear(), date.getMonth(), date.getDate(), date.getHours()]).toEqual([2026, 9, 1, 0]);
    expect(() => parseLocalDateString('2026-13-45')).toThrow();
    expect(() => parseLocalDateString('2026-02-30')).toThrow();
    expect(() => parseLocalDateString('01/10/2026')).toThrow();
  });
});

describe('invoiceTechnicalId', () => {
  it('uses the zero-based month like payCreditCardInvoice and the frontend invoice filter', () => {
    expect(invoiceTechnicalId('card-1', { year: 2026, month: 3 })).toBe('invoice_pay:card-1:2026-2');
    expect(invoiceTechnicalId('card-1', { year: 2026, month: 1 })).toBe('invoice_pay:card-1:2026-0');
    expect(invoiceTechnicalId('card-1', { year: 2026, month: 12 })).toBe('invoice_pay:card-1:2026-11');
  });
});

describe('future installment bookkeeping', () => {
  it('recognises the sourceRef of a generated future installment and nothing else', () => {
    expect(isFutureDraftRef('maxfin:2026-11:credit:66:f1')).toBe(true);
    expect(isFutureDraftRef('maxfin:2026-11:credit:66')).toBe(false);
    expect(isFutureDraftRef('maxfin:2026-11:credit:66:fx')).toBe(false);
    expect(isFutureDraftRef('ofx:abc:f1')).toBe(false);
    expect(isFutureDraftRef(null)).toBe(false);
    expect(isFutureDraftRef(undefined)).toBe(false);
  });

  it('covers N..N+K for a row with prepaid installments', () => {
    expect(coveredInstallmentNumbers(makeInstallment('Loja Z', 4, 10, 0))).toEqual([4]);
    expect(coveredInstallmentNumbers(makeInstallment('Loja Z', 4, 10, 2))).toEqual([4, 5, 6]);
  });

  it('lists only the numbers after the row that are not stored yet', () => {
    const inst = makeInstallment('Loja Z', 4, 10, 2); // covers 4..6, future 7..10
    expect(missingFutureNumbers(inst, new Set())).toEqual([7, 8, 9, 10]);
    expect(missingFutureNumbers(inst, new Set([7, 8, 9, 10]))).toEqual([]);
    expect(missingFutureNumbers(inst, new Set([5, 9]))).toEqual([7, 8, 10]);
  });

  it('does not create a future installment whose number already exists', () => {
    const row = makeRow({
      section: 'credit',
      sourceLine: 66,
      description: 'Loja Z 3/10',
      installment: makeInstallment('Loja Z', 3, 10),
    });
    const drafts = buildFutureInstallments(row, SHEET_MONTH, new Set([4, 5, 9]));
    expect(drafts.map((d) => d.installmentNumber)).toEqual([6, 7, 8, 10]);
    // the index in the sourceRef follows the offset from the sheet row, so refs stay stable
    expect(drafts.map((d) => d.sourceRef)).toEqual([
      'maxfin:2026-09:credit:66:f3',
      'maxfin:2026-09:credit:66:f4',
      'maxfin:2026-09:credit:66:f5',
      'maxfin:2026-09:credit:66:f7',
    ]);
  });
});

describe('sumAmounts', () => {
  it('sums without binary float drift', () => {
    expect(sumAmounts([{ amount: 0.1 }, { amount: 0.2 }])).toBe(0.3);
    expect(sumAmounts([{ amount: 1234.56 }, { amount: 0.44 }, { amount: 99.99 }])).toBe(1334.99);
  });

  it('returns 0 for an empty list', () => {
    expect(sumAmounts([])).toBe(0);
  });

  it('rounds the result to 2 decimals and keeps the sign', () => {
    expect(sumAmounts([{ amount: 1.005 }])).toBe(1.01);
    expect(sumAmounts([{ amount: 10.004 }])).toBe(10);
    expect(sumAmounts([{ amount: 10 }, { amount: -2.5 }])).toBe(7.5);
  });
});

describe('invoiceNetAmount', () => {
  it('subtracts the credits (INCOME) from the purchases (EXPENSE), in cents', () => {
    expect(invoiceNetAmount([{ type: 'EXPENSE', amount: 100.1 }, { type: 'INCOME', amount: 30.05 }])).toBe(70.05);
    expect(invoiceNetAmount([{ type: 'EXPENSE', amount: 0.3 }, { type: 'INCOME', amount: 0.1 }])).toBe(0.2);
  });

  it('is zero for no rows and negative when the credits are larger', () => {
    expect(invoiceNetAmount([])).toBe(0);
    expect(invoiceNetAmount([{ type: 'EXPENSE', amount: 40 }, { type: 'INCOME', amount: 100 }])).toBe(-60);
  });
});

describe('mergeCategoryMaps', () => {
  const entry = (key: string, type: 'INCOME' | 'EXPENSE', count: number, sections: MaxFinSectionKey[], label = key) => ({
    key,
    type,
    count,
    sections,
    suggestion: { label },
  });

  it('joins entries of one type and normalized key: counts summed, blocks in block order, first spelling kept', () => {
    const merged = mergeCategoryMaps([
      [entry('Compras', 'EXPENSE', 2, ['debit'], 'primeiro'), entry('Salário', 'INCOME', 1, ['income'])],
      [entry(' compras ', 'EXPENSE', 1, ['credit'], 'segundo'), entry('Compras', 'INCOME', 1, ['credit']), entry('Casa', 'EXPENSE', 1, ['bills'])],
    ]);

    expect(merged).toEqual([
      entry('Salário', 'INCOME', 1, ['income']),
      entry('Compras', 'INCOME', 1, ['credit']),
      entry('Casa', 'EXPENSE', 1, ['bills']),
      entry('Compras', 'EXPENSE', 3, ['credit', 'debit'], 'primeiro'),
    ]);
  });

  it('leaves the maps it merges untouched', () => {
    const first = [entry('Casa', 'EXPENSE', 1, ['debit'])];
    const second = [entry('casa', 'EXPENSE', 2, ['bills'])];

    mergeCategoryMaps([first, second]);

    expect(first).toEqual([entry('Casa', 'EXPENSE', 1, ['debit'])]);
    expect(second).toEqual([entry('casa', 'EXPENSE', 2, ['bills'])]);
  });
});
