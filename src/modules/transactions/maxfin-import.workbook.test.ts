import { readFileSync } from 'node:fs';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { bufferToGrid } from '../../shared/csv/grid.js';
import { AccountType } from '../../shared/enums/index.js';
import { buildXlsx, type FixtureSheet, type FixtureValue } from '../../shared/xlsx/__fixtures__/build-xlsx.js';
import {
  buildMaxFinPreview,
  buildMaxFinWorkbookPreview,
  MAX_WORKBOOK_PREVIEW_ROWS,
  type BuildWorkbookPreviewParams,
  type MaxFinAccountsResolved,
  type ResolvedAccount,
} from './maxfin-import.service.js';
import type { MaxFinAccountsInput, MaxFinPreviewResponse, MaxFinWorkbookPreviewResponse } from './maxfin-import.types.js';
import { parseMoneyBR } from './parsers/maxfin.parser.js';
import type { MaxFinSectionKey } from './parsers/maxfin.types.js';

// The service talks to prisma and to the write functions; the reader, the parser and the helpers run for real.
const db = vi.hoisted(() => ({
  accountFindMany: vi.fn(),
  categoryFindMany: vi.fn(),
  transactionFindMany: vi.fn(),
  transactionFindFirst: vi.fn(),
  createTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
  payCreditCardInvoice: vi.fn(),
  createCategory: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    account: { findMany: db.accountFindMany },
    category: { findMany: db.categoryFindMany },
    transaction: { findMany: db.transactionFindMany, findFirst: db.transactionFindFirst },
  },
}));
vi.mock('./transactions.service.js', () => ({
  createTransaction: db.createTransaction,
  deleteTransaction: db.deleteTransaction,
  payCreditCardInvoice: db.payCreditCardInvoice,
}));
vi.mock('../categories/categories.service.js', () => ({ createCategory: db.createCategory }));
// Recurrence matching has its own tests (maxfin-import.recurring.test.ts); here no recurrence covers any month.
vi.mock('./maxfin-recurring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./maxfin-recurring.js')>()),
  loadRecurringMatcher: async () => ({ take: () => undefined }),
}));


// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOUSEHOLD = 'hh-1';
/** October 2026 is the current month: September is the last closed one. */
const TODAY = new Date(2026, 9, 3);
const SAMPLE_CSV = readFileSync(new URL('./parsers/__fixtures__/maxfin-sample.csv', import.meta.url));
const SAMPLE_GRID = bufferToGrid(SAMPLE_CSV).grid;

/** Four accounts of one household; the card is a CREDIT account due on day 9. */
function makeAccounts(): MaxFinAccountsResolved {
  const account = (key: MaxFinSectionKey, extra: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
    id: `acc-${key}`,
    name: `Conta ${key}`,
    type: AccountType.CHECKING,
    householdId: HOUSEHOLD,
    dueDay: null,
    closingDay: null,
    ...extra,
  });
  return {
    householdId: HOUSEHOLD,
    income: account('income'),
    bills: account('bills'),
    credit: account('credit', { name: 'Cartão Teste', type: AccountType.CREDIT, dueDay: 9, closingDay: 2 }),
    debit: account('debit'),
  };
}

function idsOf(accounts: MaxFinAccountsResolved): MaxFinAccountsInput {
  return { income: accounts.income.id, bills: accounts.bills.id, credit: accounts.credit.id, debit: accounts.debit.id };
}

function title(month: string, year = 2026): string {
  return `Finanças Teste\nMês de ${month} de ${year}`;
}

/** The sample tab as a workbook holds it: money as numbers, under another title ('' = no title at all). */
function sampleTab(titleText: string): FixtureValue[][] {
  return SAMPLE_GRID.map((cells, rowIndex) =>
    cells.map((text, columnIndex) => {
      if (rowIndex === 0 && columnIndex === 0) return titleText;
      const money = columnIndex >= 3 && columnIndex <= 8 ? parseMoneyBR(text) : null;
      return money ?? text;
    }),
  );
}

const HEADER: FixtureValue[] = ['', 'Descrição', 'Categoria', 'Entrada - Previsto ', 'Recebido ', 'À receber', 'Saída - Previsto', 'Realizado ', 'Saldo'];
type Entry = [description: string, category: string, amount: number];

