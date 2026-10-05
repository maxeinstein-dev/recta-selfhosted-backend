import { beforeEach, describe, expect, it, vi } from 'vitest';

import { AccountType } from '../../shared/enums/index.js';
import { buildXlsx, type FixtureValue } from '../../shared/xlsx/__fixtures__/build-xlsx.js';
import {
  fakePrisma,
  fakeServices,
  resetStore,
  rowById,
  rowsOf,
  seedAccount,
  seedRecurrence,
  seedTransaction,
} from '../recurring-transactions/__fixtures__/recurring-fake-db.js';
import {
  buildMaxFinPreview,
  buildMaxFinWorkbookPreview,
  classifyRow,
  confirmMaxFinImport,
  type MaxFinAccountsResolved,
  type ResolvedAccount,
} from './maxfin-import.service.js';
import { eligibleForRecurring } from './maxfin-recurring.js';
import type {
  MaxFinAccountsInput,
  MaxFinConfirmRequest,
  MaxFinPreviewResponse,
  MaxFinPreviewRow,
} from './maxfin-import.types.js';
import type { MaxFinSectionKey } from './parsers/maxfin.types.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakePrisma,
}));
vi.mock('./transactions.service.js', async () => ({
  createTransaction: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakeServices.createTransaction,
  updateTransaction: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakeServices.updateTransaction,
  deleteTransaction: (await import('../recurring-transactions/__fixtures__/recurring-fake-db.js')).fakeServices.deleteTransaction,
  payCreditCardInvoice: vi.fn(),
}));
vi.mock('../categories/categories.service.js', () => ({ createCategory: vi.fn() }));

// Invented data only.
const HH = 'hh-1';
const TODAY = new Date(2026, 9, 20); // October 2026 is open
const BILLS = 'acc-bills';
const DEBIT = 'acc-debit';
const CREDIT = 'acc-credit';
const INCOME = 'acc-income';

function makeAccounts(): MaxFinAccountsResolved {
  const account = (key: MaxFinSectionKey, extra: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
    id: `acc-${key}`,
    name: `Conta ${key}`,
    type: AccountType.CHECKING,
    householdId: HH,
    dueDay: null,
    closingDay: null,
    ...extra,
  });
  return {
    householdId: HH,
    income: account('income'),
    bills: account('bills'),
    credit: account('credit', { type: AccountType.CREDIT, dueDay: 9, closingDay: 2 }),
    debit: account('debit'),
  };
}

const RESOLVED = makeAccounts();
const IDS: MaxFinAccountsInput = { income: INCOME, bills: BILLS, credit: CREDIT, debit: DEBIT };

type Entry = [description: string, category: string, amount: number];
type Blocks = Partial<Record<MaxFinSectionKey, Entry[]>>;

const HEADER = ['', 'Descrição', 'Categoria', 'Entrada - Previsto ', 'Recebido ', 'À receber', 'Saída - Previsto', 'Realizado ', 'Saldo'];

function tabRows(title: string, blocks: Blocks): FixtureValue[][] {
  const rows: FixtureValue[][] = [[title], [], HEADER];
  for (const [d, c, a] of blocks.income ?? []) rows.push(['', d, c, a, a]);
  for (const key of ['bills', 'credit', 'debit'] as const) {
    for (const [d, c, a] of blocks[key] ?? []) rows.push(['', d, c, null, null, null, a, a]);
    rows.push(['', 'Total']);
  }
  return rows;
}

const money = (n: number) => `"R$ ${n.toFixed(2).replace('.', ',')}"`;

function csvOf(title: string, blocks: Blocks): Buffer {
  const lines = [`"${title}",,,,,,,,,`, ',,,,,,,,,', ',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,'];
  for (const [d, c, a] of blocks.income ?? []) lines.push(`,${d},${c},${money(a)},${money(a)},,,,,`);
  for (const key of ['bills', 'credit', 'debit'] as const) {
    for (const [d, c, a] of blocks[key] ?? []) lines.push(`,${d},${c},,,,${money(a)},${money(a)},,`);
    lines.push(',Total,,,,,,,,');
  }
  return Buffer.from(lines.join('\n'), 'utf8');
}

const TITLE = 'Finanças Teste\nMês de outubro de 2026';
const OCTOBER_BLOCKS: Blocks = { bills: [['Energia', 'Casa', 132.4]] };

