import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakePrisma,
  fakeServices,
  resetStore,
  seedAccount,
  seedRef,
  seedShare,
  seedTransaction,
  store,
  type FakeTransaction,
} from './__fixtures__/card-ofx-fake-db.js';
import {
  buildCardOfxPreview,
  confirmCardOfxImport,
  formatBRL,
  futureInstallmentMemo,
  invoiceMonthFromStatement,
  isOfxFutureRef,
  joinNotes,
  paymentProposal,
  resolveCardAccount,
  validateConfirmLines,
  type ResolvedCardAccount,
} from './card-ofx-import.service.js';
import type { CardOfxConfirmRequest, CardOfxPreviewResponse, CardOfxProposal } from './card-ofx-import.types.js';
import type { MaxFinCategoryMapInput } from './maxfin-import.types.js';

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

// Invented data only: stores, amounts and ids below are fictitious.

const HH = 'hh-1';
const CARD = 'card-1';
const BANK = 'bank-1';

interface Trn {
  fitid: string;
  /** YYYYMMDD */
  date: string;
  amount: string;
  memo: string;
}

function ofx(trns: Trn[], opts: { start?: string; end?: string; balance?: string } = {}): Buffer {
  const body = trns
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE>\n<DTPOSTED>${t.date}000000[-3:BRT]</DTPOSTED>\n` +
        `<TRNAMT>${t.amount}</TRNAMT>\n<FITID>${t.fitid}</FITID>\n<MEMO>${t.memo}</MEMO>\n</STMTTRN>`,
    )
    .join('\n');
  const text = [
    'OFXHEADER:100',
    'DATA:OFXSGML',
    'VERSION:102',
    'CHARSET:1252',
    '<OFX>',
    '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>',
    '<BANKTRANLIST>',
    `<DTSTART>${opts.start ?? '20260902'}000000[-3:BRT]</DTSTART>`,
    `<DTEND>${opts.end ?? '20261002'}000000[-3:BRT]</DTEND>`,
    body,
    '</BANKTRANLIST>',
    ...(opts.balance ? [`<LEDGERBAL><BALAMT>${opts.balance}</BALAMT></LEDGERBAL>`] : []),
    '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
    '</OFX>',
  ].join('\n');
  return Buffer.from(text, 'utf8');
}

function seedCard(overrides: Partial<Parameters<typeof seedAccount>[0]> = {}): ResolvedCardAccount {
  const card = seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: 2, ...overrides });
  seedAccount({ id: BANK, householdId: HH, name: 'Conta Teste', type: 'CHECKING' });
  return {
    id: card.id,
    name: card.name,
    type: 'CREDIT' as ResolvedCardAccount['type'],
    householdId: HH,
    dueDay: card.dueDay,
    closingDay: card.closingDay,
  };
}

/** A card row the monthly sheet imported for October (day 01, sourceRef of its sheet line). */
function seedSheetRow(line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}): FakeTransaction {
  return seedTransaction({
    householdId: HH,
    accountId: CARD,
    type: 'EXPENSE',
    categoryName: 'OTHER_EXPENSES',
    amount,
    description,
    date: '2026-10-01',
    sourceRef: `maxfin:2026-10:credit:${line}`,
    ...extra,
  });
}

function tx(id: string): FakeTransaction {
  const found = store.transactions.find((t) => t.id === id);
  if (!found) throw new Error(`transaction ${id} not found`);
  return found;
}

function refsOf(transactionId: string): string[] {
  return store.refs.filter((r) => r.transactionId === transactionId).map((r) => r.ref).sort();
}

function proposal(preview: CardOfxPreviewResponse, kind: CardOfxProposal['kind'], index = 0): CardOfxProposal {
  const found = preview.proposals.filter((p) => p.kind === kind)[index];
  if (!found) throw new Error(`no ${kind} proposal #${index}`);
  return found;
}

/** The map the dialog sends back: each suggestion accepted as is. */
function acceptedMap(preview: CardOfxPreviewResponse): MaxFinCategoryMapInput[] {
  return preview.categoryMap.map((entry) => {
    const s = entry.suggestion;
    const target: MaxFinCategoryMapInput['target'] =
      s.kind === 'system'
        ? { kind: 'system', categoryName: s.categoryName! }
        : s.kind === 'custom'
          ? { kind: 'custom', categoryId: s.categoryId! }
          : s.kind === 'create'
            ? { kind: 'create', name: s.name! }
            : { kind: 'default' };
    return { key: entry.key, type: entry.type, target };
  });
}

function confirmRequest(preview: CardOfxPreviewResponse, overrides: Partial<CardOfxConfirmRequest> = {}): CardOfxConfirmRequest {
  return {
    accountId: preview.accountId,
    monthKey: preview.monthKey,
    lines: preview.lines.map(({ status: _status, group: _group, ...line }) => line),
    selectedGroups: preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group),
    categoryMap: acceptedMap(preview),
    payment: { apply: true },
    ...overrides,
  };
}

function isBadRequest(message: string | RegExp) {
  return expect.objectContaining({
    statusCode: 400,
    message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message),
  });
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

// ---------------------------------------------------------------------------
// October: a month the sheet already imported
// ---------------------------------------------------------------------------

const OCTOBER: Trn[] = [
  { fitid: 'fit-mkt', date: '20260920', amount: '-123.45', memo: 'Mercado Zeta' },
  { fitid: 'fit-alfa', date: '20260902', amount: '-100.00', memo: 'Curso Alfa - Parcela 2/4' },
  { fitid: 'fit-alfa', date: '20260927', amount: '-100.00', memo: 'Curso Alfa - Parcela 3/4' },
  { fitid: 'fit-alfa', date: '20260927', amount: '-100.00', memo: 'Curso Alfa - Parcela 4/4' },
  { fitid: 'fit-alfa', date: '20260927', amount: '10.00', memo: 'Desconto Antecipação Curso Alfa' },
  { fitid: 'fit-f1', date: '20260905', amount: '-95.00', memo: 'Posto Lambda' },
  { fitid: 'fit-f2', date: '20260912', amount: '-110.00', memo: 'Posto Lambda' },
  { fitid: 'fit-f3', date: '20260919', amount: '-70.00', memo: 'Posto Lambda' },
  { fitid: 'fit-s1', date: '20260906', amount: '-38.00', memo: 'Pastelaria Sigma' },
  { fitid: 'fit-s2', date: '20260906', amount: '-9.00', memo: 'Pastelaria Sigma' },
  { fitid: 'fit-new', date: '20260925', amount: '-40.00', memo: 'Livraria Nova' },
  { fitid: 'fit-mu', date: '20260908', amount: '-149.90', memo: 'Loja Mu' },
  { fitid: 'fit-mu', date: '20260929', amount: '149.90', memo: 'Estorno de "Loja Mu" (Loja Mu)' },
  { fitid: 'fit-pay', date: '20260903', amount: '1500.00', memo: 'Pagamento recebido' },
];