/** A small month tab: the title, the header, then the four blocks (the last three closed by a Total row). */
function miniTab(titleText: string, blocks: Partial<Record<MaxFinSectionKey, Entry[]>>): FixtureValue[][] {
  const rows: FixtureValue[][] = [[titleText], [], HEADER];
  for (const [description, category, amount] of blocks.income ?? []) rows.push(['', description, category, amount, amount]);
  for (const key of ['bills', 'credit', 'debit'] as const) {
    for (const [description, category, amount] of blocks[key] ?? []) {
      rows.push(['', description, category, null, null, null, amount, amount]);
    }
    rows.push(['', 'Total']);
  }
  return rows;
}

/** Header and blocks without a single row with a value. */
function emptyTab(titleText: string): FixtureValue[][] {
  return miniTab(titleText, {});
}

const RESUMO: FixtureSheet = { name: 'Resumo', rows: [['Resumo 2026'], ['Saldo', 1945.1]] };

function preview(
  sheets: FixtureSheet[],
  overrides: Partial<BuildWorkbookPreviewParams> = {},
): Promise<MaxFinWorkbookPreviewResponse> {
  const resolved = makeAccounts();
  return buildMaxFinWorkbookPreview({
    filename: 'FINANCAS_2026.xlsx',
    buffer: buildXlsx({ sheets }),
    accounts: idsOf(resolved),
    resolved,
    today: TODAY,
    ...overrides,
  });
}

function monthOf(response: MaxFinWorkbookPreviewResponse, key: string): MaxFinPreviewResponse {
  const found = response.months.find((month) => month.monthKey === key);
  if (!found) throw new Error(`no month ${key} in the preview`);
  return found;
}

function rowNamed(month: MaxFinPreviewResponse, description: string) {
  const found = month.rows.find((row) => row.description === description);
  if (!found) throw new Error(`no row "${description}" in ${month.monthKey}`);
  return found;
}

/** AppError resets its prototype, so a BadRequestError is recognised by its status, code and message. */
function badRequest(message: string) {
  return expect.objectContaining({ statusCode: 400, code: 'BAD_REQUEST', message: expect.stringContaining(message) });
}

interface StoredRow {
  id: string;
  sourceRef: string;
  amount: number;
  paid: boolean;
  type: 'INCOME' | 'EXPENSE';
}

/** prisma.transaction.findMany answers the sourceRef lookups from these rows and nothing else. */
function useStore(rows: StoredRow[]): void {
  db.transactionFindMany.mockImplementation(async (args: { where: { sourceRef?: { in?: string[] } | null } }) => {
    const refs = args.where.sourceRef?.in ?? [];
    return rows
      .filter((row) => refs.includes(row.sourceRef))
      .map((row) => ({ ...row, amount: { toNumber: () => row.amount } }));
  });
}

beforeEach(() => {
  for (const mock of Object.values(db)) mock.mockReset();
  db.categoryFindMany.mockResolvedValue([]);
  db.transactionFindFirst.mockResolvedValue(null);
  useStore([]);
});

// A workbook like the real one: January and February hidden, October current, November with the October title
// copied over, and a summary tab without the header.
const YEAR_SHEETS: FixtureSheet[] = [
  { name: 'JAN', state: 'hidden', rows: sampleTab(title('janeiro')) },
  { name: 'FEV', state: 'hidden', rows: sampleTab(title('fevereiro')) },
  { name: 'OUT', rows: sampleTab(title('outubro')) },
  { name: 'NOV', rows: sampleTab(title('outubro')) },
  RESUMO,
];

// ---------------------------------------------------------------------------
// Month selection
// ---------------------------------------------------------------------------