function previewCsv(blocks: Blocks = OCTOBER_BLOCKS): Promise<MaxFinPreviewResponse> {
  return buildMaxFinPreview({ filename: 'FINANCAS_2026.xlsx - OUT.csv', buffer: csvOf(TITLE, blocks), accounts: IDS, resolved: RESOLVED, today: TODAY });
}

async function previewWorkbook(blocks: Blocks = OCTOBER_BLOCKS): Promise<MaxFinPreviewResponse> {
  const response = await buildMaxFinWorkbookPreview({
    filename: 'FINANCAS_2026.xlsx',
    buffer: buildXlsx({ sheets: [{ name: 'OUT', rows: tabRows(TITLE, blocks) }] }),
    accounts: IDS,
    resolved: RESOLVED,
    today: TODAY,
  });
  return response.months[0]!;
}

function rowNamed(preview: MaxFinPreviewResponse, description: string, section?: MaxFinSectionKey): MaxFinPreviewRow {
  const found = preview.rows.find((r) => r.description === description && (!section || r.section === section));
  if (!found) throw new Error(`no row "${description}"`);
  return found;
}

function confirmRequest(preview: MaxFinPreviewResponse, replace: boolean | 'omit' = true): MaxFinConfirmRequest {
  return {
    month: { year: 2026, month: 10 },
    accounts: IDS,
    options: preview.options,
    categoryMap: [],
    rows: preview.rows.map((r) => ({
      sourceRef: r.sourceRef,
      section: r.section,
      type: r.type,
      description: r.description,
      categoryKey: r.categoryKey,
      amount: r.amount,
      paid: r.paid,
      date: r.date,
      notes: r.notes,
      installment: r.installment,
      ...(replace === 'omit' ? {} : { replace }),
    })),
  };
}

const confirm = (preview: MaxFinPreviewResponse, replace: boolean | 'omit' = true) =>
  confirmMaxFinImport({ request: confirmRequest(preview, replace), resolved: RESOLVED });

/** A recurrence on the bills account, running in November (the October occurrence was generated or not). */
function energyRecurrence(extra: Partial<Parameters<typeof seedRecurrence>[0]> = {}) {
  return seedRecurrence({ householdId: HH, accountId: BILLS, description: 'Energia', amount: 100, nextRunAt: '2026-11-05', followLastAmount: true, ...extra });
}