describe('card OFX import: a month that has sheet rows', () => {
  let card: ResolvedCardAccount;
  let rows: Record<'market' | 'plan' | 'fuel' | 'snack' | 'gift', FakeTransaction>;
  let recordedPayment: FakeTransaction;

  beforeEach(() => {
    card = seedCard();
    rows = {
      market: seedSheetRow(10, 'Mercado', 123.45, { categoryName: 'GROCERIES' }),
      plan: seedSheetRow(11, 'Curso Alfa 2/4 +2', 290, {
        installmentId: 'maxfin:curso-alfa:4',
        installmentNumber: 2,
        totalInstallments: 4,
        notes: 'antecipou 2 parcelas (3..4)',
      }),
      fuel: seedSheetRow(12, 'Combustivel', 275, { categoryName: 'FUEL' }),
      snack: seedSheetRow(13, 'Pastelaria', 47, { categoryName: 'RESTAURANT' }),
      gift: seedSheetRow(14, 'Presente', 77),
    };
    // A future installment the October sheet generated for November: neither a sheet row of October nor a match.
    seedSheetRow(15, 'Curso Beta 5/6', 60, {
      date: '2026-11-01',
      sourceRef: 'maxfin:2026-10:credit:15:f1',
      installmentId: 'maxfin:curso-beta:6',
      installmentNumber: 5,
      totalInstallments: 6,
    });
    // The sheet covers August too, so September purchases are not history the sheet never saw.
    seedSheetRow(1, 'Compra de agosto', 10, { date: '2026-08-01', sourceRef: 'maxfin:2026-08:credit:1' });
    // September's invoice payment, recorded by the sheet import on the due day with the sheet total.
    recordedPayment = seedTransaction({
      householdId: HH,
      accountId: BANK,
      type: 'EXPENSE',
      amount: 1499,
      date: '2026-09-09',
      description: 'Pagamento de fatura - 09/2026 (importação)',
      attachmentUrl: 'invoice_pay:card-1:2026-8',
    });
    // History: the last purchase at this merchant had a category.
    seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 30, date: '2026-08-10', description: 'Livraria Nova', categoryName: 'EDUCATION', sourceRef: 'ofx:old:00000000' });
  });

  it('previews the reconciliation without writing anything', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview).toMatchObject({
      accountId: CARD,
      householdId: HH,
      month: { year: 2026, month: 10 },
      monthKey: '2026-10',
      monthSource: 'statement',
      period: { start: '2026-09-02', end: '2026-10-02' },
      // Purchases 935.35 minus the discount (10.00) and the refund (149.90); the payment is left out.
      ofxTotal: 775.45,
      totals: { lines: 14, reconciled: 0, proposals: 6, create: 1, sheetOnly: 1 },
    });
    expect(preview.proposals.map((p) => [p.kind, p.defaultSelected, p.target?.description ?? null])).toEqual([
      ['enrich-plan', true, 'Curso Alfa 2/4 +2'],
      ['enrich-exact', true, 'Mercado'],
      ['enrich-sum', true, 'Pastelaria'],
      ['enrich-sum', true, 'Combustivel'],
      ['reversal', false, null],
      ['create', false, null],
    ]);
    expect(preview.sheetOnly).toEqual([
      { transactionId: rows.gift.id, description: 'Presente', amount: 77, type: 'EXPENSE', date: '2026-10-01', sourceRef: 'maxfin:2026-10:credit:14' },
    ]);
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
    expect(fakePrisma.transaction.update).not.toHaveBeenCalled();
    expect(fakePrisma.transactionExternalRef.createMany).not.toHaveBeenCalled();
    expect(store.refs).toEqual([]);
  });

  it('describes targets and results the way the dialog shows them', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(proposal(preview, 'enrich-exact')).toMatchObject({
      target: { transactionId: rows.market.id, description: 'Mercado', amount: 123.45, type: 'EXPENSE', date: '2026-10-01' },
      result: { date: '2026-09-20', description: 'Mercado Zeta', notesAppend: 'Planilha: Mercado' },
      futureInstallments: 0,
    });
    expect(proposal(preview, 'enrich-plan')).toMatchObject({
      target: { transactionId: rows.plan.id },
      result: { date: '2026-09-02', description: 'Curso Alfa 2/4 +2' },
    });
    const lineOf = (memo: string) => preview.lines.find((l) => l.memo === memo)!;
    expect(lineOf('Mercado Zeta')).toMatchObject({ status: 'proposed', group: proposal(preview, 'enrich-exact').group, kind: 'purchase' });
    expect(lineOf('Pagamento recebido')).toMatchObject({ status: 'payment', group: null, kind: 'payment', type: 'INCOME' });
  });

  it('proposes adjusting the recorded payment of the previous invoice', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview.payment).toEqual({
      ref: preview.lines.find((l) => l.kind === 'payment')!.ref,
      amount: 1500,
      date: '2026-09-03',
      invoiceMonthKey: '2026-09',
      recorded: { transactionId: recordedPayment.id, amount: 1499, date: '2026-09-09', sourceAccountId: BANK },
      proposal: 'adjust',
    });
  });

  it('maps the merchants of new purchases, suggesting the category of their last purchase', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview.categoryMap).toEqual([
      expect.objectContaining({
        key: 'Livraria Nova',
        type: 'EXPENSE',
        count: 1,
        sections: ['credit'],
        suggestion: expect.objectContaining({ kind: 'system', categoryName: 'EDUCATION' }),
      }),
    ]);
  });

  it('warns about the leftovers on both sides, since new purchases come unselected in a sheet month', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview.warnings).toEqual([
      expect.stringContaining('sobram linhas da planilha'),
      expect.stringContaining('Sobram R$ 77,00 na planilha e R$ 40,00 no OFX'),
    ]);
  });

  it('reports the statement closing: the OFX total against the card in the OFX period, explained', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const { closing } = preview;
    expect(closing).toMatchObject({ periodStart: '2026-09-02', periodEnd: '2026-10-02', ofxTotal: preview.ofxTotal, explained: true });
    const c = closing.components;
    // delta = uncreated + heldMatches - sheetOnlyInPeriod - foreignInPeriod + residual, to the cent.
    expect(Math.round(closing.delta * 100)).toBe(
      Math.round((c.uncreated + c.heldMatches - c.sheetOnlyInPeriod - c.foreignInPeriod + c.residual) * 100),
    );
    // The new purchase (40,00) is held back and the sheet row without a bank line (77,00) stays in the card.
    expect(c).toMatchObject({ uncreated: expect.any(Number), sheetOnlyInPeriod: 77 });
  });

  it('applies the selected groups, records every ref and adjusts the payment', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const create = proposal(preview, 'create');

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, {
        selectedGroups: [...preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group), create.group],
      }),
      account: card,
      userId: 'user-1',
    });

    expect(result).toEqual({
      enriched: 4,
      absorbedRows: 0,
      consumedFutures: 0,
      created: 1,
      futureInstallments: 0,
      reversalsImported: 0,
      advancePayments: 0,
      payment: { action: 'adjusted', transactionId: expect.any(String), amount: 1500, date: '2026-09-03' },
      skipped: 0,
      createdCategories: [],
      warnings: [],
    });

    // One-to-one: bank date and memo, the sheet text in the notes.
    expect(tx(rows.market.id)).toMatchObject({ date: '2026-09-20', description: 'Mercado Zeta', notes: 'Planilha: Mercado', categoryName: 'GROCERIES' });
    // Plan: sheet description kept, first line's date, the lines appended to the existing notes.
    expect(tx(rows.plan.id)).toMatchObject({ date: '2026-09-02', description: 'Curso Alfa 2/4 +2' });
    expect(tx(rows.plan.id).notes).toBe(
      'antecipou 2 parcelas (3..4) · OFX: 02/09 Curso Alfa - Parcela 2/4 -100,00; 27/09 Curso Alfa - Parcela 3/4 -100,00; ' +
        '27/09 Curso Alfa - Parcela 4/4 -100,00; 27/09 Desconto Antecipação Curso Alfa +10,00',
    );
    expect(refsOf(rows.plan.id)).toHaveLength(4);
    expect(tx(rows.fuel.id)).toMatchObject({ date: '2026-09-05', description: 'Combustivel' });
    expect(refsOf(rows.fuel.id)).toHaveLength(3);
    expect(refsOf(rows.snack.id)).toHaveLength(2);
    expect(tx(rows.gift.id)).toMatchObject({ date: '2026-10-01', description: 'Presente', notes: null });

    // The new purchase: card expense, category from the map, ref as sourceRef and recorded.
    const createdTx = store.transactions.find((t) => t.description === 'Livraria Nova' && t.date === '2026-09-25')!;
    expect(createdTx).toMatchObject({ accountId: CARD, type: 'EXPENSE', amount: 40, categoryName: 'EDUCATION', paid: true, sourceRef: create.refs[0] });
    expect(refsOf(createdTx.id)).toEqual(create.refs);
    expect(fakeServices.createTransaction).toHaveBeenCalledWith(expect.objectContaining({ householdId: HH }), 'user-1');

    // Payment: undone and paid again from the same account, with the bank's amount and date.
    expect(fakeServices.undoCreditCardPayment).toHaveBeenCalledWith({ accountId: CARD, transactionId: recordedPayment.id }, HH);
    expect(fakeServices.payCreditCardInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ householdId: HH, accountId: CARD, sourceAccountId: BANK, month: '2026-09', amount: 1500 }),
    );
    const payments = store.transactions.filter((t) => t.attachmentUrl === 'invoice_pay:card-1:2026-8');
    expect(payments).toEqual([expect.objectContaining({ amount: 1500, date: '2026-09-03', accountId: BANK, description: recordedPayment.description })]);
  });

  it('keeps paid the card purchases the payment undo marks unpaid outside the invoice it pays', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    await confirmCardOfxImport({ request: confirmRequest(preview), account: card });

    // The fuel row now carries 05/09: after September's period (02/08..01/09), before the old payment date (09/09).
    expect(tx(rows.fuel.id)).toMatchObject({ date: '2026-09-05', paid: true });
    expect(store.transactions.filter((t) => t.accountId === CARD && !t.paid)).toEqual([]);
  });

  it('shows everything reconciled when the same invoice comes again, and applies nothing twice', async () => {
    const first = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const everything = first.proposals.map((p) => p.group);
    await confirmCardOfxImport({ request: confirmRequest(first, { selectedGroups: everything }), account: card });
    const snapshot = JSON.stringify(store);

    const again = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(again.lines.filter((l) => l.status !== 'payment').every((l) => l.status === 'reconciled')).toBe(true);
    expect(again.proposals).toEqual([]);
    expect(again.totals).toMatchObject({ reconciled: 13, proposals: 0, create: 0, sheetOnly: 1 });
    expect(again.payment?.proposal).toBe('ok');

    const repeat = await confirmCardOfxImport({ request: confirmRequest(first, { selectedGroups: everything }), account: card });

    expect(repeat).toMatchObject({ enriched: 0, created: 0, reversalsImported: 0, payment: null, skipped: everything.length });
    expect(JSON.stringify(store)).toBe(snapshot);
  });

  it('imports a selected reversal pair as both transactions, counting transactions', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'reversal').group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ reversalsImported: 2, created: 0, enriched: 0 });
    expect(store.transactions.filter((t) => t.description?.includes('Loja Mu')).map((t) => [t.type, t.amount, t.categoryName])).toEqual([
      ['EXPENSE', 149.9, 'OTHER_EXPENSES'],
      ['INCOME', 149.9, 'OTHER_INCOME'],
    ]);
  });

  it('skips selected groups that no longer exist when the confirm recomputes', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    // Meanwhile the user deleted the sheet row of the market and another confirm reconciled the snack lines.
    store.transactions = store.transactions.filter((t) => t.id !== rows.market.id);
    const snackRefs = preview.proposals.find((p) => p.target?.transactionId === rows.snack.id)!.refs;
    seedRef({ householdId: HH, transactionId: rows.snack.id, ref: snackRefs[0]! });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 2, skipped: 2 });
    expect(tx(rows.snack.id).description).toBe('Pastelaria');
  });

  it('counts a group as skipped when another confirm records one of its refs first (P2002)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const exact = proposal(preview, 'enrich-exact');
    fakePrisma.transactionExternalRef.createMany.mockImplementationOnce(() => {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [exact.group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(tx(rows.market.id)).toMatchObject({ description: 'Mercado', date: '2026-10-01' });
  });

  it('skips a group whose sheet row was deleted after the recompute', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const exact = proposal(preview, 'enrich-exact');
    // The row disappears between the recompute and the write: the refs' foreign key fails first.
    fakePrisma.$transaction.mockImplementationOnce(async (operations: Array<{ exec: () => Promise<unknown> }>) => {
      store.transactions = store.transactions.filter((t) => t.id !== rows.market.id);
      for (const operation of operations) await operation.exec();
      return [];
    });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [exact.group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(store.refs).toEqual([]);
  });

  it('writes nothing of a group when its update fails (refs and update share one transaction)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    fakePrisma.transaction.update.mockImplementationOnce(() => {
      throw new Error('connection lost');
    });

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'enrich-plan').group], payment: null }), account: card }),
    ).rejects.toThrow('connection lost');
    expect(store.refs).toEqual([]);
  });

  it('does not create a category the selected groups do not use', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, {
        selectedGroups: [proposal(preview, 'enrich-exact').group],
        categoryMap: [{ key: 'Livraria Nova', type: 'EXPENSE', target: { kind: 'create', name: 'Livros' } }],
        payment: null,
      }),
      account: card,
    });

    expect(result.createdCategories).toEqual([]);
    expect(store.categories).toEqual([]);
  });

  it('creates the categories the map asks for when a new purchase uses them', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, {
        selectedGroups: [proposal(preview, 'create').group],
        categoryMap: [{ key: '  LIVRARIA   nóva ', type: 'EXPENSE', target: { kind: 'create', name: 'Livros' } }],
        payment: null,
      }),
      account: card,
    });

    expect(result.createdCategories).toEqual([{ id: expect.any(String), name: 'Livros', type: 'EXPENSE' }]);
    const created = store.transactions.find((t) => t.description === 'Livraria Nova' && t.date === '2026-09-25')!;
    expect(created.categoryName).toBe(`CUSTOM:${result.createdCategories[0]!.id}`);
  });

  it('enriches an installment one cent off the bank (same N/M), keeping the sheet amount', async () => {
    const row = seedSheetRow(20, 'Loja Pi 3/10', 33.33, { installmentId: 'maxfin:loja-pi:10', installmentNumber: 3, totalInstallments: 10 });
    const invoice = ofx([...OCTOBER, { fitid: 'fit-pi', date: '20260914', amount: '-33.34', memo: 'Loja Pi - Parcela 3/10' }]);
    const preview = await buildCardOfxPreview({ account: card, buffer: invoice });
    const exact = preview.proposals.find((p) => p.target?.transactionId === row.id)!;
    expect(exact).toMatchObject({ kind: 'enrich-exact', defaultSelected: true, target: { amount: 33.33 } });

    await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [exact.group], payment: null }), account: card });

    expect(tx(row.id)).toMatchObject({ amount: 33.33, date: '2026-09-14', description: 'Loja Pi - Parcela 3/10', notes: 'Planilha: Loja Pi 3/10' });
    expect(refsOf(row.id)).toEqual(exact.refs);
  });

  const PAYMENT_ID = 'invoice_pay:card-1:2026-8';
  const P2002 = () => Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });

  it('puts the recorded payment back, with its flags, when paying again fails after the undo', async () => {
    seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 20, date: '2026-08-20', description: 'Compra antiga', paid: true });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    fakeServices.payCreditCardInvoice.mockRejectedValueOnce(new Error('db down'));

    await expect(confirmCardOfxImport({ request: confirmRequest(preview), account: card })).rejects.toThrow('db down');

    const payments = store.transactions.filter((t) => t.attachmentUrl === PAYMENT_ID);
    expect(payments.map((t) => [t.amount, t.date, t.accountId, t.description])).toEqual([
      [1499, '2026-09-09', BANK, recordedPayment.description],
    ]);
    expect(store.transactions.filter((t) => t.accountId === CARD && !t.paid)).toEqual([]);
  });

  it('puts back the payments already undone when a later undo fails (several recorded payments)', async () => {
    seedAccount({ id: 'savings-1', householdId: HH, type: 'SAVINGS' });
    seedTransaction({ householdId: HH, accountId: 'savings-1', type: 'EXPENSE', amount: 500, date: '2026-09-05', description: 'Parte', attachmentUrl: PAYMENT_ID });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const real = fakeServices.undoCreditCardPayment.getMockImplementation()!;
    fakeServices.undoCreditCardPayment.mockImplementationOnce(real).mockRejectedValueOnce(new Error('undo failed'));

    await expect(confirmCardOfxImport({ request: confirmRequest(preview), account: card })).rejects.toThrow('undo failed');

    const payments = store.transactions
      .filter((t) => t.attachmentUrl === PAYMENT_ID)
      .map((t) => [t.amount, t.date, t.accountId])
      .sort((a, b) => String(a[1]).localeCompare(String(b[1])));
    expect(payments).toEqual([
      [500, '2026-09-05', 'savings-1'],
      [1499, '2026-09-09', BANK],
    ]);
  });

  it('says so when the recorded payment itself cannot be put back', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    fakeServices.payCreditCardInvoice.mockRejectedValueOnce(new Error('db down')).mockRejectedValueOnce(new Error('still down'));

    await expect(confirmCardOfxImport({ request: confirmRequest(preview), account: card })).rejects.toThrow(
      /db down.*could not be put back \(still down\)/,
    );
  });

  it('warns, in the preview and the confirm, when an adjust joins payments of different accounts', async () => {
    seedAccount({ id: 'savings-1', householdId: HH, type: 'SAVINGS' });
    seedTransaction({ householdId: HH, accountId: 'savings-1', type: 'EXPENSE', amount: 500, date: '2026-09-05', description: 'Parte', attachmentUrl: PAYMENT_ID });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card });

    expect(preview.warnings).toContainEqual(expect.stringContaining('2 contas diferentes'));
    expect(result.warnings).toContainEqual(expect.stringContaining('2 contas diferentes'));
    expect(store.transactions.filter((t) => t.attachmentUrl === PAYMENT_ID)).toHaveLength(1);
  });

  it('does not warn about accounts when the recorded payments share one', async () => {
    seedTransaction({ householdId: HH, accountId: BANK, type: 'EXPENSE', amount: 500, date: '2026-09-05', description: 'Parte', attachmentUrl: PAYMENT_ID });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview.warnings.some((w) => w.includes('contas diferentes'))).toBe(false);
  });

  it('skips a new purchase whose sourceRef another confirm created first (P2002 on the transaction)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    fakeServices.createTransaction.mockRejectedValueOnce(P2002());

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'create').group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(store.transactions.some((t) => t.description === 'Livraria Nova' && t.date === '2026-09-25')).toBe(false);
    expect(store.refs).toEqual([]);
  });

  it('removes the transaction it just created when its ref was reconciled elsewhere meanwhile (P2002 on the ref)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    fakePrisma.transactionExternalRef.create.mockImplementationOnce(() => {
      throw P2002();
    });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'create').group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ created: 0, skipped: 1 });
    expect(fakeServices.deleteTransaction).toHaveBeenCalledTimes(1);
    expect(store.transactions.some((t) => t.description === 'Livraria Nova' && t.date === '2026-09-25')).toBe(false);
    expect(store.refs).toEqual([]);
  });

  it('records the refs of legacy lines even when another confirm recorded one meanwhile (skipDuplicates)', async () => {
    const legacy = seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 40, date: '2026-09-25', description: 'Livraria Nova' });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const line = preview.lines.find((l) => l.memo === 'Livraria Nova')!;
    const real = fakePrisma.transactionExternalRef.createMany.getMockImplementation()!;
    fakePrisma.transactionExternalRef.createMany.mockImplementationOnce((args) => {
      seedRef({ householdId: HH, transactionId: legacy.id, ref: line.ref }); // the other confirm got there first
      return real(args);
    });

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [], payment: null }), account: card }),
    ).resolves.toMatchObject({ skipped: 0 });

    expect(refsOf(legacy.id)).toEqual([line.ref]);
  });

  it('records the other legacy refs when one legacy transaction was deleted meanwhile', async () => {
    const kept = seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 40, date: '2026-09-25', description: 'Livraria Nova' });
    const gone = seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 149.9, date: '2026-09-08', description: 'Loja Mu' });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const real = fakePrisma.transactionExternalRef.createMany.getMockImplementation()!;
    fakePrisma.transactionExternalRef.createMany.mockImplementationOnce((args) => {
      store.transactions = store.transactions.filter((t) => t.id !== gone.id);
      return real(args);
    });

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [], payment: null }), account: card }),
    ).resolves.toBeDefined();

    expect(refsOf(kept.id)).toHaveLength(1);
    expect(store.refs).toHaveLength(1);
  });

  it('records the refs of lines the generic importer already stored', async () => {
    const legacy = seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 40, date: '2026-09-25', description: 'Livraria Nova' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const line = preview.lines.find((l) => l.memo === 'Livraria Nova')!;
    expect(line.status).toBe('reconciled');

    await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [], payment: null }), account: card });

    expect(refsOf(legacy.id)).toEqual([line.ref]);
  });

  it('leaves the payment alone when the payment decision is not to apply', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: { apply: false } }), account: card });

    expect(result.payment).toBeNull();
    expect(fakeServices.undoCreditCardPayment).not.toHaveBeenCalled();
    expect(fakeServices.payCreditCardInvoice).not.toHaveBeenCalled();
  });

  it('reports no source account for an adjust whose recorded account can no longer pay, and says so', async () => {
    store.accounts.find((a) => a.id === BANK)!.isActive = false;

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(preview.payment).toMatchObject({ proposal: 'adjust', recorded: { transactionId: recordedPayment.id, sourceAccountId: null } });
    expect(preview.warnings).toContainEqual(expect.stringContaining('escolha a conta de origem para o ajuste'));
  });

  it.each<[string, () => void]>([
    ['was deleted (no account on the payment)', () => {
      recordedPayment.accountId = null;
    }],
    ['is inactive', () => {
      store.accounts.find((a) => a.id === BANK)!.isActive = false;
    }],
  ])('answers 400 before any write when the recorded account %s and the request names none', async (_label, breakIt) => {
    breakIt();
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    await expect(confirmCardOfxImport({ request: confirmRequest(preview), account: card })).rejects.toEqual(
      isBadRequest('payment.sourceAccountId is required'),
    );
    expect(fakeServices.undoCreditCardPayment).not.toHaveBeenCalled();
    expect(fakePrisma.transaction.update).not.toHaveBeenCalled();
    expect(store.refs).toEqual([]);
  });

  it('adjusts from the request account when the recorded payment has none', async () => {
    recordedPayment.accountId = null;
    seedAccount({ id: 'savings-1', householdId: HH, type: 'SAVINGS' });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: 'savings-1' } }),
      account: card,
    });

    expect(result.payment).toMatchObject({ action: 'adjusted', amount: 1500 });
    expect(fakeServices.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: 'savings-1' }));
  });

  it('adjusts from the recorded payment account even when the request names another one', async () => {
    seedAccount({ id: 'savings-1', householdId: HH, type: 'SAVINGS' });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    await confirmCardOfxImport({
      request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: 'savings-1' } }),
      account: card,
    });

    expect(fakeServices.payCreditCardInvoice).toHaveBeenCalledWith(expect.objectContaining({ sourceAccountId: BANK }));
  });

  it('echoes reconciled and payment lines harmlessly: they never become transactions', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const echoed = confirmRequest(preview, { selectedGroups: [], payment: null });
    expect(echoed.lines).toHaveLength(OCTOBER.length);

    const result = await confirmCardOfxImport({ request: echoed, account: card });

    expect(result).toMatchObject({ enriched: 0, created: 0, reversalsImported: 0, payment: null, skipped: 0 });
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
    expect(store.refs).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// November: a month without sheet rows
// ---------------------------------------------------------------------------

const NOVEMBER: Trn[] = [
  { fitid: 'fit-new', date: '20261105', amount: '-70.00', memo: 'Loja Nova - Parcela 1/3' },
  { fitid: 'fit-a', date: '20261103', amount: '-50.00', memo: 'Loja Alfa - Parcela 4/10' },
  { fitid: 'fit-b', date: '20261102', amount: '-30.00', memo: 'Curso Beta - Parcela 5/6' },
  { fitid: 'fit-b', date: '20261127', amount: '-30.00', memo: 'Curso Beta - Parcela 6/6' },
  { fitid: 'fit-b', date: '20261127', amount: '2.00', memo: 'Desconto Antecipação Curso Beta' },
  { fitid: 'fit-pay', date: '20261008', amount: '980.00', memo: 'Pagamento recebido' },
];

describe('card OFX import: a month without sheet rows', () => {
  let card: ResolvedCardAccount;
  let futures: Record<'a4' | 'b5' | 'b6', FakeTransaction>;

  beforeEach(() => {
    card = seedCard();
    const future = (id: string, description: string, n: number, total: number, amount: number, date: string, paid = true) =>
      seedTransaction({
        id,
        householdId: HH,
        accountId: CARD,
        type: 'EXPENSE',
        categoryName: 'EDUCATION',
        amount,
        description,
        date,
        paid,
        notes: `parcela futura gerada na importação de "${description}"`,
        sourceRef: `maxfin:2026-10:credit:${n}${total}:f1`,
        installmentId: `maxfin:${description.split(' ')[0]!.toLowerCase()}:${total}`,
        installmentNumber: n,
        totalInstallments: total,
      });
    futures = {
      a4: future('fut-a4', 'Loja A 4/10', 4, 10, 50, '2026-11-01'),
      b5: future('fut-b5', 'Curso B 5/6', 5, 6, 30, '2026-11-01'),
      b6: future('fut-b6', 'Curso B 6/6', 6, 6, 30, '2026-12-01'),
    };
  });

  const NOV_OFX = () => ofx(NOVEMBER, { start: '20261002', end: '20261102' });

  it('selects new purchases by default and plans their future installments', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });

    expect(preview.monthKey).toBe('2026-11');
    const creates = preview.proposals.filter((p) => p.kind === 'create');
    expect(creates.map((p) => [p.defaultSelected, p.futureInstallments, p.refs.length])).toEqual([
      [true, 2, 1], // Loja Nova 1/3: installments 2 and 3 to come
      [true, 0, 1], // the prepayment discount of Curso Beta
    ]);
    expect(preview.warnings).toEqual([]);
    expect(preview.payment).toMatchObject({ proposal: 'create', recorded: null, invoiceMonthKey: '2026-10' });
  });

  it('consumes stored futures one by one and through a prepayment', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });

    expect(preview.proposals.filter((p) => p.kind === 'consume-future').map((p) => p.target?.transactionId)).toEqual([
      'fut-a4',
      'fut-b5',
      'fut-b6',
    ]);
  });

  it('confirms: creates with futures, consumes the stored futures and records the payment', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: BANK } }),
      account: card,
      userId: 'user-1',
    });

    expect(result).toMatchObject({ consumedFutures: 3, created: 2, futureInstallments: 2, enriched: 0, skipped: 0 });
    expect(result.payment).toEqual({ action: 'created', transactionId: expect.any(String), amount: 980, date: '2026-10-08' });
    expect(fakeServices.payCreditCardInvoice).toHaveBeenCalledWith(
      expect.objectContaining({ sourceAccountId: BANK, month: '2026-10', amount: 980, description: 'Pagamento de fatura - 10/2026 (OFX)' }),
    );

    const newLine = preview.lines.find((l) => l.memo === 'Loja Nova - Parcela 1/3')!;
    const plan = store.transactions
      .filter((t) => t.installmentId === 'ofx:fit-new')
      .map((t) => [t.installmentNumber, t.date, t.description, t.sourceRef, t.amount] as const)
      .sort((a, b) => a[0]! - b[0]!);
    expect(plan).toEqual([
      [1, '2026-11-05', 'Loja Nova - Parcela 1/3', newLine.ref, 70],
      [2, '2026-12-01', 'Loja Nova - Parcela 2/3', `${newLine.ref}:f1`, 70],
      [3, '2027-01-01', 'Loja Nova - Parcela 3/3', `${newLine.ref}:f2`, 70],
    ]);

    expect(tx('fut-a4')).toMatchObject({
      date: '2026-11-03',
      description: 'Loja Alfa - Parcela 4/10',
      paid: true,
      notes: 'parcela futura gerada na importação de "Loja A 4/10" · Parcela futura: Loja A 4/10',
      categoryName: 'EDUCATION',
    });
    expect(tx('fut-b6')).toMatchObject({ date: '2026-11-27', description: 'Curso Beta - Parcela 6/6' });
    const discount = store.transactions.find((t) => t.description === 'Desconto Antecipação Curso Beta')!;
    expect(discount).toMatchObject({ type: 'INCOME', amount: 2, categoryName: 'OTHER_INCOME', installmentId: null });
  });

  it('gives a consumed future the bank amount through the transaction service (the card balance moves)', async () => {
    tx('fut-a4').amount = 49.99; // one cent off: still the same installment
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }),
      account: card,
    });

    expect(result.consumedFutures).toBe(1);
    expect(fakeServices.updateTransaction).toHaveBeenCalledWith('fut-a4', HH, expect.objectContaining({ amount: 50, paid: true }));
    expect(tx('fut-a4')).toMatchObject({ amount: 50, date: '2026-11-03', description: 'Loja Alfa - Parcela 4/10' });
    expect(refsOf('fut-a4')).toEqual(consume.refs);
  });

  it('counts a consumed future as skipped, and drops its refs, when the transaction service answers 409', async () => {
    tx('fut-a4').amount = 49.99;
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;
    fakeServices.updateTransaction.mockRejectedValueOnce(Object.assign(new Error('changed'), { code: 'CONFLICT', statusCode: 409 }));

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ consumedFutures: 0, skipped: 1 });
    expect(refsOf('fut-a4')).toEqual([]);
    expect(tx('fut-a4').amount).toBe(49.99);
  });

  it('rewrites a consumed future in one database transaction when amount and paid flag already match', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;

    await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }), account: card });

    expect(fakeServices.updateTransaction).not.toHaveBeenCalled();
    expect(fakePrisma.$transaction).toHaveBeenCalledTimes(1);
    expect(tx('fut-a4')).toMatchObject({ amount: 50, date: '2026-11-03' });
  });

  it('skips the group, and drops its refs, when the future was deleted after the claim', async () => {
    tx('fut-a4').paid = false;
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;
    fakeServices.updateTransaction.mockRejectedValueOnce(Object.assign(new Error('Transaction not found'), { statusCode: 404, code: 'NOT_FOUND' }));

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }),
      account: card,
    });

    expect(result).toMatchObject({ consumedFutures: 0, skipped: 1 });
    expect(store.refs).toEqual([]);
  });

  const storedPlan = () =>
    store.transactions
      .filter((t) => t.installmentId === 'ofx:fit-new')
      .map((t) => t.installmentNumber)
      .sort();

  it('regenerates the missing future installments when a failure stops the creation halfway', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const create = preview.proposals.find((p) => p.kind === 'create' && p.futureInstallments === 2)!;
    const real = fakeServices.createTransaction.getMockImplementation()!;
    fakeServices.createTransaction.mockImplementationOnce(real).mockRejectedValueOnce(new Error('db blip')); // future 2, then future 3 fails

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [create.group], payment: null }), account: card }),
    ).rejects.toThrow('db blip');
    expect(storedPlan()).toEqual([2]); // the line is not there, so its group still exists

    const retry = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const again = retry.proposals.find((p) => p.kind === 'create' && p.refs.includes(create.refs[0]!))!;
    expect(again.futureInstallments).toBe(1);
    const result = await confirmCardOfxImport({ request: confirmRequest(retry, { selectedGroups: [again.group], payment: null }), account: card });

    expect(result).toMatchObject({ created: 1, futureInstallments: 1 });
    expect(storedPlan()).toEqual([1, 2, 3]);
  });

  it('does not duplicate the future installments when only the line failed', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const create = preview.proposals.find((p) => p.kind === 'create' && p.futureInstallments === 2)!;
    const real = fakeServices.createTransaction.getMockImplementation()!;
    fakeServices.createTransaction
      .mockImplementationOnce(real)
      .mockImplementationOnce(real)
      .mockRejectedValueOnce(new Error('db blip')); // both futures stored, the line fails

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [create.group], payment: null }), account: card }),
    ).rejects.toThrow('db blip');
    expect(storedPlan()).toEqual([2, 3]);

    const retry = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const again = retry.proposals.find((p) => p.kind === 'create' && p.refs.includes(create.refs[0]!))!;
    expect(again.futureInstallments).toBe(0);
    await confirmCardOfxImport({ request: confirmRequest(retry, { selectedGroups: [again.group], payment: null }), account: card });

    expect(storedPlan()).toEqual([1, 2, 3]);
  });

  it('marks a consumed future paid through the transaction service when it was unpaid', async () => {
    tx('fut-a4').paid = false;
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;

    await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }), account: card });

    expect(fakeServices.updateTransaction).toHaveBeenCalledWith(
      'fut-a4',
      HH,
      expect.objectContaining({ paid: true, description: 'Loja Alfa - Parcela 4/10' }),
    );
    expect(refsOf('fut-a4')).toEqual(consume.refs);
  });

  it('removes the refs it claimed when marking the future paid fails', async () => {
    tx('fut-a4').paid = false;
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const consume = preview.proposals.find((p) => p.target?.transactionId === 'fut-a4')!;
    fakeServices.updateTransaction.mockRejectedValueOnce(new Error('balance update failed'));

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [consume.group], payment: null }), account: card }),
    ).rejects.toThrow('balance update failed');
    expect(store.refs).toEqual([]);
  });

  it('requires a source account to record a missing payment, before writing anything', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });

    await expect(confirmCardOfxImport({ request: confirmRequest(preview), account: card })).rejects.toEqual(
      isBadRequest('sourceAccountId is required'),
    );
    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: CARD } }), account: card }),
    ).rejects.toEqual(isBadRequest('credit card'));
    await expect(
      confirmCardOfxImport({
        request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: '99999999-9999-4999-8999-999999999999' } }),
        account: card,
      }),
    ).rejects.toEqual(isBadRequest('not found'));
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
    expect(fakePrisma.transaction.update).not.toHaveBeenCalled();
    expect(store.refs).toEqual([]);
  });

  it('never generates an installment number its plan already stores', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: NOV_OFX() });
    const create = preview.proposals.find((p) => p.kind === 'create' && p.futureInstallments === 2)!;
    // Before the confirm, installment 3 of the new plan shows up (typed by hand with the plan id).
    seedTransaction({ householdId: HH, accountId: CARD, amount: 70, date: '2027-01-01', description: 'Loja Nova 3/3', installmentId: 'ofx:fit-new', installmentNumber: 3, totalInstallments: 3 });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [create.group], payment: null }), account: card });

    expect(result.futureInstallments).toBe(1);
    expect(store.transactions.filter((t) => t.installmentId === 'ofx:fit-new').map((t) => t.installmentNumber).sort()).toEqual([1, 2, 3]);
  });
});

