import { beforeEach, describe, expect, it, vi } from 'vitest';

import { buildMaxFinPreview, confirmMaxFinImport } from './maxfin-import.service.js';
import type {
  MaxFinConfirmResponse,
  MaxFinConfirmRow,
  MaxFinPreviewResponse,
  MaxFinRealignDecision,
  MaxFinRealignProposal,
} from './maxfin-import.types.js';
import { FakeTables, idsOf, makeAccounts, sheetCsv, type SheetRow, type SheetSpec } from './__fixtures__/maxfin-shift.js';

const holder = vi.hoisted(() => ({
  client: null as any,
  createTransaction: vi.fn(),
  deleteTransaction: vi.fn(),
}));

vi.mock('../../shared/db/prisma.js', () => ({
  get prisma() {
    return holder.client;
  },
}));
vi.mock('./transactions.service.js', () => ({
  createTransaction: holder.createTransaction,
  deleteTransaction: holder.deleteTransaction,
  payCreditCardInvoice: vi.fn(),
}));
vi.mock('../categories/categories.service.js', () => ({ createCategory: vi.fn() }));
vi.mock('./maxfin-recurring.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('./maxfin-recurring.js')>()),
  loadRecurringMatcher: async () => ({ take: () => undefined }),
}));

const TODAY = new Date(2026, 10, 11);
const KEY = '2026-10';
const OPEN_OPTIONS = { closedMonth: false, payInvoice: false, generateFutureInstallments: false };

const CREDIT: SheetRow[] = [
  ['Padaria Alfa', 10],
  ['Mercado Beta', 20],
  ['Farmacia Gama', 30],
  ['Posto Delta', 40],
  ['Cinema Epsilon', 50],
  ['Livraria Zeta', 60],
];
const DEBIT: SheetRow[] = [
  ['Luz Eta', 110],
  ['Agua Teta', 120],
  ['Gas Iota', 130],
  ['Net Kappa', 140],
];
// Rows inserted in the card block also move the lines of every block below it, so the main scenarios keep the debit block empty.
const ORIGINAL: SheetSpec = { credit: CREDIT };

let tables: FakeTables;
let txSeq = 0;