function generated(recurringId: string, extra: Partial<Parameters<typeof seedTransaction>[0]> = {}) {
  return seedTransaction({
    householdId: HH,
    accountId: BILLS,
    description: 'Energia',
    amount: 100,
    date: '2026-10-05',
    paid: false,
    recurringTransactionId: recurringId,
    categoryName: 'UTILITIES',
    ...extra,
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  for (const id of [BILLS, DEBIT, CREDIT, INCOME]) seedAccount({ id, householdId: HH, name: id, balance: 1000, type: id === CREDIT ? 'CREDIT' : 'CHECKING' });
});

describe('classifyRow: matches-recurring', () => {
  const row = { amount: 10, paid: true, type: 'EXPENSE' as const, section: 'bills' as const };
  const match = { kind: 'recurrence', transactionId: null, recurringId: 'r', day: '2026-10-05', followLastAmount: true, endDate: null, anchorDay: 5, amount: 100 } as const;

  it('comes after the stored-row and legacy checks and before new', () => {
    expect(classifyRow(row, undefined, [], undefined, match)).toEqual({
      status: 'matches-recurring',
      statusDetail: 'assume a recorrência e adianta a próxima execução',
      existingTransactionId: null,
    });
    expect(classifyRow(row, undefined, [], undefined, undefined).status).toBe('new');
    expect(classifyRow(row, undefined, [], 'legacy-1', match).status).toBe('legacy-duplicate');
    expect(classifyRow(row, undefined, [{ id: 'p', installmentNumber: 2 }], undefined, match).status).toBe('replaces-future');
    expect(classifyRow(row, { id: 'x', amount: 10, paid: true, type: 'EXPENSE' }, [], undefined, match).status).toBe('duplicate');
    expect(classifyRow(row, { id: 'x', amount: 11, paid: true, type: 'EXPENSE' }, [], undefined, match).status).toBe('changed');
  });
});

describe('preview: the sheet takes over a recurrence', () => {
  for (const [label, run] of [
    ['CSV', previewCsv],
    ['workbook', previewWorkbook],
  ] as const) {
    describe(label, () => {
      it('marks the row that matches the generated pending transaction, with its date and id', async () => {
        const rec = energyRecurrence();
        const tx = generated(rec.id);
        const preview = await run();
        expect(rowNamed(preview, 'Energia')).toMatchObject({
          status: 'matches-recurring',
          statusDetail: 'atualiza a transação gerada de 05/10',
          existingTransactionId: tx.id,
        });
        expect(preview.totals).toMatchObject({ matchesRecurring: 1, new: 0, duplicate: 0 });
        expect(preview.sections.find((s) => s.key === 'bills')).toMatchObject({ recurringCount: 1, newCount: 0 });
      });

      it('marks it too when only the recurrence exists and its next run is in the sheet month', async () => {
        energyRecurrence({ nextRunAt: '2026-10-05' });
        const row = rowNamed(await run(), 'Energia');
        expect(row).toMatchObject({
          status: 'matches-recurring',
          statusDetail: 'assume a recorrência e adianta a próxima execução',
          existingTransactionId: null,
        });
      });

      it('is new when no recurrence covers the month, or covers another one', async () => {
        expect(rowNamed(await run(), 'Energia').status).toBe('new');
        energyRecurrence({ nextRunAt: '2026-11-05' });
        expect(rowNamed(await run(), 'Energia').status).toBe('new');
      });
    });
  }

  it('matches the normalized description (accents, case, numbers) but not another account or description', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: BILLS, description: 'ÁGUA 09/2026', amount: 50, nextRunAt: '2026-10-08' });
    generated(rec.id, { description: 'ÁGUA 09/2026', amount: 50 });
    const preview = await previewCsv({
      bills: [['agua', 'Casa', 48.2], ['Água e esgoto', 'Casa', 10]],
      debit: [['Agua', 'Casa', 5]],
    });
    expect(rowNamed(preview, 'agua', 'bills').status).toBe('matches-recurring');
    expect(rowNamed(preview, 'Água e esgoto').status).toBe('new');
    expect(rowNamed(preview, 'Agua', 'debit').status).toBe('new');
  });

  it('only takes plain expenses: not income, not installments', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: CREDIT, description: 'Curso', amount: 100, nextRunAt: '2026-10-05' });
    seedRecurrence({ householdId: HH, accountId: INCOME, description: 'Salario', amount: 100, nextRunAt: '2026-10-05' });
    generated(rec.id, { accountId: CREDIT, description: 'Curso' });
    const preview = await previewCsv({ income: [['Salario', 'Salário', 100]], credit: [['Curso 2/6', 'Educação', 100]] });
    expect(rowNamed(preview, 'Salario').status).toBe('new');
    expect(rowNamed(preview, 'Curso 2/6').status).toBe('new');
  });

  it('takes over a PAID generated occurrence (a card occurrence is generated paid) so the sheet never double-counts', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: CREDIT, description: 'Streaming', amount: 20, nextRunAt: '2026-11-03' });
    const tx = generated(rec.id, { accountId: CREDIT, description: 'Streaming', amount: 20, date: '2026-10-03', paid: true });
    const preview = await previewCsv({ credit: [['Streaming', 'Lazer', 21]] });
    expect(rowNamed(preview, 'Streaming')).toMatchObject({
      status: 'matches-recurring',
      statusDetail: 'atualiza a transação gerada de 03/10',
      existingTransactionId: tx.id,
      existingAmount: 20,
    });
    expect(preview.invoice).toMatchObject({ amount: 21 });
  });

  it('takes over a bill the user already paid by hand, and also a recurrence that only has its next run', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id, { paid: true });
    expect(rowNamed(await previewCsv(), 'Energia')).toMatchObject({ status: 'matches-recurring', existingTransactionId: tx.id, existingAmount: 100 });
    resetStore();
    for (const id of [BILLS, DEBIT, CREDIT, INCOME]) seedAccount({ id, householdId: HH, balance: 0 });
    energyRecurrence({ nextRunAt: '2026-10-05', amount: 90 });
    expect(rowNamed(await previewCsv(), 'Energia')).toMatchObject({ status: 'matches-recurring', existingTransactionId: null, existingAmount: 90 });
  });

  it('existingAmount is null for every other status', async () => {
    const preview = await previewCsv({ bills: [['Energia', 'Casa', 10]], debit: [['Padaria', 'Casa', 5]] });
    expect(preview.rows.map((r) => [r.status, r.existingAmount])).toEqual([['new', null], ['new', null]]);
  });

  it('serves one row per match: the second sheet row with the same name is new', async () => {
    const rec = energyRecurrence();
    generated(rec.id);
    const preview = await previewCsv({ bills: [['Energia', 'Casa', 130], ['Energia', 'Casa', 20]] });
    const statuses = preview.rows.map((r) => r.status);
    expect(statuses).toEqual(['matches-recurring', 'new']);
  });

  it('does not match a transaction an import already took (it has a sourceRef)', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    const taken = generated(rec.id, { paid: false });
    taken.sourceRef = 'maxfin:2026-10:bills:99';
    expect(rowNamed(await previewCsv(), 'Energia').status).toBe('new');
  });

  it('ignores paused, weekly, other-household recurrences and a recurrence that already has its occurrence', async () => {
    energyRecurrence({ nextRunAt: '2026-10-05', isActive: false });
    seedRecurrence({ householdId: HH, accountId: BILLS, description: 'Energia', amount: 100, nextRunAt: '2026-10-05', frequency: 'WEEKLY' });
    seedRecurrence({ householdId: 'hh-2', accountId: BILLS, description: 'Energia', amount: 100, nextRunAt: '2026-10-05' });
    expect(rowNamed(await previewCsv(), 'Energia').status).toBe('new');
    resetStore();
    for (const id of [BILLS, DEBIT, CREDIT, INCOME]) seedAccount({ id, householdId: HH, balance: 0 });
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    seedTransaction({ householdId: HH, accountId: BILLS, description: 'Outra coisa', amount: 1, date: '2026-10-02', recurringTransactionId: rec.id });
    expect(rowNamed(await previewCsv(), 'Energia').status).toBe('new');
  });

  it('keeps the existing precedence: an imported row is a duplicate or changed, never matches-recurring', async () => {
    const rec = energyRecurrence();
    generated(rec.id);
    seedTransaction({ householdId: HH, accountId: BILLS, description: 'Energia', amount: 132.4, date: '2026-10-01', sourceRef: 'maxfin:2026-10:bills:4', paid: true });
    const preview = await previewCsv();
    expect(rowNamed(preview, 'Energia')).toMatchObject({ status: 'duplicate' });
    const changed = await previewCsv({ bills: [['Energia', 'Casa', 140]] });
    expect(rowNamed(changed, 'Energia').status).toBe('changed');
  });

  it('keeps a legacy duplicate ahead of the recurrence', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    expect(rec.id).toBeDefined();
    seedTransaction({ householdId: HH, accountId: BILLS, description: 'Energia', amount: 132.4, date: '2026-10-01', paid: true });
    expect(rowNamed(await previewCsv(), 'Energia').status).toBe('legacy-duplicate');
  });

  it('a legacy duplicate or an imported row does not use up the match of the next row', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    expect(rec.id).toBeDefined();
    seedTransaction({ householdId: HH, accountId: BILLS, description: 'Energia', amount: 132.4, date: '2026-10-01', paid: true });
    const preview = await previewCsv({ bills: [['Energia', 'Casa', 132.4], ['Energia', 'Casa', 20]] });
    expect(preview.rows.map((r) => r.status)).toEqual(['legacy-duplicate', 'matches-recurring']);
  });

  it('eligibleForRecurring: plain expenses outside the income block only', () => {
    const base = { type: 'EXPENSE' as const, section: 'bills' as const, installment: null };
    expect(eligibleForRecurring(base)).toBe(true);
    expect(eligibleForRecurring({ ...base, type: 'INCOME' })).toBe(false);
    expect(eligibleForRecurring({ ...base, section: 'income' })).toBe(false);
    expect(eligibleForRecurring({ ...base, installment: { number: 1, total: 3, prepaid: 0, baseDescription: 'x', installmentId: 'maxfin:x:3', futureCount: 2 } })).toBe(false);
  });

  it('writes nothing', async () => {
    const rec = energyRecurrence();
    generated(rec.id);
    await previewCsv();
    await previewWorkbook();
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
    expect(fakeServices.updateTransaction).not.toHaveBeenCalled();
  });
});

