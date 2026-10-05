import { beforeEach, describe, expect, it, vi } from 'vitest';

import { fakePrisma, fakeServices, resetStore, seedAccount, seedRef, seedSettlement, seedShare, seedTransaction, store, type FakeTransaction } from './__fixtures__/card-ofx-fake-db.js';
import { buildCardOfxPreview, type ResolvedCardAccount } from './card-ofx-import.service.js';
import { applyReviewActions, listReviewQueue, reviewedRef } from './card-ofx-review.service.js';

vi.mock('../../shared/db/prisma.js', async () => ({
  prisma: (await import('./__fixtures__/card-ofx-fake-db.js')).fakePrisma,
}));
vi.mock('./transactions.service.js', async () => {
  const { fakeServices: s } = await import('./__fixtures__/card-ofx-fake-db.js');
  return {
    createTransaction: s.createTransaction,
    deleteTransaction: s.deleteTransaction,
    updateTransaction: s.updateTransaction,
    payCreditCardInvoice: s.payCreditCardInvoice,
    undoCreditCardPayment: s.undoCreditCardPayment,
  };
});
vi.mock('../categories/categories.service.js', async () => ({
  createCategory: (await import('./__fixtures__/card-ofx-fake-db.js')).fakeServices.createCategory,
}));

// Invented data only.
const HH = 'hh-1';
const CARD = 'card-1';
const CASH = 'cash-1';

let card: ResolvedCardAccount;
let rows: Record<'tied' | 'a' | 'b' | 'feb' | 'future', FakeTransaction>;