beforeEach(() => {
  tables = new FakeTables();
  txSeq = 0;
  const client = tables.client() as any;
  client.account = { findMany: async () => [] };
  client.category = { findMany: async () => [] };
  holder.client = client;
  holder.createTransaction.mockReset();
  holder.deleteTransaction.mockReset();
  // The write functions behave like the real ones for what matters here: the unique sourceRef, and the row stored.
  holder.createTransaction.mockImplementation(async (input: any) => {
    if (input.sourceRef && tables.txs.some((t) => t.sourceRef === input.sourceRef)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const tx = tables.addTx({
      id: `new-${++txSeq}`,
      accountId: input.accountId,
      sourceRef: input.sourceRef ?? null,
      type: input.type,
      amount: input.amount,
      description: input.description,
      notes: input.notes ?? null,
    });
    return { id: tx.id };
  });
  holder.deleteTransaction.mockImplementation(async (id: string) => {
    tables.txs = tables.txs.filter((t) => t.id !== id);
  });
});

function preview(spec: SheetSpec): Promise<MaxFinPreviewResponse> {
  const accounts = makeAccounts();
  return buildMaxFinPreview({
    filename: 'FINANCAS - OUT.csv',
    buffer: sheetCsv(spec),
    accounts: idsOf(accounts),
    resolved: accounts,
    today: TODAY,
  });
}

const ACCOUNT_OF = { income: 'acc-income', bills: 'acc-bills', credit: 'acc-credit', debit: 'acc-debit' } as const;

/** What the first import stored: the rows of the original sheet, one transaction per row. */
async function storeImport(spec: SheetSpec = ORIGINAL): Promise<void> {
  const first = await preview(spec);
  for (const row of first.rows) {
    tables.addTx({
      id: `tx-${row.section}-${row.sourceLine}`,
      accountId: ACCOUNT_OF[row.section],
      sourceRef: row.sourceRef,
      description: row.description,
      amount: row.amount,
      type: row.type,
    });
  }
}

const refOfLine = (section: string, line: number) => `maxfin:${KEY}:${section}:${line}`;
const sectionRows = (p: MaxFinPreviewResponse, section: string) => p.rows.filter((r) => r.section === section);
const byId = (): Record<string, string | null> => Object.fromEntries(tables.txs.map((t) => [t.id, t.sourceRef]));
const snapshot = () => JSON.stringify({ txs: tables.txs, refs: tables.refs });
/** Everything about the stored rows except the reference (and the write counter). */
const withoutRefs = () => JSON.stringify(tables.txs.map(({ sourceRef: _ref, updatedAt: _u, ...rest }) => rest));

function decisionsOf(proposals: MaxFinRealignProposal[], apply: boolean | ((p: MaxFinRealignProposal) => boolean) = true): MaxFinRealignDecision[] {
  return proposals.map((p) => ({
    id: p.id,
    apply: typeof apply === 'function' ? apply(p) : apply,
    section: p.section,
    shift: p.shift,
    moves: p.moves.map(({ transactionId, from, to, sheetLine, verified, sheet }) => ({ transactionId, from, to, sheetLine, verified, sheet })),
    removed: p.removed.map(({ transactionId, from, to }) => ({ transactionId, from, to })),
    requires: p.requires,
  }));
}

function toConfirmRow(r: MaxFinPreviewResponse['rows'][number], replace?: boolean): MaxFinConfirmRow {
  return {
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
    ...(replace ? { replace: true } : {}),
  };
}

/** The rows a current client sends: the ones left ticked by default (new), without replace. */
const newRows = (p: MaxFinPreviewResponse): MaxFinConfirmRow[] => p.rows.filter((r) => r.status === 'new').map((r) => toConfirmRow(r));

function confirm(rows: MaxFinConfirmRow[], realignments?: MaxFinRealignDecision[]): Promise<MaxFinConfirmResponse> {
  const accounts = makeAccounts();
  return confirmMaxFinImport({
    request: {
      month: { year: 2026, month: 10 },
      accounts: idsOf(accounts),
      options: OPEN_OPTIONS,
      categoryMap: [],
      rows,
      ...(realignments ? { realignments } : {}),
    },
    userId: 'user-1',
    resolved: accounts,
  });
}

const insertAt = (rows: SheetRow[], index: number, row: SheetRow): SheetRow[] => [...rows.slice(0, index), row, ...rows.slice(index)];
const TWO_INSERTIONS: SheetRow[] = [CREDIT[0]!, CREDIT[1]!, ['Uber Novo', 15], CREDIT[2]!, CREDIT[3]!, ['Taxi Novo', 16], CREDIT[4]!, CREDIT[5]!];

describe('buildMaxFinPreview: rows the sheet shifted', () => {
  it('proposes a realignment for a row inserted in the middle instead of "changed" rows', async () => {
    await storeImport();
    const result = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });

    expect(sectionRows(result, 'credit').map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'new', 'shifted', 'shifted', 'shifted', 'shifted']);
    expect(result.totals.changed).toBe(0);
    expect(result.realignments).toHaveLength(1);
    const [proposal] = result.realignments;
    expect(proposal).toMatchObject({ section: 'credit', shift: 1, kind: 'insertion', defaultSelected: true, ambiguous: false, requires: [] });
    expect(proposal!.moves.map((m) => [m.from, m.to])).toEqual([
      [refOfLine('credit', 13), refOfLine('credit', 14)],
      [refOfLine('credit', 14), refOfLine('credit', 15)],
      [refOfLine('credit', 15), refOfLine('credit', 16)],
      [refOfLine('credit', 16), refOfLine('credit', 17)],
    ]);
    expect(proposal!.insertedRefs).toEqual([refOfLine('credit', 13)]);
    expect(result.warnings.some((w) => w.includes('Realinhar'))).toBe(true);
    // The shifted rows are tied to the stored purchase they are.
    expect(sectionRows(result, 'credit')[3]).toMatchObject({ description: 'Farmacia Gama', existingTransactionId: 'tx-credit-13' });
  });

  it('proposes it for a row inserted at the start of the block', async () => {
    await storeImport();
    const result = await preview({ credit: [['Uber Novo', 15], ...CREDIT] });
    expect(result.realignments.map((p) => [p.section, p.shift, p.moves.length])).toEqual([['credit', 1, 6]]);
    expect(sectionRows(result, 'credit').map((r) => r.status)).toEqual(['new', 'shifted', 'shifted', 'shifted', 'shifted', 'shifted', 'shifted']);
  });

  it('proposes it for the debit block too, and a row inserted above moves the blocks below it, each with its own proposal', async () => {
    await storeImport({ credit: CREDIT, debit: DEBIT });
    const inDebit = await preview({ credit: CREDIT, debit: insertAt(DEBIT, 1, ['Gas Novo', 99]) });
    expect(inDebit.realignments.map((p) => [p.section, p.shift, p.moves.length])).toEqual([['debit', 1, 3]]);

    const inCredit = await preview({ credit: insertAt(CREDIT, 2, ['Uber Novo', 15]), debit: DEBIT });
    expect(inCredit.realignments.map((p) => [p.section, p.shift, p.moves.length])).toEqual([
      ['credit', 1, 4],
      ['debit', 1, 4],
    ]);
  });

  it('proposes a removal: shift -1, the removed purchase named', async () => {
    await storeImport();
    const result = await preview({ ...ORIGINAL, credit: CREDIT.filter((r) => r[0] !== 'Farmacia Gama') });
    const [proposal] = result.realignments;
    expect(proposal).toMatchObject({ shift: -1, kind: 'removal' });
    expect(proposal!.removed).toEqual([
      { transactionId: 'tx-credit-13', from: refOfLine('credit', 13), to: refOfLine('credit', 16), description: 'Farmacia Gama', amount: 30 },
    ]);
    expect(sectionRows(result, 'credit').map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'shifted', 'shifted', 'shifted']);
  });

  it('proposes nothing when the sheet did not change, nor for a row appended at the end', async () => {
    await storeImport();
    expect((await preview(ORIGINAL)).realignments).toEqual([]);
    const appended = await preview({ ...ORIGINAL, credit: [...CREDIT, ['Uber Novo', 15]] });
    expect(appended.realignments).toEqual([]);
    expect(sectionRows(appended, 'credit').map((r) => r.status)).toEqual(['duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'duplicate', 'new']);
  });

  it('leaves a plain change of an amount as "changed"', async () => {
    await storeImport();
    const result = await preview({ ...ORIGINAL, credit: CREDIT.map((r): SheetRow => (r[0] === 'Posto Delta' ? ['Posto Delta', 41] : r)) });
    expect(result.realignments).toEqual([]);
    expect(sectionRows(result, 'credit').filter((r) => r.status === 'changed')).toHaveLength(1);
  });

  it('comes unticked when the inserted row is equal to its neighbour (ambiguous)', async () => {
    await storeImport();
    const result = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Mercado Beta', 20]) });
    expect(result.realignments).toHaveLength(1);
    expect(result.realignments[0]).toMatchObject({ ambiguous: true, defaultSelected: false });
    expect(result.realignments[0]!.reason).toBeTruthy();
    expect(result.warnings.some((w) => w.includes('desmarcado'))).toBe(true);
  });

  it('does not mix months: stored rows of another month on the same lines are never moved', async () => {
    await storeImport();
    tables.addTx({ id: 'other-month', accountId: 'acc-credit', sourceRef: 'maxfin:2026-09:credit:14', description: 'Posto Delta', amount: 40 });
    const result = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    expect(result.realignments[0]!.moves.map((m) => m.transactionId)).not.toContain('other-month');
  });

  it('moves a purchase the card statement reconciled (bank description and amount) by the note it left', async () => {
    await storeImport();
    const linked = tables.txs.find((t) => t.id === 'tx-credit-14')!;
    Object.assign(linked, { description: 'POSTO DELTA SP', amount: 39.9, notes: 'Planilha: Posto Delta 40,00' });
    tables.addRef(linked.id, 'ofx:abc:11111111');
    const result = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    expect(result.realignments[0]!.moves.every((m) => m.verified)).toBe(true);
    expect(sectionRows(result, 'credit').filter((r) => r.status === 'shifted')).toHaveLength(4);
  });
});