// ---------------------------------------------------------------------------
// Several payments in one invoice
// ---------------------------------------------------------------------------

describe('card OFX import: several "Pagamento recebido" lines', () => {
  const AUGUST: Trn[] = [
    { fitid: 'p1', date: '20260705', amount: '31.00', memo: 'Pagamento recebido' },
    { fitid: 'p2', date: '20260711', amount: '152.40', memo: 'Pagamento recebido' },
    { fitid: 'p3', date: '20260709', amount: '1000.50', memo: 'Pagamento recebido' },
    { fitid: 'm1', date: '20260715', amount: '-77.00', memo: 'Mercado Beta' },
  ];

  it('pays the previous invoice with the one closest to its sheet total and pairs advances with sheet credits', async () => {
    const card = seedCard();
    // July's sheet rows on the card: what July's invoice amounted to.
    seedTransaction({ householdId: HH, accountId: CARD, amount: 600, date: '2026-07-01', description: 'Compras', sourceRef: 'maxfin:2026-07:credit:5' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 400, date: '2026-07-01', description: 'Outras', sourceRef: 'maxfin:2026-07:credit:6' });
    // August's sheet: the purchase and an advance the user typed as a negative card row.
    seedTransaction({ householdId: HH, accountId: CARD, amount: 77, date: '2026-08-01', description: 'Mercado', sourceRef: 'maxfin:2026-08:credit:5' });
    const advanceRow = seedTransaction({ householdId: HH, accountId: CARD, type: 'INCOME', amount: 31, date: '2026-08-01', description: 'Adiantamento', sourceRef: 'maxfin:2026-08:credit:6' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(AUGUST, { start: '20260702', end: '20260802' }) });

    expect(preview.payment).toMatchObject({ amount: 1000.5, invoiceMonthKey: '2026-07', proposal: 'create' });
    expect(preview.proposals.find((p) => p.target?.transactionId === advanceRow.id)).toMatchObject({ kind: 'enrich-exact' });
    // The advance no sheet credit holds becomes a proposal, selected, a credit on the bank's day.
    const advance = preview.proposals.find((p) => p.kind === 'advance-payment')!;
    expect(advance).toMatchObject({ defaultSelected: true, target: null, reason: null });
    expect(preview.lines.find((l) => l.amount === 152.4)).toMatchObject({ status: 'proposed', group: advance.group });
    expect(preview.warnings).toEqual([]);
    // Payments are not in the OFX total: the recorded credit shows up as the closing's advancePayments component.
    expect(preview.closing.components.advancePayments).toBe(-(31 + 152.4));
    expect(preview.closing.explained).toBe(true);
  });

  it('records the unpaired advance as a credit on the card with its ref, and a second confirm creates nothing', async () => {
    const card = seedCard();
    seedTransaction({ householdId: HH, accountId: CARD, amount: 600, date: '2026-07-01', description: 'Compras', sourceRef: 'maxfin:2026-07:credit:5' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 400, date: '2026-07-01', description: 'Outras', sourceRef: 'maxfin:2026-07:credit:6' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 77, date: '2026-08-01', description: 'Mercado', sourceRef: 'maxfin:2026-08:credit:5' });
    seedTransaction({ householdId: HH, accountId: CARD, type: 'INCOME', amount: 31, date: '2026-08-01', description: 'Adiantamento', sourceRef: 'maxfin:2026-08:credit:6' });
    const buffer = ofx(AUGUST, { start: '20260702', end: '20260802' });

    const preview = await buildCardOfxPreview({ account: card, buffer });
    const advance = preview.proposals.find((p) => p.kind === 'advance-payment')!;
    const first = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group), payment: null }),
      account: card,
      userId: 'user-1',
    });

    expect(first.advancePayments).toBe(1);
    const credit = store.transactions.find((t) => t.sourceRef === advance.refs[0])!;
    expect(credit).toMatchObject({ accountId: CARD, type: 'INCOME', amount: 152.4, date: '2026-07-11', categoryName: 'OTHER_INCOME', description: 'Pagamento recebido', paid: true });
    expect(store.refs.filter((r) => r.ref === advance.refs[0])).toHaveLength(1);

    const again = await buildCardOfxPreview({ account: card, buffer });
    expect(again.proposals.filter((p) => p.defaultSelected)).toEqual([]);
    expect(again.lines.find((l) => l.amount === 152.4)).toMatchObject({ status: 'reconciled' });
    expect(again.closing.components.advancePayments).toBe(-(31 + 152.4));
    const count = store.transactions.length;
    const second = await confirmCardOfxImport({ request: confirmRequest(again, { selectedGroups: [advance.group], payment: null }), account: card });
    expect(second.advancePayments).toBe(0);
    expect(second.skipped).toBe(1);
    expect(store.transactions).toHaveLength(count);
  });
});