function sheetRow(month: string, line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}) {
  return seedTransaction({
    householdId: HH,
    accountId: CARD,
    type: 'EXPENSE',
    categoryName: 'OTHER_EXPENSES',
    amount,
    description,
    date: `${month}-01`,
    sourceRef: `maxfin:${month}:credit:${line}`,
    ...extra,
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
  seedAccount({ id: CARD, householdId: HH, name: 'Cartao', type: 'CREDIT', dueDay: 9, closingDay: 2 });
  seedAccount({ id: CASH, householdId: HH, name: 'Carteira', type: 'CHECKING' });
  card = { id: CARD, name: 'Cartao', type: 'CREDIT' as ResolvedCardAccount['type'], householdId: HH, dueDay: 9, closingDay: 2 };
  rows = {
    // January: one row already tied to an OFX line (the statement was imported), two without a bank line.
    tied: sheetRow('2026-01', 1, 'Mercado', 100),
    a: sheetRow('2026-01', 2, 'Cafe da esquina', 12.5),
    b: sheetRow('2026-01', 3, 'Presente', 80),
    // February: no statement imported, so nothing can be said about its rows.
    feb: sheetRow('2026-02', 1, 'Qualquer', 33),
    // A generated future installment is not a sheet row of the month.
    future: sheetRow('2026-01', 9, 'Curso 2/3', 50, { sourceRef: 'maxfin:2026-01:credit:9:f1', date: '2026-02-01' }),
  };
  seedRef({ householdId: HH, transactionId: rows.tied.id, ref: 'ofx:abc:11111111' });
});

describe('listReviewQueue', () => {
  it('lists the sheet rows of statement months that no bank line, merge or review accounts for', async () => {
    const queue = await listReviewQueue({ account: card });

    expect(queue.items.map((i) => [i.description, i.monthKey, i.amount, i.blocked])).toEqual([
      ['Cafe da esquina', '2026-01', 12.5, false],
      ['Presente', '2026-01', 80, false],
    ]);
    expect(queue.months).toEqual([{ monthKey: '2026-01', count: 2, net: 92.5 }]);
    expect(queue.totals).toEqual({ count: 2, net: 92.5 });
    expect(queue.truncated).toBe(false);
  });

  it('cuts at the limit, reporting the totals of the whole queue', async () => {
    const queue = await listReviewQueue({ account: card, limit: 1 });

    expect(queue.items).toHaveLength(1);
    expect(queue).toMatchObject({ truncated: true, totals: { count: 2 } });
  });

  it('filters by month and flags rows that only "keep" may touch', async () => {
    seedShare(rows.b.id);

    const queue = await listReviewQueue({ account: card, monthKey: '2026-01' });

    expect(queue.items.find((i) => i.transactionId === rows.b.id)!.blocked).toBe(true);
    expect((await listReviewQueue({ account: card, monthKey: '2026-02' })).items).toEqual([]);
  });

  it('never lists rows of another household or another card', async () => {
    seedTransaction({ householdId: 'hh-2', accountId: CARD, type: 'EXPENSE', amount: 5, date: '2026-01-01', sourceRef: 'maxfin:2026-01:credit:50' });
    seedTransaction({ householdId: HH, accountId: CASH, type: 'EXPENSE', amount: 5, date: '2026-01-01', sourceRef: 'maxfin:2026-01:credit:51' });

    expect((await listReviewQueue({ account: card })).totals.count).toBe(2);
  });
});

describe('applyReviewActions', () => {
  it('keeps a row without receipt: marks it, takes it out of the queue, and is harmless to repeat', async () => {
    const first = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'keep' }] });
    const again = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'keep' }] });

    expect(first).toMatchObject({ done: 1, skipped: 0 });
    expect(store.refs.filter((r) => r.ref === reviewedRef(rows.a.id))).toHaveLength(1);
    expect(again).toMatchObject({ done: 0, skipped: 1, results: [{ status: 'skipped', reason: 'not-in-queue' }] });
    expect((await listReviewQueue({ account: card })).items.map((i) => i.transactionId)).toEqual([rows.b.id]);
    expect(store.transactions.find((t) => t.id === rows.a.id)).toBeDefined();
  });

  it('a kept row is no longer reported as left over by the next OFX preview', async () => {
    const ofx = Buffer.from(
      [
        'OFXHEADER:100',
        'DATA:OFXSGML',
        'VERSION:102',
        'CHARSET:1252',
        '<OFX>',
        '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
        '<BANKTRANLIST>',
        '<DTSTART>20251203000000[-3:BRT]</DTSTART>',
        '<DTEND>20260102000000[-3:BRT]</DTEND>',
        '<STMTTRN>\n<TRNTYPE>DEBIT</TRNTYPE>\n<DTPOSTED>20260105000000[-3:BRT]</DTPOSTED>\n<TRNAMT>-100.00</TRNAMT>\n<FITID>m1</FITID>\n<MEMO>Mercado</MEMO>\n</STMTTRN>',
        '</BANKTRANLIST>',
        '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
        '</OFX>',
      ].join('\n'),
      'utf8',
    );
    const before = await buildCardOfxPreview({ account: card, buffer: ofx });
    expect(before.sheetOnly.map((r) => r.description).sort()).toEqual(['Cafe da esquina', 'Presente']);

    await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'keep' }] });

    const after = await buildCardOfxPreview({ account: card, buffer: ofx });
    expect(after.sheetOnly.map((r) => r.description)).toEqual(['Presente']);
  });

  it('moves a row to another account through the transaction service, once', async () => {
    const run = () => applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'move', targetAccountId: CASH }] });

    expect(await run()).toMatchObject({ done: 1 });
    expect(fakeServices.updateTransaction).toHaveBeenCalledWith(rows.a.id, HH, { accountId: CASH });
    expect(store.transactions.find((t) => t.id === rows.a.id)!.accountId).toBe(CASH);
    expect(await run()).toMatchObject({ done: 0, skipped: 1 });
    expect(fakeServices.updateTransaction).toHaveBeenCalledTimes(1);
  });

  it('deletes a row through the transaction service, once', async () => {
    const run = () => applyReviewActions({ account: card, actions: [{ transactionId: rows.b.id, action: 'delete' }] });

    expect(await run()).toMatchObject({ done: 1 });
    expect(fakeServices.deleteTransaction).toHaveBeenCalledWith(rows.b.id, HH, { guard: expect.any(Function) });
    expect(store.transactions.find((t) => t.id === rows.b.id)).toBeUndefined();
    expect(await run()).toMatchObject({ done: 0, skipped: 1 });
    expect(fakeServices.deleteTransaction).toHaveBeenCalledTimes(1);
  });

  it('refuses to move or delete a row with shares, but lets it be kept', async () => {
    seedShare(rows.a.id);

    const deleted = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'delete' }] });
    const moved = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'move', targetAccountId: CASH }] });
    const kept = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'keep' }] });

    expect(deleted).toMatchObject({ blocked: 1, done: 0 });
    expect(moved).toMatchObject({ blocked: 1, done: 0 });
    expect(kept).toMatchObject({ done: 1 });
    expect(fakeServices.deleteTransaction).not.toHaveBeenCalled();
    expect(fakeServices.updateTransaction).not.toHaveBeenCalled();
  });

  it('skips ids that are not in the queue (tied rows, other months, other households, unknown) and writes nothing for them', async () => {
    const foreign = seedTransaction({ householdId: 'hh-2', accountId: CARD, type: 'EXPENSE', amount: 5, date: '2026-01-01', sourceRef: 'maxfin:2026-01:credit:60' });
    const ids = [rows.tied.id, rows.feb.id, rows.future.id, foreign.id, 'ffffffff-ffff-4fff-8fff-ffffffffffff'];

    const result = await applyReviewActions({ account: card, actions: ids.map((transactionId) => ({ transactionId, action: 'delete' as const })) });

    expect(result).toMatchObject({ done: 0, skipped: 5 });
    expect(fakeServices.deleteTransaction).not.toHaveBeenCalled();
    expect(store.transactions.find((t) => t.id === foreign.id)).toBeDefined();
  });

  it('answers 400 before any write for a bad destination, a missing destination or a repeated row', async () => {
    const bad = (actions: Parameters<typeof applyReviewActions>[0]['actions'], text: string) =>
      expect(applyReviewActions({ account: card, actions })).rejects.toMatchObject({ statusCode: 400, message: expect.stringContaining(text) });
    seedAccount({ id: 'card-2', householdId: HH, name: 'Outro cartao', type: 'CREDIT' });
    seedAccount({ id: 'other-hh', householdId: 'hh-2', name: 'De fora', type: 'CHECKING' });

    await bad([{ transactionId: rows.a.id, action: 'move' }], 'targetAccountId');
    await bad([{ transactionId: rows.a.id, action: 'move', targetAccountId: 'card-2' }], 'credit card');
    await bad([{ transactionId: rows.a.id, action: 'move', targetAccountId: 'other-hh' }], 'not found');
    await bad([{ transactionId: rows.a.id, action: 'move', targetAccountId: CARD }], 'credit card');
    await bad([{ transactionId: rows.a.id, action: 'keep' }, { transactionId: rows.a.id, action: 'delete' }], 'Duplicate');
    expect(store.refs.some((r) => r.ref.startsWith('reviewed:'))).toBe(false);
  });

  it('counts a row that vanished between the check and the write as skipped', async () => {
    fakeServices.deleteTransaction.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));

    const result = await applyReviewActions({
      account: card,
      actions: [{ transactionId: rows.a.id, action: 'delete' }, { transactionId: rows.b.id, action: 'delete' }],
    });

    expect(result).toMatchObject({ done: 1, skipped: 1, results: [{ status: 'skipped', reason: 'changed-meanwhile' }, { status: 'done' }] });
  });

  it('reports an unexpected error on one row as failed and still tries the others (partial, row by row)', async () => {
    fakeServices.deleteTransaction.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XYZ' }));

    const result = await applyReviewActions({
      account: card,
      actions: [{ transactionId: rows.a.id, action: 'delete' }, { transactionId: rows.b.id, action: 'delete' }],
    });

    expect(result).toMatchObject({ done: 1, failed: 1, results: [{ status: 'failed', reason: 'XYZ' }, { status: 'done' }] });
    expect(store.transactions.find((t) => t.id === rows.a.id)).toBeDefined();
    expect(store.transactions.find((t) => t.id === rows.b.id)).toBeUndefined();
  });

  it('counts a move that lost the claim (409) as skipped', async () => {
    fakeServices.updateTransaction.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'CONFLICT', statusCode: 409 }));

    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'move', targetAccountId: CASH }] });

    expect(result).toMatchObject({ done: 0, skipped: 1, failed: 0, results: [{ reason: 'changed-meanwhile' }] });
    expect(store.transactions.find((t) => t.id === rows.a.id)!.accountId).toBe(CARD);
  });

  it('unkeeps a kept row: the mark goes away and the row is back in the queue', async () => {
    await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'keep' }] });
    expect((await listReviewQueue({ account: card, view: 'kept' })).items.map((i) => i.transactionId)).toEqual([rows.a.id]);

    const first = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'unkeep' }] });
    const again = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'unkeep' }] });

    expect(first).toMatchObject({ done: 1 });
    expect(again).toMatchObject({ done: 0, skipped: 1 });
    expect(store.refs.some((r) => r.ref === reviewedRef(rows.a.id))).toBe(false);
    expect((await listReviewQueue({ account: card })).items.map((i) => i.transactionId)).toEqual([rows.a.id, rows.b.id]);
    expect((await listReviewQueue({ account: card, view: 'kept' })).items).toEqual([]);
  });

  it('only unkeeps rows that carry the reviewed mark', async () => {
    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'unkeep' }, { transactionId: rows.tied.id, action: 'unkeep' }] });

    expect(result).toMatchObject({ done: 0, skipped: 2 });
    expect(store.refs.filter((r) => r.transactionId === rows.tied.id)).toHaveLength(1);
  });

  it('leaves a tombstone anchored on a surviving row of the month when it deletes, and says so', async () => {
    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.b.id, action: 'delete' }] });

    expect(store.refs.find((r) => r.ref === 'deleted:maxfin:2026-01:credit:3')).toMatchObject({ transactionId: rows.tied.id });
    expect(result.warnings).toEqual([expect.stringContaining('não voltam ao reimportar')]);
  });

  it('keeps the tombstone when the row was deleted by someone else meanwhile (the loser of a race)', async () => {
    seedRef({ householdId: HH, transactionId: rows.tied.id, ref: 'deleted:maxfin:2026-01:credit:3' });
    fakeServices.deleteTransaction.mockRejectedValueOnce(Object.assign(new Error('gone'), { code: 'NOT_FOUND' }));

    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.b.id, action: 'delete' }] });

    expect(result).toMatchObject({ skipped: 1, results: [{ reason: 'changed-meanwhile' }] });
    expect(store.refs.filter((r) => r.ref === 'deleted:maxfin:2026-01:credit:3')).toHaveLength(1);
  });

  it('drops the tombstone again when the delete fails', async () => {
    fakeServices.deleteTransaction.mockRejectedValueOnce(Object.assign(new Error('boom'), { code: 'XYZ' }));

    await applyReviewActions({ account: card, actions: [{ transactionId: rows.b.id, action: 'delete' }] });

    expect(store.refs.some((r) => r.ref.startsWith('deleted:'))).toBe(false);
  });

  it('rechecks shares and settlements under the delete transaction: a share added after the check blocks it', async () => {
    fakeServices.deleteTransaction.mockImplementationOnce(async (id: string, _hh: string, options?: { guard?: (tx: unknown) => Promise<void> }) => {
      seedShare(id); // someone shares the row between the queue check and the delete
      await options?.guard?.((await import('./__fixtures__/card-ofx-fake-db.js')).fakePrisma);
      store.transactions = store.transactions.filter((t) => t.id !== id);
    });

    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'delete' }] });

    expect(result).toMatchObject({ blocked: 1, done: 0, results: [{ reason: 'has-shares-or-settlement' }] });
    expect(store.transactions.find((t) => t.id === rows.a.id)).toBeDefined();
    expect(store.refs.some((r) => r.ref.startsWith('deleted:'))).toBe(false);
  });

  it('a settlement blocks the delete the same way', async () => {
    fakeServices.deleteTransaction.mockImplementationOnce(async (id: string, _hh: string, options?: { guard?: (tx: unknown) => Promise<void> }) => {
      seedSettlement(id);
      await options?.guard?.((await import('./__fixtures__/card-ofx-fake-db.js')).fakePrisma);
    });

    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.a.id, action: 'delete' }] });

    expect(result).toMatchObject({ blocked: 1 });
  });

  it('treats only a unique violation as "tombstone already there"; a missing anchor (P2003) means no tombstone, said in the warning', async () => {
    const original = fakePrisma.transactionExternalRef.create.getMockImplementation()!;
    fakePrisma.transactionExternalRef.create.mockImplementationOnce(() => {
      throw Object.assign(new Error('fk'), { code: 'P2003' });
    });

    const result = await applyReviewActions({ account: card, actions: [{ transactionId: rows.b.id, action: 'delete' }] });

    expect(result).toMatchObject({ done: 1, warnings: [expect.stringContaining('reimportar a planilha traz')] });
    expect(store.refs.some((r) => r.ref.startsWith('deleted:'))).toBe(false);
    fakePrisma.transactionExternalRef.create.mockImplementation(original);
  });

  it('fails the row (and tries the rest) when the tombstone write hits an unexpected error, writing no delete', async () => {
    fakePrisma.transactionExternalRef.create.mockImplementationOnce(() => {
      throw Object.assign(new Error('boom'), { code: 'XYZ' });
    });

    const result = await applyReviewActions({
      account: card,
      actions: [{ transactionId: rows.b.id, action: 'delete' }, { transactionId: rows.a.id, action: 'delete' }],
    });

    expect(result).toMatchObject({ failed: 1, done: 1, results: [{ status: 'failed', reason: 'XYZ' }, { status: 'done' }] });
    expect(store.transactions.find((t) => t.id === rows.b.id)).toBeDefined();
  });
});