describe('confirm: the sheet takes over', () => {
  it('requires replace: true, like replaces-future: without it the row is skipped with a warning and nothing changes', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id);
    const preview = await previewCsv();
    for (const replace of ['omit', false] as const) {
      const result = await confirm(preview, replace);
      expect(result).toMatchObject({ imported: 0, skipped: 1, assumedRecurring: 0, ids: [] });
      expect(result.warnings.join(' ')).toMatch(/recorrência já cobre/);
    }
    expect(rowById('transaction', tx.id)).toMatchObject({ amount: 100, paid: false, sourceRef: null });
    expect(fakeServices.updateTransaction).not.toHaveBeenCalled();
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
  });

  it('updates the generated transaction in place: value, date, paid and sourceRef, keeping its link, balance consistent', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id);
    const preview = await previewCsv();
    const result = await confirm(preview);
    expect(result).toMatchObject({ imported: 0, skipped: 0, replaced: 0, assumedRecurring: 1, ids: [tx.id] });
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', tx.id)).toMatchObject({
      amount: 132.4,
      date: '2026-10-01',
      paid: true,
      sourceRef: 'maxfin:2026-10:bills:4',
      recurringTransactionId: rec.id,
      description: 'Energia',
    });
    // It was pending: now paid, so the account is debited once, by the real value.
    expect(rowById('account', BILLS).balance).toBe(867.6);
    // A recurrence that follows the last amount predicts the sheet's real value for the next month.
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ amount: 132.4, nextRunAt: '2026-11-05' });
  });

  it('does not change the recurrence amount when it does not follow the last amount', async () => {
    const rec = energyRecurrence({ followLastAmount: false });
    generated(rec.id);
    await confirm(await previewCsv());
    expect(rowById('recurringTransaction', rec.id).amount).toBe(100);
  });

  it('keeps the sheet note on the taken-over transaction', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id);
    const preview = await previewCsv();
    const request = confirmRequest(preview);
    request.rows[0]!.notes = 'previsto R$ 120,00';
    await confirmMaxFinImport({ request, resolved: RESOLVED });
    expect(rowById('transaction', tx.id).notes).toBe('previsto R$ 120,00');
  });

  it('with only the recurrence: creates the row linked to it and moves the recurrence past the month', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    const preview = await previewCsv();
    const result = await confirm(preview);
    expect(result).toMatchObject({ imported: 0, assumedRecurring: 1 });
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowsOf('transaction')[0]).toMatchObject({
      amount: 132.4,
      paid: true,
      date: '2026-10-01',
      sourceRef: 'maxfin:2026-10:bills:4',
      recurringTransactionId: rec.id,
      accountId: BILLS,
    });
    expect(rowById('recurringTransaction', rec.id)).toMatchObject({ lastRunDate: '2026-10-01', nextRunAt: '2026-11-05', amount: 132.4, isActive: true });
    expect(rowById('account', BILLS).balance).toBe(867.6);
  });

  it('moves a recurrence past a short month keeping its day where it fits, and stops one that ended', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-31' });
    await confirm(await previewCsv());
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-11-30');
    resetStore();
    for (const id of [BILLS, DEBIT, CREDIT, INCOME]) seedAccount({ id, householdId: HH, balance: 0 });
    const ending = energyRecurrence({ nextRunAt: '2026-10-05', endDate: '2026-10-31' });
    await confirm(await previewCsv());
    expect(rowById('recurringTransaction', ending.id)).toMatchObject({ isActive: false, nextRunAt: '2026-11-05' });
  });

  it('is idempotent: confirming again takes nothing twice and the recurrence cannot run that month again', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    const preview = await previewCsv();
    await confirm(preview);
    const again = await previewCsv();
    expect(rowNamed(again, 'Energia').status).toBe('duplicate');
    const second = await confirm(preview);
    expect(second).toMatchObject({ assumedRecurring: 0, imported: 0 });
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-11-05');
  });

  it('re-checks at write time: a recurrence that is no longer there lets the row be imported as new', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    const preview = await previewCsv();
    rowById('recurringTransaction', rec.id).isActive = false;
    const result = await confirm(preview);
    expect(result).toMatchObject({ imported: 1, assumedRecurring: 0 });
    expect(rowsOf('transaction')[0]!.recurringTransactionId).toBeNull();
  });

  it('skips the row when another confirm stored its sourceRef first (unique violation)', async () => {
    energyRecurrence({ nextRunAt: '2026-10-05' });
    const preview = await previewCsv();
    fakeServices.createTransaction.mockRejectedValueOnce(Object.assign(new Error('Unique constraint'), { code: 'P2002' }));
    const result = await confirm(preview);
    expect(result).toMatchObject({ assumedRecurring: 0, skipped: 1 });
  });

  it('leaves untouched what is not matched in the same call', async () => {
    const rec = energyRecurrence();
    generated(rec.id);
    const preview = await previewCsv({ bills: [['Energia', 'Casa', 132.4], ['Taxa avulsa', 'Casa', 15]] });
    const result = await confirm(preview);
    expect(result).toMatchObject({ imported: 1, assumedRecurring: 1 });
    expect(rowsOf('transaction').map((t) => t.description).sort()).toEqual(['Energia', 'Taxa avulsa']);
  });

  it('never takes over a recurrence of a row the client forged as another description', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    const preview = await previewCsv({ bills: [['Taxa avulsa', 'Casa', 15]] });
    const result = await confirm(preview);
    expect(result).toMatchObject({ imported: 1, assumedRecurring: 0 });
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-10-05');
  });

  it('the cron cannot duplicate a month the sheet took over', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    await confirm(await previewCsv());
    const { executeRecurringTransaction } = await import('../recurring-transactions/recurring-transactions.service.js');
    // The recurrence already moved on; an extra run for October (a stale cron or a manual execute) is a no-op.
    const result = await executeRecurringTransaction(rec.id, HH, { date: new Date(2026, 9, 20) });
    expect(result.skipped).toBe(true);
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(fakePrisma.recurringTransaction.update).toHaveBeenCalled();
  });
});