// ---------------------------------------------------------------------------
// Preview inputs and errors
// ---------------------------------------------------------------------------

describe('card OFX preview: month, warnings and errors', () => {
  it('uses monthOverride when given', async () => {
    const card = seedCard();

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER.slice(0, 1)), options: { monthOverride: { year: 2026, month: 9 } } });

    expect(preview).toMatchObject({ month: { year: 2026, month: 9 }, monthKey: '2026-09', monthSource: 'override' });
  });

  it('warns when the card lacks the due and closing days', async () => {
    const card = seedCard({ dueDay: null, closingDay: null });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER.slice(0, 1)) });

    expect(preview.monthKey).toBe('2026-10');
    expect(preview.warnings).toEqual([
      expect.stringContaining('não tem dia de vencimento'),
      expect.stringContaining('não tem dia de fechamento'),
    ]);
  });

  it('does not warn about the closing day when it is derived from the due day', async () => {
    seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: null });
    const card = await resolveCardAccount(CARD);

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER.slice(0, 1)) });

    expect(card.closingDay).toBe(2);
    expect(preview.monthKey).toBe('2026-10');
    expect(preview.warnings).toEqual([]);
  });

  it('warns when the ledger balance and the lines disagree beyond the bank rounding', async () => {
    const card = seedCard();

    const close = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER.slice(0, 1), { balance: '-123.44' }) });
    const far = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER.slice(0, 1), { balance: '-100.00' }) });

    expect(close.warnings).toEqual([]);
    expect(far.warnings).toEqual([expect.stringContaining('difere do total das linhas')]);
  });

  it('rejects a file that is not a card invoice and an invoice without transactions', async () => {
    const card = seedCard();

    await expect(buildCardOfxPreview({ account: card, buffer: Buffer.from('<OFX><BANKMSGSRSV1><STMTRS></STMTRS></BANKMSGSRSV1></OFX>') })).rejects.toEqual(
      isBadRequest('CCSTMTRS'),
    );
    await expect(buildCardOfxPreview({ account: card, buffer: ofx([]) })).rejects.toEqual(isBadRequest('No readable transactions'));
  });

  it('rejects more than 1000 lines', async () => {
    const card = seedCard();
    const many = Array.from({ length: 1001 }, (_, i) => ({ fitid: `f${i}`, date: '20260910', amount: '-1.00', memo: `Loja ${i}` }));

    await expect(buildCardOfxPreview({ account: card, buffer: ofx(many) })).rejects.toEqual(isBadRequest('at most 1000'));
  });
});

