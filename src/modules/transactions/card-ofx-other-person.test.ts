import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakePrisma,
  fakeServices,
  resetStore,
  seedAccount,
  seedPerson,
  seedTransaction,
  store,
} from './__fixtures__/card-ofx-fake-db.js';
import { buildCardOfxPreview, confirmCardOfxImport, type ResolvedCardAccount } from './card-ofx-import.service.js';
import type { CardOfxConfirmRequest, CardOfxPreviewResponse, CardOfxProposal } from './card-ofx-import.types.js';
import type { MaxFinCategoryMapInput } from './maxfin-import.types.js';
import { ownAmountCents } from '../people/own-share.js';

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
vi.mock('../recurring-transactions/recurring-follow.js', () => ({ followLastAmountInTx: vi.fn(async () => null) }));
vi.mock('../categories/categories.service.js', async () => ({
  createCategory: (await import('./__fixtures__/card-ofx-fake-db.js')).fakeServices.createCategory,
}));

// Invented data only: stores, people, amounts and ids below are fictitious.

const HH = 'hh-1';
const CARD = 'card-1';
const BANK = 'bank-1';

interface Trn {
  fitid: string;
  date: string;
  amount: string;
  memo: string;
}

function ofx(trns: Trn[], opts: { start?: string; end?: string } = {}): Buffer {
  const body = trns
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE>\n<DTPOSTED>${t.date}000000[-3:BRT]</DTPOSTED>\n` +
        `<TRNAMT>${t.amount}</TRNAMT>\n<FITID>${t.fitid}</FITID>\n<MEMO>${t.memo}</MEMO>\n</STMTTRN>`,
    )
    .join('\n');
  return Buffer.from(
    [
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
      '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>',
      '</OFX>',
    ].join('\n'),
    'utf8',
  );
}

function seedCard(): ResolvedCardAccount {
  const card = seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: 2 });
  seedAccount({ id: BANK, householdId: HH, name: 'Conta Teste', type: 'CHECKING' });
  return { id: card.id, name: card.name, type: 'CREDIT' as ResolvedCardAccount['type'], householdId: HH, dueDay: card.dueDay, closingDay: card.closingDay };
}

function acceptedMap(preview: CardOfxPreviewResponse): MaxFinCategoryMapInput[] {
  return preview.categoryMap.map((entry) => {
    const s = entry.suggestion;
    const target: MaxFinCategoryMapInput['target'] =
      s.kind === 'system' ? { kind: 'system', categoryName: s.categoryName! } : { kind: 'default' };
    return { key: entry.key, type: entry.type, target };
  });
}

function confirmRequest(preview: CardOfxPreviewResponse, overrides: Partial<CardOfxConfirmRequest> = {}): CardOfxConfirmRequest {
  return {
    accountId: preview.accountId,
    monthKey: preview.monthKey,
    lines: preview.lines.map(({ status: _status, group: _group, ...line }) => line),
    ledgerBalance: preview.ledgerBalance,
    paymentLineRef: preview.payment?.ref ?? null,
    selectedGroups: preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group),
    categoryMap: acceptedMap(preview),
    payment: null,
    ...overrides,
  };
}

function groupOf(preview: CardOfxPreviewResponse, memo: string): CardOfxProposal {
  const line = preview.lines.find((l) => l.memo.startsWith(memo))!;
  return preview.proposals.find((p) => p.group === line.group)!;
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

// Statement of October: two purchases for the card holder and one made for Bia (another person).
const OCTOBER: Trn[] = [
  { fitid: 'o1', date: '20260910', amount: '-60.00', memo: 'Mercado Beta' },
  { fitid: 'o2', date: '20260915', amount: '-90.00', memo: 'Loja Gama' },
  { fitid: 'o3', date: '20260920', amount: '-30.00', memo: 'Padaria Delta' },
];

describe('card OFX import: a line that belongs to another person', () => {
  let card: ResolvedCardAccount;
  let bia: { id: string };

  beforeEach(() => {
    card = seedCard();
    bia = seedPerson({ householdId: HH, name: 'Bia' });
  });

  it('records the purchase as the holder\'s own expense, 100% owed by the person, and the statement closes', async () => {
    const buffer = ofx(OCTOBER);
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const gama = groupOf(preview, 'Loja Gama');
    expect(gama).toMatchObject({ kind: 'create', defaultSelected: true });

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { otherPeople: [{ group: gama.group, personId: bia.id }] }),
      account: card,
      userId: 'user-1',
    });

    expect(result).toMatchObject({ created: 3, sharedWithPeople: 1, settlementsRecorded: 0 });
    const gamaTx = store.transactions.find((t) => t.description === 'Loja Gama')!;
    expect(gamaTx).toMatchObject({ accountId: CARD, type: 'EXPENSE', amount: 90 });
    expect(store.shares).toHaveLength(1);
    expect(store.shares[0]).toMatchObject({ householdId: HH, transactionId: gamaTx.id, personId: bia.id, direction: 'THEY_OWE_ME', source: 'import' });
    expect(Number(String(store.shares[0]!.amount))).toBe(90);
    // The holder's own part of that purchase is zero: it stays out of the budget.
    expect(ownAmountCents(9000, 9000)).toBe(0);

    // Total in the system = the statement's; the next preview has nothing pending and the closing is explained.
    const again = await buildCardOfxPreview({ account: card, buffer });
    expect(again.proposals.filter((p) => p.defaultSelected)).toEqual([]);
    expect(again.lines.every((l) => l.status === 'reconciled')).toBe(true);
    expect(again.closing.delta).toBe(0);
    expect(again.closing.explained).toBe(true);
    const cardTotal = store.transactions.filter((t) => t.accountId === CARD).reduce((s, t) => s + (t.type === 'EXPENSE' ? t.amount : -t.amount), 0);
    expect(cardTotal).toBeCloseTo(preview.ofxTotal, 2);
  });

  it('does not duplicate the transaction or the share when the same file is confirmed again', async () => {
    const buffer = ofx(OCTOBER);
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const gama = groupOf(preview, 'Loja Gama');
    const request = confirmRequest(preview, { otherPeople: [{ group: gama.group, personId: bia.id }] });
    await confirmCardOfxImport({ request, account: card, userId: 'user-1' });

    const second = await confirmCardOfxImport({ request, account: card, userId: 'user-1' });

    expect(second).toMatchObject({ created: 0, sharedWithPeople: 0, settlementsRecorded: 0 });
    expect(store.transactions.filter((t) => t.description === 'Loja Gama')).toHaveLength(1);
    expect(store.shares).toHaveLength(1);
  });

  it('puts the person on every installment of a purchase, the future ones included', async () => {
    const buffer = ofx([{ fitid: 'o9', date: '20260918', amount: '-120.00', memo: 'Curso Sigma - Parcela 1/3' }]);
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const group = groupOf(preview, 'Curso Sigma');
    expect(group.futureInstallments).toBe(2);

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { otherPeople: [{ group: group.group, personId: bia.id }] }),
      account: card,
    });

    expect(result).toMatchObject({ created: 1, futureInstallments: 2, sharedWithPeople: 3 });
    const installments = store.transactions.filter((t) => t.installmentId !== null);
    expect(installments).toHaveLength(3);
    for (const t of installments) {
      expect(store.shares.filter((s) => s.transactionId === t.id && s.personId === bia.id && s.direction === 'THEY_OWE_ME')).toHaveLength(1);
    }
  });

  it('refuses an inactive person, one from another household, an unselected group and a non-purchase group, writing nothing', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(OCTOBER) });
    const gama = groupOf(preview, 'Loja Gama');
    const inactive = seedPerson({ householdId: HH, name: 'Caio', isActive: false });
    const stranger = seedPerson({ householdId: 'hh-2', name: 'Dora' });
    const run = (otherPeople: CardOfxConfirmRequest['otherPeople'], extra: Partial<CardOfxConfirmRequest> = {}) =>
      confirmCardOfxImport({ request: confirmRequest(preview, { otherPeople, ...extra }), account: card });

    await expect(run([{ group: gama.group, personId: inactive.id }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(run([{ group: gama.group, personId: stranger.id }])).rejects.toMatchObject({ statusCode: 404 });
    await expect(run([{ group: gama.group, personId: bia.id }], { selectedGroups: [] })).rejects.toMatchObject({ statusCode: 400 });
    await expect(run([{ group: 'create|nao-existe|', personId: bia.id }])).rejects.toMatchObject({ statusCode: 400 });
    await expect(run([{ group: gama.group, personId: bia.id }, { group: gama.group, personId: bia.id }])).rejects.toMatchObject({ statusCode: 400 });

    expect(store.transactions).toHaveLength(0);
    expect(store.shares).toHaveLength(0);
  });

  it('removes the transaction again when its share cannot be saved (no half-recorded line)', async () => {
    const buffer = ofx(OCTOBER);
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const gama = groupOf(preview, 'Loja Gama');
    fakePrisma.transactionShare.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { otherPeople: [{ group: gama.group, personId: bia.id }] }), account: card }),
    ).rejects.toThrow('connection lost');

    expect(store.transactions.find((t) => t.description === 'Loja Gama')).toBeUndefined();
    expect(store.refs.find((r) => r.ref === gama.refs[0])).toBeUndefined();
    expect(store.shares).toHaveLength(0);
    // Nothing was left behind that would hide the line from the next preview.
    const retry = await buildCardOfxPreview({ account: card, buffer });
    expect(groupOf(retry, 'Loja Gama')).toMatchObject({ kind: 'create' });
  });
});

describe('card OFX import: an advance payment made by another person', () => {
  const AUGUST: Trn[] = [
    { fitid: 'p1', date: '20260705', amount: '31.00', memo: 'Pagamento recebido' },
    { fitid: 'p2', date: '20260711', amount: '152.40', memo: 'Pagamento recebido' },
    { fitid: 'p3', date: '20260709', amount: '1000.50', memo: 'Pagamento recebido' },
    { fitid: 'm1', date: '20260715', amount: '-77.00', memo: 'Mercado Beta' },
  ];
  let card: ResolvedCardAccount;
  let bia: { id: string };

  beforeEach(() => {
    card = seedCard();
    bia = seedPerson({ householdId: HH, name: 'Bia' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 600, date: '2026-07-01', description: 'Compras', sourceRef: 'maxfin:2026-07:credit:5' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 400.5, date: '2026-07-01', description: 'Outras', sourceRef: 'maxfin:2026-07:credit:6' });
    seedTransaction({ householdId: HH, accountId: CARD, amount: 77, date: '2026-08-01', description: 'Mercado', sourceRef: 'maxfin:2026-08:credit:5' });
    seedTransaction({ householdId: HH, accountId: CARD, type: 'INCOME', amount: 31, date: '2026-08-01', description: 'Adiantamento', sourceRef: 'maxfin:2026-08:credit:6' });
  });

  it('records the credit on the card and a RECEIVED settlement linked to it', async () => {
    const buffer = ofx(AUGUST, { start: '20260702', end: '20260802' });
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const advance = preview.proposals.find((p) => p.kind === 'advance-payment')!;

    const result = await confirmCardOfxImport({
      request: confirmRequest(preview, { otherPeople: [{ group: advance.group, personId: bia.id }] }),
      account: card,
      userId: 'user-1',
    });

    expect(result).toMatchObject({ advancePayments: 1, sharedWithPeople: 0, settlementsRecorded: 1 });
    const credit = store.transactions.find((t) => t.sourceRef === advance.refs[0])!;
    expect(credit).toMatchObject({ type: 'INCOME', amount: 152.4, accountId: CARD });
    expect(store.settlements).toHaveLength(1);
    expect(store.settlements[0]).toMatchObject({ householdId: HH, personId: bia.id, direction: 'RECEIVED', transactionId: credit.id });
    expect(Number(String(store.settlements[0]!.amount))).toBe(152.4);
    const settled = store.settlements[0]!.date as Date;
    expect([settled.getFullYear(), settled.getMonth() + 1, settled.getDate()]).toEqual([2026, 7, 11]);
  });

  it('records the settlement only once on a repeated confirm', async () => {
    const buffer = ofx(AUGUST, { start: '20260702', end: '20260802' });
    const preview = await buildCardOfxPreview({ account: card, buffer });
    const advance = preview.proposals.find((p) => p.kind === 'advance-payment')!;
    const request = confirmRequest(preview, { otherPeople: [{ group: advance.group, personId: bia.id }] });
    await confirmCardOfxImport({ request, account: card });

    const second = await confirmCardOfxImport({ request, account: card });

    expect(second).toMatchObject({ advancePayments: 0, settlementsRecorded: 0 });
    expect(store.settlements).toHaveLength(1);
  });

  it('removes the credit again when the settlement cannot be saved', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(AUGUST, { start: '20260702', end: '20260802' }) });
    const advance = preview.proposals.find((p) => p.kind === 'advance-payment')!;
    fakePrisma.settlement.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      confirmCardOfxImport({ request: confirmRequest(preview, { otherPeople: [{ group: advance.group, personId: bia.id }] }), account: card }),
    ).rejects.toThrow('connection lost');

    expect(store.transactions.find((t) => t.sourceRef === advance.refs[0])).toBeUndefined();
    expect(store.settlements).toHaveLength(0);
  });
});

void fakeServices;