describe('buildMaxFinWorkbookPreview: months', () => {
  it('selects every month tab up to the current month by default, oldest first, and leaves later ones available', async () => {
    const response = await preview(YEAR_SHEETS);

    expect(response.months.map((month) => month.monthKey)).toEqual(['2026-01', '2026-02', '2026-10']);
    expect(response.sheets).toEqual([
      { name: 'JAN', monthKey: '2026-01', status: 'selected', reason: null, rowCount: 18, hidden: true },
      { name: 'FEV', monthKey: '2026-02', status: 'selected', reason: null, rowCount: 18, hidden: true },
      { name: 'OUT', monthKey: '2026-10', status: 'selected', reason: null, rowCount: 18, hidden: false },
      { name: 'NOV', monthKey: '2026-11', status: 'available', reason: null, rowCount: 18, hidden: false },
      { name: 'Resumo', monthKey: null, status: 'skipped', reason: 'sem cabeçalho "Descrição"', rowCount: 0, hidden: false },
    ]);
    expect(response).toMatchObject({
      filename: 'FINANCAS_2026.xlsx',
      householdId: HOUSEHOLD,
      accounts: idsOf(makeAccounts()),
      options: { months: ['2026-01', '2026-02', '2026-10'], closedThrough: '2026-09', payInvoice: true, generateFutureInstallments: true },
      warnings: [],
    });
  });

  it('previews exactly the months asked for, oldest first', async () => {
    const response = await preview(YEAR_SHEETS, { options: { months: ['2026-11', '2026-01', '2026-11'] } });

    expect(response.options.months).toEqual(['2026-01', '2026-11']);
    expect(response.months.map((month) => month.monthKey)).toEqual(['2026-01', '2026-11']);
    expect(response.sheets.map((sheet) => [sheet.name, sheet.status])).toEqual([
      ['JAN', 'selected'],
      ['FEV', 'available'],
      ['OUT', 'available'],
      ['NOV', 'selected'],
      ['Resumo', 'skipped'],
    ]);
  });

  it('takes the month of a tab from its name when its title was copied from another month, and says so', async () => {
    const response = await preview(YEAR_SHEETS, { options: { months: ['2026-11'] } });

    const november = monthOf(response, '2026-11');
    expect(november).toMatchObject({ monthSource: 'sheet', month: { year: 2026, month: 11 } });
    expect(november.warnings).toContain(
      'O título da aba diz outubro/2026, mas a aba se chama "NOV": usei novembro/2026 (ano do nome do arquivo).',
    );
    expect(november.rows.every((row) => row.sourceRef.startsWith('maxfin:2026-11:') && row.date === '2026-11-01')).toBe(true);
  });

  it('rejects a month that is not a month tab of the workbook', async () => {
    await expect(preview(YEAR_SHEETS, { options: { months: ['2026-01', '2026-05'] } })).rejects.toEqual(
      badRequest('Not a month tab of this workbook: 2026-05'),
    );
  });

  it('rejects a month whose only tab was skipped', async () => {
    const sheets = [...YEAR_SHEETS, { name: 'DEZ', rows: emptyTab(title('dezembro')) }];

    await expect(preview(sheets, { options: { months: ['2026-12'] } })).rejects.toEqual(badRequest('2026-12'));
  });

  it('previews no month, and loads nothing, when asked for none', async () => {
    const response = await preview(YEAR_SHEETS, { options: { months: [] } });

    expect(response.months).toEqual([]);
    expect(response.categoryMap).toEqual([]);
    expect(response.sheets.map((sheet) => sheet.status)).toEqual(['available', 'available', 'available', 'available', 'skipped']);
    expect(db.categoryFindMany).not.toHaveBeenCalled();
    expect(db.transactionFindMany).not.toHaveBeenCalled();
  });

  it('rejects a workbook without any month tab, listing why each tab was skipped', async () => {
    await expect(preview([RESUMO])).rejects.toEqual(badRequest('No month tab found in the workbook (Resumo: sem cabeçalho "Descrição")'));
  });

  it('rejects a file that is not an .xlsx workbook', async () => {
    await expect(preview([], { buffer: SAMPLE_CSV })).rejects.toEqual(badRequest('not an .xlsx workbook'));
  });
});

// ---------------------------------------------------------------------------
// Options of each month
// ---------------------------------------------------------------------------