describe('resolveCardAccount', () => {
  it('authorizes the household before saying the account is not a card', async () => {
    seedAccount({ id: BANK, householdId: HH, type: 'CHECKING' });
    const authorize = vi.fn(async () => {
      throw Object.assign(new Error('not your household'), { statusCode: 403 });
    });

    await expect(resolveCardAccount(BANK, authorize)).rejects.toMatchObject({ statusCode: 403 });
    expect(authorize).toHaveBeenCalledWith(HH);
  });

  it('answers 400 for an account that is not a credit card and 404 for a missing or inactive one', async () => {
    seedAccount({ id: BANK, householdId: HH, type: 'CHECKING' });
    seedAccount({ id: 'old-card', householdId: HH, type: 'CREDIT', isActive: false });

    await expect(resolveCardAccount(BANK, async () => undefined)).rejects.toEqual(isBadRequest('not a credit card'));
    await expect(resolveCardAccount('old-card')).rejects.toMatchObject({ statusCode: 404 });
    await expect(resolveCardAccount('missing')).rejects.toMatchObject({ statusCode: 404 });
  });

  it('returns the card with its due and closing days', async () => {
    seedCard();

    await expect(resolveCardAccount(CARD)).resolves.toEqual({
      id: CARD,
      name: 'Cartao Teste',
      type: 'CREDIT',
      householdId: HH,
      dueDay: 9,
      closingDay: 2,
    });
  });

  it.each([
    [9, 2],
    [3, 26],
    [null, null],
  ])('with due day %s and no closing day the resolved closing day is %s', async (dueDay, closingDay) => {
    seedCard({ dueDay, closingDay: null });

    await expect(resolveCardAccount(CARD)).resolves.toMatchObject({ dueDay, closingDay });
  });
});