describe('confirm: taking over a paid occurrence', () => {
  it('moves the balance only by the difference (paid -> paid) and keeps the link', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id, { paid: true });
    rowById('account', BILLS).balance = 900; // the paid occurrence of 100 was already debited
    const result = await confirm(await previewCsv());
    expect(result).toMatchObject({ imported: 0, assumedRecurring: 1, ids: [tx.id] });
    expect(rowsOf('transaction')).toHaveLength(1);
    expect(rowById('transaction', tx.id)).toMatchObject({ amount: 132.4, paid: true, sourceRef: 'maxfin:2026-10:bills:4', recurringTransactionId: rec.id });
    expect(rowById('account', BILLS).balance).toBe(867.6);
  });

  it('never un-pays an occurrence the app already settled, even if the sheet row is open', async () => {
    const rec = energyRecurrence();
    const tx = generated(rec.id, { paid: true });
    const preview = await previewCsv();
    const request = confirmRequest(preview);
    request.rows[0]!.paid = false;
    await confirmMaxFinImport({ request, resolved: RESOLVED });
    expect(rowById('transaction', tx.id).paid).toBe(true);
  });

  it('takes over a paid card occurrence', async () => {
    const rec = seedRecurrence({ householdId: HH, accountId: CREDIT, description: 'Streaming', amount: 20, nextRunAt: '2026-11-03' });
    const tx = generated(rec.id, { accountId: CREDIT, description: 'Streaming', amount: 20, date: '2026-10-03', paid: true });
    const result = await confirm(await previewCsv({ credit: [['Streaming', 'Lazer', 21]] }));
    expect(result).toMatchObject({ assumedRecurring: 1, imported: 0 });
    expect(rowById('transaction', tx.id)).toMatchObject({ amount: 21, paid: true });
    expect(rowsOf('transaction')).toHaveLength(1);
  });
});