describe('buildMaxFinWorkbookPreview: options of each month', () => {
  it('closes the months up to the previous one and generates future installments only from the latest month', async () => {
    const response = await preview(YEAR_SHEETS);

    const [january, february, october] = response.months;
    expect(january?.options).toEqual({ closedMonth: true, payInvoice: true, generateFutureInstallments: false });
    expect(february?.options).toEqual({ closedMonth: true, payInvoice: true, generateFutureInstallments: false });
    expect(october?.options).toEqual({ closedMonth: false, payInvoice: true, generateFutureInstallments: true });
    expect(january?.rows.every((row) => row.paid && row.futureInstallments === 0)).toBe(true);
    expect(january?.invoice).toMatchObject({ month: '2026-01', amount: 1916.5, willPay: true });
    expect(rowNamed(october!, 'Loja A 3/10').futureInstallments).toBe(7);
    expect(october?.invoice).toMatchObject({ month: '2026-10', willPay: false });
  });

  it('closes the months up to closedThrough, and none when it is null', async () => {
    const throughJanuary = await preview(YEAR_SHEETS, { options: { closedThrough: '2026-01' } });
    const none = await preview(YEAR_SHEETS, { options: { closedThrough: null } });

    expect(throughJanuary.options.closedThrough).toBe('2026-01');
    expect(throughJanuary.months.map((month) => month.options.closedMonth)).toEqual([true, false, false]);
    expect(none.options.closedThrough).toBeNull();
    expect(none.months.map((month) => month.options.closedMonth)).toEqual([false, false, false]);
    // An open February that is not the latest month still generates nothing.
    expect(rowNamed(throughJanuary.months[1]!, 'Loja A 3/10').futureInstallments).toBe(0);
  });

  it('applies payInvoice to every month and can switch future installments off', async () => {
    const response = await preview(YEAR_SHEETS, { options: { payInvoice: false, generateFutureInstallments: false } });

    expect(response.months.map((month) => month.options)).toEqual([
      { closedMonth: true, payInvoice: false, generateFutureInstallments: false },
      { closedMonth: true, payInvoice: false, generateFutureInstallments: false },
      { closedMonth: false, payInvoice: false, generateFutureInstallments: false },
    ]);
    expect(response.months[0]?.invoice?.willPay).toBe(false);
    expect(response.months.flatMap((month) => month.rows).every((row) => row.futureInstallments === 0)).toBe(true);
  });

  it('generates nothing from a latest month that is closed', async () => {
    const response = await preview(YEAR_SHEETS, { options: { months: ['2026-01', '2026-02'] } });

    const february = monthOf(response, '2026-02');
    expect(february.options).toMatchObject({ closedMonth: true, generateFutureInstallments: false });
    expect(february.rows.every((row) => row.futureInstallments === 0)).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// Skipped tabs and the month of each tab
// ---------------------------------------------------------------------------

describe('buildMaxFinWorkbookPreview: skipped tabs', () => {
  it('skips tabs without the header, without a month, without rows and with a month already taken, saying why', async () => {
    const response = await preview([
      { name: 'OUT', rows: sampleTab(title('outubro')) },
      RESUMO,
      { name: 'Planejamento', rows: sampleTab('Finanças Teste') },
      { name: 'DEZ', rows: emptyTab(title('dezembro')) },
      { name: 'OUT (cópia)', rows: sampleTab(title('outubro')) },
    ]);

    expect(response.sheets).toEqual([
      { name: 'OUT', monthKey: '2026-10', status: 'selected', reason: null, rowCount: 18, hidden: false },
      { name: 'Resumo', monthKey: null, status: 'skipped', reason: 'sem cabeçalho "Descrição"', rowCount: 0, hidden: false },
      { name: 'Planejamento', monthKey: null, status: 'skipped', reason: 'mês não identificado', rowCount: 0, hidden: false },
      { name: 'DEZ', monthKey: '2026-12', status: 'skipped', reason: 'sem linhas para importar', rowCount: 0, hidden: false },
      {
        name: 'OUT (cópia)',
        monthKey: '2026-10',
        status: 'skipped',
        reason: 'mês repetido (vale a aba "OUT")',
        rowCount: 0,
        hidden: false,
      },
    ]);
    expect(response.months.map((month) => month.monthKey)).toEqual(['2026-10']);
  });

  it('lets a later tab hold a month whose first tab has no rows', async () => {
    const response = await preview([
      { name: 'SET', rows: emptyTab(title('setembro')) },
      { name: 'SET 2', rows: sampleTab(title('setembro')) },
    ]);

    expect(response.sheets.map((sheet) => [sheet.name, sheet.status, sheet.reason])).toEqual([
      ['SET', 'skipped', 'sem linhas para importar'],
      ['SET 2', 'selected', null],
    ]);
  });
});

describe('buildMaxFinWorkbookPreview: tabs whose title names another month', () => {
  it('keeps a backward copy (SET made from OUT) in the year of the file name', async () => {
    const response = await preview([
      { name: 'OUT', rows: sampleTab(title('outubro')) },
      { name: 'SET', rows: sampleTab(title('outubro')) },
    ]);

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey, sheet.status])).toEqual([
      ['OUT', '2026-10', 'selected'],
      ['SET', '2026-09', 'selected'],
    ]);
    expect(monthOf(response, '2026-09').warnings).toContain(
      'O título da aba diz outubro/2026, mas a aba se chama "SET": usei setembro/2026 (ano do nome do arquivo).',
    );
  });

  it('takes JAN copied from DEZ in a file named for the next year as January of that year', async () => {
    const response = await preview(
      [
        { name: 'DEZ', rows: sampleTab(title('dezembro')) },
        { name: 'JAN', rows: sampleTab(title('dezembro')) },
      ],
      { filename: 'FINANCAS_2027.xlsx', today: new Date(2027, 0, 15) },
    );

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey, sheet.status])).toEqual([
      ['DEZ', '2026-12', 'selected'],
      ['JAN', '2027-01', 'selected'],
    ]);
    expect(monthOf(response, '2026-12')).toMatchObject({ monthSource: 'title', options: { closedMonth: true } });
  });

  it('in a file named for the previous year, lands such a copy on that year and skips it as a repeated month', async () => {
    const response = await preview([
      { name: 'JAN', rows: sampleTab(title('janeiro')) },
      { name: 'DEZ', rows: sampleTab(title('dezembro')) },
      { name: 'JAN (2)', rows: sampleTab(title('dezembro')) },
    ]);

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey, sheet.status, sheet.reason])).toEqual([
      ['JAN', '2026-01', 'selected', null],
      ['DEZ', '2026-12', 'available', null],
      ['JAN (2)', '2026-01', 'skipped', 'mês repetido (vale a aba "JAN")'],
    ]);
  });

  it('with no year but the titles, moves JAN copied from DEZ to the next year', async () => {
    const response = await preview(
      [
        { name: 'DEZ', rows: sampleTab(title('dezembro')) },
        { name: 'JAN', rows: sampleTab(title('dezembro')) },
      ],
      { filename: 'financas.xlsx', today: new Date(2027, 0, 15) },
    );

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey])).toEqual([
      ['DEZ', '2026-12'],
      ['JAN', '2027-01'],
    ]);
    expect(monthOf(response, '2027-01').warnings).toContain(
      'O título da aba diz dezembro/2026, mas a aba se chama "JAN": usei janeiro/2027 (ano seguinte ao do título: a aba é uma cópia feita depois dele).',
    );
  });
});