// ---------------------------------------------------------------------------
// Confirm validation
// ---------------------------------------------------------------------------

describe('card OFX confirm: validation before any write', () => {
  let card: ResolvedCardAccount;
  let preview: CardOfxPreviewResponse;

  beforeEach(async () => {
    card = seedCard();
    seedSheetRow(10, 'Mercado', 123.45);
    preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    vi.clearAllMocks();
  });

  async function expectRejected(request: CardOfxConfirmRequest, message: string | RegExp) {
    await expect(confirmCardOfxImport({ request, account: card })).rejects.toEqual(isBadRequest(message));
    expect(fakePrisma.transaction.findMany).not.toHaveBeenCalled();
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
  }

  it('rejects a group whose refs did not come in the lines', async () => {
    const group = proposal(preview, 'enrich-exact').group;
    const request = confirmRequest(preview, { selectedGroups: [group] });
    request.lines = request.lines.filter((l) => l.memo !== 'Mercado Zeta');

    await expectRejected(request, 'not in lines');
  });

  it('rejects a malformed group id', async () => {
    await expectRejected(confirmRequest(preview, { selectedGroups: ['steal|everything|'] }), 'Malformed group id');
  });

  it('rejects a line whose kind, type, merchant or installment does not match its memo and amount', async () => {
    const tamper = (patch: Record<string, unknown>) => {
      const request = confirmRequest(preview);
      Object.assign(request.lines[0]!, patch);
      return request;
    };

    await expectRejected(tamper({ kind: 'refund' }), 'does not match');
    await expectRejected(tamper({ type: 'INCOME' }), 'does not match');
    await expectRejected(tamper({ merchant: 'Outra Loja' }), 'does not match');
    await expectRejected(tamper({ installment: { number: 1, total: 2 } }), 'does not match');
  });

  it('rejects a line whose ref was not built from its content', async () => {
    const request = confirmRequest(preview);
    request.lines[0] = { ...request.lines[0]!, amount: 999 };

    await expectRejected(request, 'ref of its content');
  });

  it('rejects repeated refs and an invalid month key', async () => {
    const request = confirmRequest(preview);
    request.lines.push({ ...request.lines[0]! });
    await expectRejected(request, 'Duplicate ref');
    await expectRejected(confirmRequest(preview, { monthKey: '2026-13' }), 'monthKey');
  });
});

// ---------------------------------------------------------------------------
// January: the first sheet month (merges and history before the sheet)
// ---------------------------------------------------------------------------

function seedJanuaryRow(line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}): FakeTransaction {
  return seedSheetRow(line, description, amount, { date: '2026-01-01', sourceRef: `maxfin:2026-01:credit:${line}`, ...extra });
}

const JANUARY_OPTIONS = { start: '20251203', end: '20260102' };
const JANUARY: Trn[] = [
  { fitid: 'jan-shop', date: '20251228', amount: '-91.30', memo: 'Zorbit*Loja Gama' },
  { fitid: 'jan-dec1', date: '20251210', amount: '-40.00', memo: 'Padaria Dezembro' },
  { fitid: 'jan-dec2', date: '20251215', amount: '-25.50', memo: 'Farmacia Dezembro' },
  { fitid: 'jan-late', date: '20260101', amount: '-12.00', memo: 'Banca Janeiro' },
  { fitid: 'jan-pay', date: '20260105', amount: '300.00', memo: 'Pagamento recebido' },
];

describe('card OFX import: merging sheet rows into one bank line', () => {
  let card: ResolvedCardAccount;
  let first: FakeTransaction;
  let second: FakeTransaction;

  beforeEach(() => {
    card = seedCard();
    first = seedJanuaryRow(1, 'Zorbyt - Item A', 36.86, { categoryName: 'SHOPPING', notes: 'nota original' });
    second = seedJanuaryRow(2, 'Zorbyt - Item B grande', 54.44, { categoryName: 'SHOPPING' });
  });

  const MERGE_OFX: Trn[] = [{ fitid: 'mg-shop', date: '20260107', amount: '-91.30', memo: 'Zorbit*Loja Gama' }];
  const mergeOptions = { start: '20251203', end: '20260102' };

  function cardTotal(): number {
    return store.transactions
      .filter((t) => t.accountId === CARD && t.attachmentUrl === null)
      .reduce((total, t) => total + Math.round(t.amount * 100), 0);
  }

  it('proposes the merge, selected, with the absorbed rows listed', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });

    const merge = proposal(preview, 'enrich-merge');
    expect(merge).toMatchObject({
      defaultSelected: true,
      ambiguous: false,
      target: { transactionId: first.id, amount: 36.86 },
      absorbed: [{ transactionId: second.id, amount: 54.44, description: 'Zorbyt - Item B grande' }],
      result: { date: '2026-01-07', description: 'Zorbit*Loja Gama' },
    });
    expect(preview.sheetOnly).toEqual([]);
  });

  it('keeps the first row with the bank amount, absorbs the others, records every ref and keeps the total', async () => {
    const before = cardTotal();
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 1, absorbedRows: 1, created: 0, skipped: 0 });
    expect(store.transactions.find((t) => t.id === second.id)).toBeUndefined();
    expect(tx(first.id)).toMatchObject({ amount: 91.3, date: '2026-01-07', description: 'Zorbit*Loja Gama', categoryName: 'SHOPPING', paid: true });
    expect(tx(first.id).notes).toBe(
      'nota original · Planilha (soma de 2 linhas): Zorbyt - Item A 36,86; Zorbyt - Item B grande 54,44',
    );
    expect(refsOf(first.id)).toEqual([preview.lines[0]!.ref, 'maxfin:2026-01:credit:2'].sort());
    expect(cardTotal()).toBe(before);
  });

  it('shows the invoice reconciled when the same OFX comes again, and applies nothing twice', async () => {
    const buffer = ofx(MERGE_OFX, mergeOptions);
    const preview = await buildCardOfxPreview({ account: card, buffer });
    await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    const again = await buildCardOfxPreview({ account: card, buffer });
    expect(again.proposals).toEqual([]);
    expect(again.lines.every((l) => l.status === 'reconciled')).toBe(true);

    const replay = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });
    expect(replay).toMatchObject({ enriched: 0, absorbedRows: 0, skipped: 1 });
    expect(tx(first.id).amount).toBe(91.3);
  });

  it('writes nothing when another confirm records one of its refs first (all-or-nothing)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });
    const other = seedJanuaryRow(9, 'Outra', 1);
    const batch = fakePrisma.$transaction.getMockImplementation()!;
    fakePrisma.$transaction.mockImplementationOnce(async (operations: Array<{ exec: () => Promise<unknown> }>) => {
      seedRef({ householdId: HH, transactionId: other.id, ref: 'maxfin:2026-01:credit:2' });
      return batch(operations);
    });
    const snapshot = JSON.stringify(store.transactions.filter((t) => t.id !== other.id));

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, absorbedRows: 0, skipped: 1 });
    expect(JSON.stringify(store.transactions.filter((t) => t.id !== other.id))).toBe(snapshot);
    expect(refsOf(first.id)).toEqual([]);
  });

  it('does not propose a merge when a row has a share or a settlement', async () => {
    seedShare(second.id);

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });

    expect(preview.proposals.filter((p) => p.kind === 'enrich-merge')).toEqual([]);
    expect(preview.sheetOnly).toHaveLength(2);
  });

  it('does not propose a merge when a row is split, recurring or has an attachment', async () => {
    second.attachmentUrl = 'invoice_pay:x:y';
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });
    expect(preview.proposals.filter((p) => p.kind === 'enrich-merge')).toEqual([]);
  });

  it('unselects a merge across categories and says why', async () => {
    second.categoryName = 'HOME';

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });

    expect(proposal(preview, 'enrich-merge')).toMatchObject({ defaultSelected: false, reason: 'mixed-categories' });
    expect(preview.warnings.some((w) => w.includes('mesclagem'))).toBe(true);
  });

  it('rolls everything back when a share appears on an absorbed row between the recompute and the write', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });
    const batch = fakePrisma.$transaction.getMockImplementation()!;
    fakePrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      seedShare(second.id);
      return batch(fn);
    });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, absorbedRows: 0, skipped: 1 });
    expect(tx(second.id)).toBeDefined();
    expect(tx(first.id).amount).toBe(36.86);
    expect(refsOf(first.id)).toEqual([]);
  });

  it('rolls everything back when the absorbed row changed between the recompute and the write', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });
    const selected = proposal(preview, 'enrich-merge').group;
    const batch = fakePrisma.$transaction.getMockImplementation()!;
    fakePrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      second.amount = 54.45; // edited by someone else after the recompute
      return batch(fn);
    });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [selected], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, absorbedRows: 0, skipped: 1 });
    expect(tx(first.id)).toMatchObject({ amount: 36.86, description: 'Zorbyt - Item A' });
    expect(refsOf(first.id)).toEqual([]);
    expect(tx(second.id).amount).toBe(54.45);
  });

  it('skips the merge when a stored row changed after the preview (amount no longer adds up)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(MERGE_OFX, mergeOptions) });
    const selected = proposal(preview, 'enrich-merge').group;
    // The group id does not know the amounts: a row edited meanwhile makes the recompute stop proposing it...
    second.amount = 50;

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [selected], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, absorbedRows: 0, skipped: 1 });
    expect(tx(second.id).amount).toBe(50);
    expect(tx(first.id).amount).toBe(36.86);
  });
});