describe('confirmMaxFinImport: applying a realignment', () => {
  it('changes only the sourceRef of the moved purchases, then imports the inserted row on the line it freed', async () => {
    await storeImport();
    const linked = tables.txs.find((t) => t.id === 'tx-credit-14')!;
    Object.assign(linked, { description: 'POSTO DELTA SP', amount: 39.9, notes: 'Planilha: Posto Delta 40,00' });
    tables.addRef(linked.id, 'ofx:abc:11111111');
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const before = withoutRefs();
    const refsBefore = JSON.stringify(tables.refs);

    const result = await confirm(newRows(p), decisionsOf(p.realignments));

    expect(result).toMatchObject({ imported: 1, realigned: 4, replaced: 0 });
    expect(result.realignments).toEqual([{ id: p.realignments[0]!.id, status: 'applied', moved: 4, reason: null }]);
    // Values, descriptions, notes, categories, dates: untouched (the inserted row is the only new transaction).
    expect(withoutRefs().startsWith(before.slice(0, -1))).toBe(true);
    expect(JSON.stringify(tables.refs)).toBe(refsBefore);
    expect(byId()).toMatchObject({
      'tx-credit-11': refOfLine('credit', 11),
      'tx-credit-12': refOfLine('credit', 12),
      'tx-credit-13': refOfLine('credit', 14),
      'tx-credit-14': refOfLine('credit', 15),
      'tx-credit-15': refOfLine('credit', 16),
      'tx-credit-16': refOfLine('credit', 17),
      'new-1': refOfLine('credit', 13),
    });
    expect(holder.deleteTransaction).not.toHaveBeenCalled();
    expect(holder.createTransaction).toHaveBeenCalledTimes(1);
    expect(holder.createTransaction.mock.calls[0]![0]).toMatchObject({ description: 'Uber Novo', amount: 15, sourceRef: refOfLine('credit', 13) });
  });

  it('is idempotent: the same sheet afterwards has no proposal and no change, and the same decision again does nothing', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    await confirm(newRows(p), decisionsOf(p.realignments));
    const after = snapshot();

    const again = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    expect(again.realignments).toEqual([]);
    expect(again.rows.every((r) => r.status === 'duplicate')).toBe(true);

    // A stale tab sends the decision of the first preview again.
    const repeat = await confirm([], decisionsOf(p.realignments));
    expect(repeat).toMatchObject({ imported: 0, realigned: 0 });
    expect(repeat.realignments[0]).toMatchObject({ status: 'already-applied', moved: 0 });
    expect(snapshot()).toBe(after);
  });

  it('applies a realignment with no rows to import (removal) and parks the removed purchase on the vacated line', async () => {
    await storeImport();
    const removed = { ...ORIGINAL, credit: CREDIT.filter((r) => r[0] !== 'Farmacia Gama') };
    const p = await preview(removed);
    const result = await confirm([], decisionsOf(p.realignments));

    expect(result).toMatchObject({ imported: 0, realigned: 4 });
    expect(byId()).toMatchObject({
      'tx-credit-14': refOfLine('credit', 13),
      'tx-credit-15': refOfLine('credit', 14),
      'tx-credit-16': refOfLine('credit', 15),
      'tx-credit-13': refOfLine('credit', 16),
    });
    expect(tables.txs.find((t) => t.id === 'tx-credit-13')).toMatchObject({ description: 'Farmacia Gama', amount: 30 });
    expect((await preview(removed)).realignments).toEqual([]);
  });

  it('chains two insertions in one confirm (the temporary references let the blocks land on each other)', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: TWO_INSERTIONS });
    expect(p.realignments.map((r) => r.shift)).toEqual([1, 2]);

    const result = await confirm(newRows(p), decisionsOf(p.realignments));

    expect(result).toMatchObject({ imported: 2, realigned: 4 });
    expect(Object.fromEntries(Object.entries(tables.bySection(KEY, 'credit')).map(([ref, d]) => [ref.split(':').pop(), d]))).toEqual({
      '11': 'Padaria Alfa',
      '12': 'Mercado Beta',
      '13': 'Uber Novo',
      '14': 'Farmacia Gama',
      '15': 'Posto Delta',
      '16': 'Taxi Novo',
      '17': 'Cinema Epsilon',
      '18': 'Livraria Zeta',
    });
    expect((await preview({ ...ORIGINAL, credit: TWO_INSERTIONS })).realignments).toEqual([]);
  });

  it('writes in two phases (temporary references) under the household and month lock and the row locks in id order', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    await confirm(newRows(p), decisionsOf(p.realignments));

    expect(tables.rawLog[0]).toMatch(/pg_advisory_xact_lock/);
    expect(tables.rawLog.some((sql) => /FROM transactions WHERE id IN \(.*\) ORDER BY id FOR UPDATE/.test(sql))).toBe(true);
    expect(tables.updateLog.slice(0, 4).every((entry) => entry.endsWith(':mv'))).toBe(true);
    expect(tables.updateLog.slice(4, 8).every((entry) => !entry.endsWith(':mv'))).toBe(true);
  });

  it('moves the generated future installments and the references of absorbed rows with the block', async () => {
    await storeImport();
    // Posto Delta (line 14) was merged into Farmacia Gama (line 13) by the card statement import: the row that stayed
    // has the bank data and a note with the first absorbed row, and only an external reference remembers line 14.
    tables.txs = tables.txs.filter((t) => t.id !== 'tx-credit-14');
    Object.assign(tables.txs.find((t) => t.id === 'tx-credit-13')!, {
      description: 'FARMACIA SP',
      amount: 70,
      notes: 'Planilha (soma de 2 linhas): Farmacia Gama 30,00; Posto Delta 40,00',
    });
    tables.addRef('tx-credit-13', refOfLine('credit', 14));
    tables.addTx({ id: 'future-1', accountId: 'acc-credit', sourceRef: `${refOfLine('credit', 15)}:f1`, description: 'Cinema Epsilon 2/3', amount: 50 });
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    expect(p.realignments).toHaveLength(1);
    expect(p.realignments[0]!.moves.map((m) => m.verified)).toEqual([true, true, true]);

    await confirm(newRows(p), decisionsOf(p.realignments));

    expect(tables.refOf('future-1')).toBe(`${refOfLine('credit', 16)}:f1`);
    expect(tables.refOf('tx-credit-13')).toBe(refOfLine('credit', 14));
    expect(tables.refs.map((r) => r.ref)).toEqual([refOfLine('credit', 15)]);
    expect(tables.txs.find((t) => t.id === 'tx-credit-13')).toMatchObject({ description: 'FARMACIA SP', amount: 70 });
  });
});