describe('buildMaxFinWorkbookPreview: month of tabs without a title', () => {
  it('takes the year from the uploaded file name', async () => {
    const response = await preview([
      { name: 'JAN', rows: sampleTab('') },
      { name: 'FEV', rows: sampleTab('') },
    ]);

    expect(response.months.map((month) => [month.monthKey, month.monthSource])).toEqual([
      ['2026-01', 'sheet'],
      ['2026-02', 'sheet'],
    ]);
  });

  it('takes the year the titled tabs share when the file name has none', async () => {
    const response = await preview(
      [
        { name: 'JAN', rows: sampleTab(title('janeiro')) },
        { name: 'FEV', rows: sampleTab('') },
      ],
      { filename: 'financas.xlsx' },
    );

    expect(response.sheets.map((sheet) => sheet.monthKey)).toEqual(['2026-01', '2026-02']);
  });

  it('leaves the month unidentified when the titled tabs disagree on the year and nothing else gives one', async () => {
    const response = await preview(
      [
        { name: 'JAN', rows: sampleTab(title('janeiro', 2025)) },
        { name: 'MAR', rows: sampleTab(title('março')) },
        { name: 'FEV', rows: sampleTab('') },
      ],
      { filename: 'financas.xlsx' },
    );

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey, sheet.reason])).toEqual([
      ['JAN', '2025-01', null],
      ['MAR', '2026-03', null],
      ['FEV', null, 'mês não identificado'],
    ]);
  });

  it('never takes a month from the uploaded file name, only its year', async () => {
    const response = await preview(
      [
        { name: 'JAN', rows: sampleTab('') },
        { name: 'FEV', rows: sampleTab('') },
        { name: 'Planejamento', rows: sampleTab('') },
      ],
      { filename: 'Planilha março 2026.xlsx' },
    );

    expect(response.sheets.map((sheet) => [sheet.name, sheet.monthKey, sheet.reason])).toEqual([
      ['JAN', '2026-01', null],
      ['FEV', '2026-02', null],
      ['Planejamento', null, 'mês não identificado'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Category map, storage and the CSV path
// ---------------------------------------------------------------------------

describe('buildMaxFinWorkbookPreview: category map', () => {
  it('merges the maps of the selected months: counts summed, blocks joined in block order, first spelling kept', async () => {
    const response = await preview([
      {
        name: 'JAN',
        rows: miniTab(title('janeiro'), {
          bills: [['Aluguel Teste', 'Moradia', 1300]],
          debit: [['Pix Loja Z', 'Compras', 20]],
        }),
      },
      {
        name: 'FEV',
        rows: miniTab(title('fevereiro'), {
          bills: [['Aluguel Teste', 'Moradia', 1300]],
          credit: [['Loja Z 4/10', ' compras ', 90]],
        }),
      },
    ]);

    expect(response.categoryMap).toEqual([
      { key: 'Moradia', type: 'EXPENSE', count: 2, sections: ['bills'], suggestion: expect.objectContaining({ kind: 'system' }) },
      {
        key: 'Compras',
        type: 'EXPENSE',
        count: 2,
        sections: ['credit', 'debit'],
        suggestion: { kind: 'create', name: 'Compras', label: 'Compras (nova categoria)' },
      },
    ]);
    // Each month keeps its own map.
    expect(monthOf(response, '2026-02').categoryMap.find((entry) => entry.type === 'EXPENSE' && entry.sections.includes('credit'))).toMatchObject({
      key: 'compras',
      count: 1,
    });
  });

  it('loads the custom categories of the household once for the whole workbook', async () => {
    db.categoryFindMany.mockResolvedValue([{ id: 'cat-compras', name: 'compras', type: 'EXPENSE' }]);

    const response = await preview(YEAR_SHEETS);

    expect(db.categoryFindMany).toHaveBeenCalledTimes(1);
    expect(db.categoryFindMany).toHaveBeenCalledWith(expect.objectContaining({ where: { householdId: HOUSEHOLD } }));
    expect(response.categoryMap.find((entry) => entry.key === 'Compras' && entry.type === 'EXPENSE')?.suggestion).toMatchObject({
      kind: 'custom',
      categoryId: 'cat-compras',
    });
  });
});

describe('buildMaxFinWorkbookPreview: size of a preview', () => {
  /** A month tab with `count` debit rows of 10.00. */
  function bigTab(name: string, month: string, count: number): FixtureSheet {
    const debit: Entry[] = Array.from({ length: count }, (_, index) => [`Pix Loja Z ${index}`, 'Compras', 10]);
    return { name, rows: miniTab(title(month), { debit }) };
  }

  const fourMonths = [
    bigTab('JAN', 'janeiro', 1_500),
    bigTab('FEV', 'fevereiro', 1_500),
    bigTab('MAR', 'março', 1_500),
    bigTab('ABR', 'abril', 1_500),
  ];

  it('previews up to 6,000 rows across the selected months', async () => {
    const response = await preview(fourMonths);

    expect(MAX_WORKBOOK_PREVIEW_ROWS).toBe(6_000);
    expect(response.months.map((month) => month.rows.length)).toEqual([1_500, 1_500, 1_500, 1_500]);
  });

  it('leaves the oldest months out of a default selection that holds more rows, with a warning', async () => {
    const sheets = [...fourMonths, bigTab('MAI', 'maio', 1_500)];

    const response = await preview(sheets);

    expect(response.options.months).toEqual(['2026-02', '2026-03', '2026-04', '2026-05']);
    expect(response.sheets.find((sheet) => sheet.name === 'JAN')?.status).toBe('available');
    expect(response.warnings[0]).toContain('janeiro/2026');
  });

  it('asks for fewer months when the months asked for hold more rows, before reading anything stored', async () => {
    const sheets = [...fourMonths, bigTab('MAI', 'maio', 1_500)];
    const all = { options: { months: ['2026-01', '2026-02', '2026-03', '2026-04', '2026-05'] } };

    await expect(preview(sheets, all)).rejects.toEqual(
      badRequest('The selected months hold 7,500 rows, more than one preview returns (6,000); select fewer months.'),
    );
    expect(db.categoryFindMany).not.toHaveBeenCalled();
    expect(db.transactionFindMany).not.toHaveBeenCalled();
    // The same workbook previews fine with fewer months selected.
    expect((await preview(sheets, { options: { months: ['2026-04', '2026-05'] } })).months).toHaveLength(2);
  });

  it('answers 400 fast when one 1 MB text fills the descriptions of six tabs', async () => {
    const huge = 'x'.repeat(1024 * 1024);
    const sheets = ['JAN', 'FEV', 'MAR', 'ABR', 'MAI', 'JUN'].map((name) => ({
      name,
      rows: [['Mês de janeiro de 2026'], HEADER, ...Array.from({ length: 1_990 }, () => ['', huge, '', null, null, null, 1, 1])],
    }));
    const buffer = buildXlsx({ sheets });
    const started = performance.now();

    await expect(preview([], { buffer })).rejects.toEqual(badRequest('has more than 50,000 characters'));
    expect(performance.now() - started).toBeLessThan(1000);
  });

  it('previews long descriptions within the limits quickly', async () => {
    const long = 'y'.repeat(20_000);
    const rows = [[title('outubro')], HEADER, ...Array.from({ length: 200 }, () => ['', long, 'Compras', null, null, null, 1, 1])];
    const started = performance.now();

    const response = await preview([{ name: 'OUT', rows }]);

    expect(response.months[0]?.rows).toHaveLength(200);
    expect(response.months[0]?.rows[0]?.description).toHaveLength(255);
    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('buildMaxFinWorkbookPreview: like the CSV path, and nothing stored', () => {
  it('previews a tab exactly like the CSV export of the same tab, with the same options', async () => {
    const response = await preview([{ name: 'MAR', rows: sampleTab(title('março')) }]);
    const [march] = response.months;
    const resolved = makeAccounts();

    const fromCsv = await buildMaxFinPreview({
      filename: 'FINANCAS_2026.xlsx - MAR.csv',
      buffer: SAMPLE_CSV,
      accounts: idsOf(resolved),
      resolved,
      options: march!.options,
      today: TODAY,
    });

    expect(march).toEqual(fromCsv);
    expect(march?.rows).toHaveLength(18);
  });

  it('classifies each month against what is stored and writes nothing', async () => {
    useStore([{ id: 'old-rent', sourceRef: 'maxfin:2026-01:bills:11', amount: 1300, paid: true, type: 'EXPENSE' }]);

    const response = await preview(YEAR_SHEETS);

    expect(rowNamed(monthOf(response, '2026-01'), 'Aluguel')).toMatchObject({ status: 'duplicate', existingTransactionId: 'old-rent' });
    expect(rowNamed(monthOf(response, '2026-02'), 'Aluguel').status).toBe('new');
    expect(db.createTransaction).not.toHaveBeenCalled();
    expect(db.deleteTransaction).not.toHaveBeenCalled();
    expect(db.payCreditCardInvoice).not.toHaveBeenCalled();
    expect(db.createCategory).not.toHaveBeenCalled();
  });

  it('resolves the destination accounts itself when the caller did not', async () => {
    const resolved = makeAccounts();
    db.accountFindMany.mockResolvedValue([resolved.income, resolved.bills, resolved.credit, resolved.debit]);

    const response = await buildMaxFinWorkbookPreview({
      filename: 'FINANCAS_2026.xlsx',
      buffer: buildXlsx({ sheets: YEAR_SHEETS }),
      accounts: idsOf(resolved),
      today: TODAY,
    });

    expect(db.accountFindMany).toHaveBeenCalledTimes(1);
    expect(response.householdId).toBe(HOUSEHOLD);
  });

  it('warns about a tab cut at the row or column limit', async () => {
    const rows = [...sampleTab(title('outubro')), ...Array.from({ length: 2000 - SAMPLE_GRID.length }, () => []), ['fim']];

    const response = await preview([{ name: 'OUT', rows }]);

    expect(response.warnings).toEqual(['A aba "OUT" tem valores além de 2000 linhas ou 40 colunas; só esse trecho foi lido.']);
    expect(response.sheets[0]).toMatchObject({ status: 'selected', rowCount: 18 });
  });
});