describe('card OFX import: history before the first sheet month', () => {
  let card: ResolvedCardAccount;
  // The sheet starts in January 2026: everything dated before 2026-01-01 is history, closing day or not.
  const HISTORY: Trn[] = [
    { fitid: 'h-nov', date: '20251120', amount: '-40.00', memo: 'Padaria Novembro' },
    { fitid: 'h-dec', date: '20251215', amount: '-25.50', memo: 'Farmacia Dezembro' },
    { fitid: 'h-late', date: '20260102', amount: '-9.00', memo: 'Banca Tardia' },
    { fitid: 'h-jan', date: '20260101', amount: '-12.00', memo: 'Banca Janeiro' },
    { fitid: 'h-pay', date: '20260105', amount: '300.00', memo: 'Pagamento recebido' },
  ];
  const OPTIONS = { start: '20251103', end: '20260102' };
  const createFor = (preview: CardOfxPreviewResponse, memo: string) =>
    preview.proposals.find((p) => p.kind === 'create' && preview.lines.find((l) => l.ref === p.refs[0])!.memo === memo);

  beforeEach(() => {
    card = seedCard();
    seedJanuaryRow(1, 'Banca Janeiro', 12);
  });

  it('selects every purchase dated before the first sheet month, even while a sheet row is left over', async () => {
    seedJanuaryRow(2, 'Sem par no OFX', 77);

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });

    expect(createFor(preview, 'Padaria Novembro')).toMatchObject({ defaultSelected: true, reason: null });
    expect(createFor(preview, 'Farmacia Dezembro')).toMatchObject({ defaultSelected: true, reason: null });
  });

  it('holds a leftover of the sheet month back, with the reason, only while sheet rows are left over', async () => {
    seedJanuaryRow(2, 'Sem par no OFX', 77);

    const held = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });

    expect(createFor(held, 'Banca Tardia')).toMatchObject({ defaultSelected: false, reason: 'sheet-residue' });
    expect(held.warnings.some((w) => w.includes('sobram linhas da planilha'))).toBe(true);
  });

  it('selects a leftover of the sheet month when every sheet row found its bank line', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });

    expect(createFor(preview, 'Banca Tardia')).toMatchObject({ defaultSelected: true, reason: null });
  });

  it('does not propose paying the invoice before the sheet, which Recta has no purchases for', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });

    expect(preview.payment).toMatchObject({ invoiceMonthKey: '2025-12', recorded: null, proposal: 'ok' });
    expect(preview.warnings.some((w) => w.includes('anterior à planilha'))).toBe(true);
  });

  it('creates the history with its dates, paid and refs, records no payment, and shows it reconciled afterwards', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { payment: { apply: true, sourceAccountId: BANK } }),
      account: card,
      userId: 'user-1',
    });

    expect(result).toMatchObject({ created: 3, payment: null });
    const created = store.transactions.filter((t) => t.sourceRef?.startsWith('ofx:'));
    expect(created.map((t) => [t.description, t.date, t.paid, t.type]).sort()).toEqual([
      ['Banca Tardia', '2026-01-02', true, 'EXPENSE'],
      ['Farmacia Dezembro', '2025-12-15', true, 'EXPENSE'],
      ['Padaria Novembro', '2025-11-20', true, 'EXPENSE'],
    ]);
    expect(store.transactions.filter((t) => t.attachmentUrl !== null)).toEqual([]);

    const again = await buildCardOfxPreview({ account: card, buffer: ofx(HISTORY, OPTIONS) });
    expect(again.proposals.filter((p) => p.kind === 'create')).toEqual([]);
    expect(again.lines.find((l) => l.memo === 'Padaria Novembro')!.status).toBe('reconciled');
  });

  it('proposes the payment as usual for a month after the first sheet month', async () => {
    seedTransaction({ householdId: HH, accountId: CARD, type: 'EXPENSE', amount: 10, date: '2025-12-20', description: 'Antiga', sourceRef: 'x:1' });
    const february = ofx([{ fitid: 'f-pay', date: '20260205', amount: '500.00', memo: 'Pagamento recebido' }], { start: '20260103', end: '20260202' });

    const preview = await buildCardOfxPreview({ account: card, buffer: february });

    expect(preview.payment).toMatchObject({ invoiceMonthKey: '2026-01', proposal: 'create' });
  });
});

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

describe('card OFX service helpers', () => {
  it('derives the invoice (due) month from the closing date and the card days', () => {
    expect(invoiceMonthFromStatement('2026-10-02', { dueDay: 9, closingDay: 2 })).toEqual({ month: { year: 2026, month: 10 }, guessed: false });
    expect(invoiceMonthFromStatement('2026-10-25', { dueDay: 5, closingDay: 25 })).toEqual({ month: { year: 2026, month: 11 }, guessed: false });
    expect(invoiceMonthFromStatement('2026-12-25', { dueDay: 5, closingDay: 25 })).toEqual({ month: { year: 2027, month: 1 }, guessed: false });
    // Without a closing day, DTEND's day is the closing day.
    expect(invoiceMonthFromStatement('2026-10-02', { dueDay: 9, closingDay: null })).toEqual({ month: { year: 2026, month: 10 }, guessed: false });
    expect(invoiceMonthFromStatement('2026-10-02', { dueDay: null, closingDay: 2 })).toEqual({ month: { year: 2026, month: 10 }, guessed: true });
  });

  it('compares the recorded payment with the bank one', () => {
    const recorded = (amount: number, date: string) => ({ id: 'p', amount, date: new Date(`${date}T00:00:00Z`), accountId: BANK, description: null });

    expect(paymentProposal({ amount: 100, date: '2026-09-03' }, [])).toBe('create');
    expect(paymentProposal({ amount: 100, date: '2026-09-03' }, [recorded(100, '2026-09-03')])).toBe('ok');
    expect(paymentProposal({ amount: 100, date: '2026-09-03' }, [recorded(100, '2026-09-09')])).toBe('adjust');
    expect(paymentProposal({ amount: 100, date: '2026-09-03' }, [recorded(99.99, '2026-09-03')])).toBe('adjust');
    // Several recorded payments: only their sum matters.
    expect(paymentProposal({ amount: 100, date: '2026-09-03' }, [recorded(60, '2026-09-01'), recorded(40, '2026-09-20')])).toBe('ok');
  });

  it('formats, joins notes and names future installments', () => {
    expect(formatBRL(1234.5)).toBe('R$ 1.234,50');
    expect(formatBRL(-0.07)).toBe('-R$ 0,07');
    expect(joinNotes(null, 'Planilha: X')).toBe('Planilha: X');
    expect(joinNotes('nota', 'Planilha: X')).toBe('nota · Planilha: X');
    expect(joinNotes('nota', null)).toBe('nota');
    expect(joinNotes('a'.repeat(990), 'Planilha: X')).toHaveLength(1000);
    expect(futureInstallmentMemo('Loja - NuPay - Parcela 1/12', 12, 12)).toBe('Loja - NuPay - Parcela 12/12');
    expect(futureInstallmentMemo('Loja', 2, 3)).toBe('Loja - Parcela 2/3');
    expect(isOfxFutureRef('ofx:abc-1:0a1b2c3d:f2')).toBe(true);
    expect(isOfxFutureRef('ofx:abc-1:0a1b2c3d')).toBe(false);
    expect(isOfxFutureRef('maxfin:2026-10:credit:5:f1')).toBe(false);
  });

  it('accepts the preview lines as they come back', async () => {
    const card = seedCard();
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });

    expect(validateConfirmLines(confirmRequest(preview).lines)).toHaveLength(OCTOBER.length);
  });
});

describe('card OFX import: closing period end', () => {
  const OPTS = { start: '20260103', end: '20260202' };

  it('leaves DTEND to the next statement when only a payment is dated on it', async () => {
    const card = seedCard();
    seedJanuaryRow(1, 'Banca Janeiro', 12);
    const preview = await buildCardOfxPreview({
      account: card,
      buffer: ofx(
        [
          { fitid: 'e-1', date: '20260110', amount: '-12.00', memo: 'Banca Janeiro' },
          { fitid: 'e-pay', date: '20260202', amount: '300.00', memo: 'Pagamento recebido' },
        ],
        OPTS,
      ),
    });

    expect(preview.closing.endInclusive).toBe(false);
  });

  it('counts DTEND in the period when a purchase is dated on it', async () => {
    const card = seedCard();
    seedJanuaryRow(1, 'Banca Janeiro', 12);
    const preview = await buildCardOfxPreview({
      account: card,
      buffer: ofx([{ fitid: 'e-1', date: '20260202', amount: '-12.00', memo: 'Banca Janeiro' }], OPTS),
    });

    expect(preview.closing.endInclusive).toBe(true);
  });
});