describe('confirmMaxFinImport: a realignment left pending', () => {
  it('changes nothing when the block is unticked, and says it stayed pending', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const before = snapshot();

    const result = await confirm(newRows(p), decisionsOf(p.realignments, false));

    expect(snapshot()).toBe(before);
    expect(result.realignments).toEqual([expect.objectContaining({ status: 'declined', moved: 0 })]);
    expect(result.warnings.some((w) => /pendentes/.test(w))).toBe(true);
    // The inserted row found its line still occupied and was skipped, not imported over the neighbour.
    expect(result).toMatchObject({ imported: 0, replaced: 0, realigned: 0 });
    expect(holder.createTransaction).not.toHaveBeenCalled();
    expect(holder.deleteTransaction).not.toHaveBeenCalled();
  });

  it('never replaces the rows of an unticked block, even when the client asks for replace', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const before = snapshot();
    const asked = p.rows.filter((r) => r.section === 'credit' && ['shifted', 'new'].includes(r.status)).map((r) => toConfirmRow(r, true));
    expect(asked).toHaveLength(5);

    const result = await confirm(asked, decisionsOf(p.realignments, false));

    expect(snapshot()).toBe(before);
    expect(result).toMatchObject({ imported: 0, replaced: 0, skipped: 5 });
    expect(holder.deleteTransaction).not.toHaveBeenCalled();
    expect(holder.createTransaction).not.toHaveBeenCalled();
  });

  it('never replaces the rows of a block the client did not decide on (a client that predates realignments)', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const before = snapshot();
    // What an old client would send for the cascade: every row of the block (lines 13-16) as "replace".
    const cascade = p.rows.filter((r) => r.section === 'credit' && r.sourceLine >= 13 && r.sourceLine <= 16).map((r) => toConfirmRow(r, true));
    expect(cascade).toHaveLength(4);

    const result = await confirm(cascade);

    expect(snapshot()).toBe(before);
    expect(result).toMatchObject({ replaced: 0, imported: 0, skipped: 4 });
    expect(result.warnings.filter((w) => /deslocada/.test(w))).toHaveLength(4);
    expect(holder.deleteTransaction).not.toHaveBeenCalled();
  });

  it('skips a block whose required block was not applied', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: TWO_INSERTIONS });
    const before = snapshot();

    const result = await confirm([], decisionsOf(p.realignments, (r) => r.shift === 1));

    expect(snapshot()).toBe(before);
    expect(result.realignments.map((o) => o.status)).toEqual(['skipped', 'declined']);
  });

  it('refuses the block when a stored purchase changed since the preview, and moves nothing', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    tables.txs.find((t) => t.id === 'tx-credit-15')!.description = 'Editado depois da previa';
    const before = snapshot();

    const result = await confirm([], decisionsOf(p.realignments));

    expect(snapshot()).toBe(before);
    expect(result.realignments[0]).toMatchObject({ status: 'skipped', moved: 0 });
    expect(result.realignments[0]!.reason).toMatch(/já não corresponde/);
  });

  it('undoes every move when a line is taken meanwhile (unique violation), and skips the block', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const originalUpdate = holder.client.transaction.update;
    let writes = 0;
    holder.client.transaction.update = async (args: any) => {
      writes += 1;
      // The 7th write is in the second phase: someone else holds the line.
      if (writes === 7) throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
      return originalUpdate(args);
    };
    const before = snapshot();

    const result = await confirm([], decisionsOf(p.realignments));

    expect(snapshot()).toBe(before);
    expect(result.realignments[0]).toMatchObject({ status: 'skipped', moved: 0 });
    expect(result.realigned).toBe(0);
  });

  it('rejects a tampered decision (a shift that does not fit its references, or another month) before any write', async () => {
    await storeImport();
    const p = await preview({ ...ORIGINAL, credit: insertAt(CREDIT, 2, ['Uber Novo', 15]) });
    const good = decisionsOf(p.realignments);
    const before = snapshot();

    const wrongShift = structuredClone(good);
    wrongShift[0]!.shift = 2;
    await expect(confirm([], wrongShift)).rejects.toMatchObject({ statusCode: 400 });

    const otherMonth = structuredClone(good);
    otherMonth[0]!.moves[0]!.to = 'maxfin:2026-09:credit:14';
    await expect(confirm([], otherMonth)).rejects.toMatchObject({ statusCode: 400 });

    expect(snapshot()).toBe(before);
  });
});