describe('confirm: atomic and anchored', () => {
  it('creating the row and moving the recurrence commit together: a failing move leaves nothing behind', async () => {
    const rec = energyRecurrence({ nextRunAt: '2026-10-05' });
    fakePrisma.recurringTransaction.update.mockRejectedValueOnce(new Error('boom'));
    await expect(confirm(await previewCsv())).rejects.toThrow('boom');
    expect(rowsOf('transaction')).toEqual([]);
    expect(rowById('account', BILLS).balance).toBe(1000);
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-10-05');
    expect(fakePrisma.$queryRaw).toHaveBeenCalled();
  });

  it('returns to the anchor day after a short month', async () => {
    // Anchored on the 31st, currently clamped to the 30th of a 30-day month.
    const rec = energyRecurrence({ nextRunAt: '2026-10-30', startDate: '2026-07-31' });
    await confirm(await previewCsv());
    expect(rowById('recurringTransaction', rec.id).nextRunAt).toBe('2026-11-30');
    resetStore();
    for (const id of [BILLS, DEBIT, CREDIT, INCOME]) seedAccount({ id, householdId: HH, balance: 0 });
    const jan = energyRecurrence({ nextRunAt: '2026-10-28', startDate: '2026-07-31' });
    await confirm(await previewCsv());
    expect(rowById('recurringTransaction', jan.id).nextRunAt).toBe('2026-11-30');
  });
});