describe('card OFX import: neighbour months and merchant groups', () => {
  let card: ResolvedCardAccount;
  const OPTS = { start: '20260203', end: '20260302' }; // due month 2026-03
  const sheetMarch = (line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}) =>
    seedSheetRow(line, description, amount, { date: '2026-03-01', sourceRef: `maxfin:2026-03:credit:${line}`, ...extra });
  const sheetFebruary = (line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}) =>
    seedSheetRow(line, description, amount, { date: '2026-02-01', sourceRef: `maxfin:2026-02:credit:${line}`, ...extra });

  beforeEach(() => {
    card = seedCard();
    // February's statement was imported: one February sheet row is already tied to an OFX line.
    const febAnchor = sheetFebruary(90, 'Ponto de fevereiro', 1);
    seedRef({ householdId: HH, transactionId: febAnchor.id, ref: 'ofx:feb:11111111' });
  });

  const NEIGHBOUR: Trn[] = [
    { fitid: 'a-1', date: '20260210', amount: '-10.00', memo: 'Banca Marco' },
    { fitid: 'a-2', date: '20260205', amount: '-57.90', memo: 'Livraria Sol' },
  ];

  it('moves a purchase the sheet typed in the previous month: bank date and memo, sheet month kept, ref recorded', async () => {
    sheetMarch(1, 'Banca Marco', 10);
    const april = sheetFebruary(1, 'Livraria', 57.9, { notes: 'nota' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEIGHBOUR, OPTS) });

    expect(proposal(preview, 'enrich-neighbour')).toMatchObject({ defaultSelected: true, target: { transactionId: april.id, sourceRef: 'maxfin:2026-02:credit:1' } });
    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 2, skipped: 0 });
    expect(tx(april.id)).toMatchObject({ date: '2026-02-05', description: 'Livraria Sol', sourceRef: 'maxfin:2026-02:credit:1', amount: 57.9 });
    expect(tx(april.id).notes).toBe('nota · Planilha: Livraria');
    expect(refsOf(april.id)).toHaveLength(1);
    const again = await buildCardOfxPreview({ account: card, buffer: ofx(NEIGHBOUR, OPTS) });
    expect(again.proposals).toEqual([]);
  });

  it('never touches a neighbour row that is already linked to an OFX line', async () => {
    sheetMarch(1, 'Banca Marco', 10);
    const april = sheetFebruary(1, 'Livraria', 57.9);
    seedRef({ householdId: HH, transactionId: april.id, ref: 'ofx:other:11111111' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEIGHBOUR, OPTS) });

    expect(preview.proposals.find((p) => p.kind === 'enrich-neighbour')).toBeUndefined();
  });

  it('writes nothing when another confirm linked the neighbour row between the recompute and the write', async () => {
    sheetMarch(1, 'Banca Marco', 10);
    const april = sheetFebruary(1, 'Livraria', 57.9);
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEIGHBOUR, OPTS) });
    const batch = fakePrisma.$transaction.getMockImplementation()!;
    fakePrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      seedRef({ householdId: HH, transactionId: april.id, ref: 'ofx:rival:22222222' });
      return batch(fn);
    });
    const selected = proposal(preview, 'enrich-neighbour').group;

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [selected], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(tx(april.id)).toMatchObject({ date: '2026-02-01', description: 'Livraria' });
    expect(refsOf(april.id)).toEqual(['ofx:rival:22222222']);
  });

  it('writes nothing when the neighbour row changed amount meanwhile', async () => {
    sheetMarch(1, 'Banca Marco', 10);
    const april = sheetFebruary(1, 'Livraria', 57.9);
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEIGHBOUR, OPTS) });
    const batch = fakePrisma.$transaction.getMockImplementation()!;
    fakePrisma.$transaction.mockImplementationOnce(async (fn: unknown) => {
      april.amount = 58;
      return batch(fn);
    });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'enrich-neighbour').group], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(refsOf(april.id)).toEqual([]);
  });

  it('applies a merchant group: the sheet row is kept at its total, with every bank line in the notes and refs', async () => {
    const fillers: Trn[] = Array.from({ length: 16 }, (_, i) => ({ fitid: `f${i}`, date: '20260205', amount: '-33.33', memo: `Loja Fantasia ${i}` }));
    const taxi: Trn[] = [
      { fitid: 'g1', date: '20260206', amount: '-15.00', memo: 'Taxi' },
      { fitid: 'g2', date: '20260207', amount: '-10.00', memo: 'Dl*Taxibras' },
      { fitid: 'g3', date: '20260208', amount: '-15.00', memo: 'Pg *55 Corrida' },
    ];
    const group = sheetMarch(1, 'Taxi/55', 40);

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx([...fillers, ...taxi], OPTS) });
    const proposed = proposal(preview, 'enrich-group');
    expect(proposed).toMatchObject({ defaultSelected: true, reason: null, target: { transactionId: group.id } });
    expect(proposed.refs).toHaveLength(3);

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result.skipped).toBe(0);
    expect(tx(group.id)).toMatchObject({ amount: 40, description: 'Taxi/55', date: '2026-02-06' });
    expect(tx(group.id).notes).toContain('Dl*Taxibras');
    expect(refsOf(group.id)).toHaveLength(3);
  });
});

describe('card OFX import: near amounts', () => {
  let card: ResolvedCardAccount;
  const OPTS = { start: '20260203', end: '20260302' }; // due month 2026-03
  const NEAR: Trn[] = [
    { fitid: 'z-1', date: '20260210', amount: '-10.00', memo: 'Banca Marco' },
    { fitid: 'z-2', date: '20260215', amount: '-55.35', memo: 'Livraria Sol Central' },
  ];
  const marchRow = (line: number, description: string, amount: number, extra: Partial<FakeTransaction> = {}) =>
    seedSheetRow(line, description, amount, { date: '2026-03-01', sourceRef: `maxfin:2026-03:credit:${line}`, ...extra });
  let target: FakeTransaction;

  beforeEach(() => {
    card = seedCard();
    marchRow(1, 'Banca Marco', 10);
    target = marchRow(2, 'Livraria Sol', 55.37, { notes: 'nota' });
  });

  it('adopts the bank amount through the transaction service, noting the sheet amount, and records the ref', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });
    expect(proposal(preview, 'enrich-near')).toMatchObject({ defaultSelected: true, reason: null, target: { transactionId: target.id, amount: 55.37 } });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 2, skipped: 0 });
    expect(fakeServices.updateTransaction).toHaveBeenCalledWith(
      target.id,
      HH,
      expect.objectContaining({ amount: 55.35, description: 'Livraria Sol Central' }),
      { beforeWrite: expect.any(Function) },
    );
    expect(tx(target.id)).toMatchObject({ amount: 55.35, date: '2026-02-15', description: 'Livraria Sol Central', sourceRef: 'maxfin:2026-03:credit:2' });
    expect(tx(target.id).notes).toBe('nota · Planilha: Livraria Sol 55,37');
    expect(refsOf(target.id)).toHaveLength(1);
    const again = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });
    expect(again.proposals).toEqual([]);
    expect(again.closing.explained).toBe(true);
  });

  it('writes nothing when another confirm linked the row first (the hook runs under the claim)', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });
    const impl = fakeServices.updateTransaction.getMockImplementation()!;
    fakeServices.updateTransaction.mockImplementationOnce(async (...args: Parameters<typeof impl>) => {
      seedRef({ householdId: HH, transactionId: target.id, ref: 'ofx:rival:33333333' });
      return impl(...args);
    });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'enrich-near').group], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(tx(target.id)).toMatchObject({ amount: 55.37, description: 'Livraria Sol' });
    expect(refsOf(target.id)).toEqual(['ofx:rival:33333333']);
  });

  it('writes nothing when the row changed amount meanwhile', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });
    const impl = fakeServices.updateTransaction.getMockImplementation()!;
    fakeServices.updateTransaction.mockImplementationOnce(async (...args: Parameters<typeof impl>) => {
      target.amount = 55.4;
      return impl(...args);
    });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { selectedGroups: [proposal(preview, 'enrich-near').group], payment: null }), account: card });

    expect(result).toMatchObject({ enriched: 0, skipped: 1 });
    expect(tx(target.id).amount).toBe(55.4);
    expect(refsOf(target.id)).toEqual([]);
  });

  it('keeps a weak near match unselected, with the reason, and still lists it', async () => {
    target.description = 'Presente';

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });

    expect(proposal(preview, 'enrich-near')).toMatchObject({ defaultSelected: false, reason: 'near-amount' });
    expect(preview.warnings.some((w) => w.includes('valor próximo'))).toBe(true);
  });

  it('warns when a selected near-amount adoption falls in an invoice that already has a registered payment', async () => {
    seedTransaction({ householdId: HH, accountId: BANK, type: 'EXPENSE', amount: 65.37, date: '2026-03-09', description: 'Pagamento', attachmentUrl: 'invoice_pay:card-1:2026-2' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });

    expect(preview.warnings.some((w) => w.includes('já tem pagamento registrado'))).toBe(true);
  });

  it('does not warn about payments when there is none or nothing is adopted', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(NEAR, OPTS) });

    expect(preview.warnings.some((w) => w.includes('já tem pagamento registrado'))).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// The same statement again, and an updated one
// ---------------------------------------------------------------------------

describe('card OFX import: re-importing and updated statements', () => {
  const OPEN: Trn[] = [
    { fitid: 'u1', date: '20261005', amount: '-100.00', memo: 'Loja Alfa' },
    { fitid: 'u2', date: '20261006', amount: '-40.00', memo: 'Loja Beta' },
    { fitid: 'u3', date: '20261007', amount: '-25.50', memo: 'Loja Gama' },
  ];
  const opts = { start: '20261002', end: '20261102' };

  async function importOnce(buffer: Buffer, card: ResolvedCardAccount, groups?: (p: CardOfxPreviewResponse) => string[]) {
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { selectedGroups: groups ? groups(preview) : preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group), payment: null }),
      account: card,
    });
    return { preview, result };
  }

  it('the same file twice: nothing proposed, nothing created, even forcing every group', async () => {
    const card = seedCard();
    const first = await importOnce(ofx(OPEN, opts), card);
    expect(first.result.created).toBe(3);
    const count = store.transactions.length;

    const again = await importOnce(ofx(OPEN, opts), card, (p) => p.proposals.map((x) => x.group));

    expect(again.preview.proposals).toEqual([]);
    expect(again.preview.warnings).toEqual([]);
    expect(again.result).toMatchObject({ created: 0, advancePayments: 0, enriched: 0 });
    expect(store.transactions).toHaveLength(count);
  });

  it('an updated file: only the new lines are proposed, a vanished one is warned about and kept, a changed one is held back', async () => {
    const card = seedCard();
    await importOnce(ofx(OPEN, opts), card);
    const before = store.transactions.length;
    const updated: Trn[] = [
      OPEN[0]!, // unchanged
      { fitid: 'u2', date: '20261006', amount: '-40.03', memo: 'Loja Beta' }, // amount changed by cents: new ref, same FITID
      // u3 vanished
      { fitid: 'u4', date: '20261010', amount: '-12.00', memo: 'Loja Delta' }, // new
      { fitid: 'u5', date: '20261011', amount: '-80.00', memo: 'Loja Epsilon - Parcela 1/4' }, // new installment plan
    ];

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(updated, opts) });

    const selected = preview.proposals.filter((p) => p.defaultSelected);
    expect(selected.map((p) => p.refs.length)).toEqual([1, 1]);
    expect(selected.map((p) => preview.lines.find((l) => l.ref === p.refs[0])!.fitid).sort()).toEqual(['u4', 'u5']);
    const held = preview.proposals.find((p) => p.reason === 'changed-in-statement')!;
    expect(held.counterpart).toMatchObject({ description: 'Loja Beta', amount: 40 });
    expect(preview.lines.find((l) => l.fitid === 'u1')!.status).toBe('reconciled');
    expect(preview.warnings).toEqual([expect.stringContaining('mudaram de valor'), expect.stringContaining('não aparece(m) mais neste arquivo')]);
    expect(preview.warnings[1]).toContain('Loja Gama');
    expect(preview.warnings[1]).not.toContain('Loja Beta');

    const result = await confirmCardOfxImport({ request: confirmRequest(preview, { payment: null }), account: card });

    expect(result.created).toBe(2);
    // Nothing the user had is deleted: the vanished and the changed row both stay.
    expect(store.transactions.filter((t) => ['Loja Gama', 'Loja Beta'].includes(t.description ?? ''))).toHaveLength(2);
    expect(store.transactions).toHaveLength(before + 2 + (result.futureInstallments ?? 0));
  });
});
