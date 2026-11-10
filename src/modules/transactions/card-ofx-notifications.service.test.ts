import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  fakeServices,
  resetStore,
  seedAccount,
  seedRef,
  seedTransaction,
  store,
  type FakeTransaction,
} from './__fixtures__/card-ofx-fake-db.js';
import { buildCardOfxPreview, confirmCardOfxImport, type ResolvedCardAccount } from './card-ofx-import.service.js';
import type { CardOfxConfirmRequest, CardOfxPreviewResponse } from './card-ofx-import.types.js';

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

// Coexistence of the capture drafts (POST /captures/:id/confirm) with the card invoice OFX import: a purchase confirmed
// from a notification carries sourceRef `notif:<dedupKey>`, and the statement line of the same purchase must pair with
// it instead of becoming a second transaction. Invented stores and amounts only.

const HH = 'hh-1';
const CARD = 'card-1';
const NOTIF_REF = `notif:${'a1'.repeat(20)}`;

interface Trn { fitid: string; date: string; amount: string; memo: string }

function ofx(trns: Trn[]): Buffer {
  const body = trns
    .map(
      (t) =>
        `<STMTTRN>\n<TRNTYPE>${t.amount.startsWith('-') ? 'DEBIT' : 'CREDIT'}</TRNTYPE>\n<DTPOSTED>${t.date}000000[-3:BRT]</DTPOSTED>\n` +
        `<TRNAMT>${t.amount}</TRNAMT>\n<FITID>${t.fitid}</FITID>\n<MEMO>${t.memo}</MEMO>\n</STMTTRN>`,
    )
    .join('\n');
  return Buffer.from(
    [
      'OFXHEADER:100', 'DATA:OFXSGML', 'VERSION:102', 'CHARSET:1252', '<OFX>',
      '<CREDITCARDMSGSRSV1><CCSTMTTRNRS><CCSTMTRS>', '<BANKTRANLIST>',
      '<DTSTART>20260902000000[-3:BRT]</DTSTART>', '<DTEND>20261002000000[-3:BRT]</DTEND>',
      body, '</BANKTRANLIST>', '</CCSTMTRS></CCSTMTTRNRS></CREDITCARDMSGSRSV1>', '</OFX>',
    ].join('\n'),
    'utf8',
  );
}

const STATEMENT: Trn[] = [
  { fitid: 'st-1', date: '20260915', amount: '-64.90', memo: 'Padaria Aurora' },
  { fitid: 'st-2', date: '20260918', amount: '-210.00', memo: 'Oficina Ipsilon' },
];

function seedCard(): ResolvedCardAccount {
  const card = seedAccount({ id: CARD, householdId: HH, name: 'Cartao Teste', type: 'CREDIT', dueDay: 9, closingDay: 2 });
  return { id: card.id, name: card.name, type: 'CREDIT' as ResolvedCardAccount['type'], householdId: HH, dueDay: card.dueDay, closingDay: card.closingDay };
}

/** What POST /captures/:id/confirm leaves behind. */
function seedNotified(overrides: Partial<FakeTransaction> = {}): FakeTransaction {
  return seedTransaction({
    householdId: HH, accountId: CARD, type: 'EXPENSE', categoryName: 'GROCERIES', amount: 64.9, description: 'Padaria',
    date: '2026-09-15', sourceRef: NOTIF_REF, paid: true, ...overrides,
  });
}

const tx = (id: string) => store.transactions.find((t) => t.id === id)!;
const refsOf = (id: string) => store.refs.filter((r) => r.transactionId === id).map((r) => r.ref).sort();

function confirmRequest(preview: CardOfxPreviewResponse, overrides: Partial<CardOfxConfirmRequest> = {}): CardOfxConfirmRequest {
  return {
    accountId: preview.accountId,
    monthKey: preview.monthKey,
    lines: preview.lines.map(({ status: _status, group: _group, ...line }) => line),
    ledgerBalance: preview.ledgerBalance,
    paymentLineRef: preview.payment?.ref ?? null,
    selectedGroups: preview.proposals.filter((p) => p.defaultSelected).map((p) => p.group),
    categoryMap: preview.categoryMap.map((entry) => ({ key: entry.key, type: entry.type, target: { kind: 'default' as const } })),
    payment: { apply: true },
    ...overrides,
  };
}

beforeEach(() => {
  resetStore();
  vi.clearAllMocks();
});

describe('card OFX import: transactions confirmed from notifications', () => {
  let card: ResolvedCardAccount;
  beforeEach(() => {
    card = seedCard();
  });

  it('previews the statement line as an exact match of the notified transaction, not as a new purchase', async () => {
    const notified = seedNotified();

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });

    const match = preview.proposals.find((p) => p.kind === 'enrich-exact')!;
    expect(match).toMatchObject({ defaultSelected: true, ambiguous: false, target: { transactionId: notified.id, sourceRef: NOTIF_REF, amount: 64.9 } });
    expect(match.result).toMatchObject({ date: '2026-09-15', description: 'Padaria Aurora' });
    expect(preview.proposals.filter((p) => p.kind === 'create')).toHaveLength(1);
    expect(preview.proposals.find((p) => p.kind === 'create')!.refs).toHaveLength(1);
  });

  it('pairs and enriches on confirm: one transaction for the purchase, one created for the other line, sourceRef kept', async () => {
    const notified = seedNotified({ date: '2026-09-14' });
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });

    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card, userId: 'user-1' });

    expect(result).toMatchObject({ enriched: 1, created: 1, skipped: 0 });
    // Enriched: statement date and memo, the user's own description kept in the notes, still the notification's ref.
    expect(tx(notified.id)).toMatchObject({ sourceRef: NOTIF_REF, date: '2026-09-15', description: 'Padaria Aurora', notes: 'Notificação: Padaria', amount: 64.9 });
    expect(refsOf(notified.id)).toHaveLength(1);
    expect(refsOf(notified.id)[0]).toMatch(/^ofx:st-1:/);
    const onCard = store.transactions.filter((t) => t.accountId === CARD);
    expect(onCard).toHaveLength(2);
    expect(onCard.filter((t) => t.amount === 64.9)).toHaveLength(1);
    expect(onCard.find((t) => t.amount === 210)).toMatchObject({ description: 'Oficina Ipsilon' });
  });

  it('a second import of the same file changes nothing: every line reconciled, nothing proposed', async () => {
    seedNotified();
    const first = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });
    await confirmCardOfxImport({ request: confirmRequest(first), account: card });
    const snapshot = JSON.stringify(store);

    const again = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });
    expect(again.lines.every((l) => l.status === 'reconciled')).toBe(true);
    expect(again.proposals).toEqual([]);

    const repeat = await confirmCardOfxImport({ request: confirmRequest(first, { selectedGroups: first.proposals.map((p) => p.group) }), account: card });
    expect(repeat).toMatchObject({ enriched: 0, created: 0 });
    expect(JSON.stringify(store)).toBe(snapshot);
  });

  it('never pairs a notified transaction that already represents a statement line', async () => {
    const notified = seedNotified();
    seedRef({ householdId: HH, transactionId: notified.id, ref: 'ofx:older:deadbeef' });

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });

    expect(preview.proposals.filter((p) => p.kind === 'enrich-exact')).toEqual([]);
    expect(preview.proposals.filter((p) => p.kind === 'create')).toHaveLength(2);
  });

  it('skips the match when the notified transaction was linked by another confirm after the preview', async () => {
    const notified = seedNotified();
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });
    seedRef({ householdId: HH, transactionId: notified.id, ref: 'ofx:other:cafef00d' });
    const before = JSON.stringify(tx(notified.id));

    const result = await confirmCardOfxImport({ request: confirmRequest(preview), account: card });

    expect(result.enriched).toBe(0);
    expect(result.skipped).toBe(1);
    expect(JSON.stringify(tx(notified.id))).toBe(before);
    expect(refsOf(notified.id)).toEqual(['ofx:other:cafef00d']);
  });

  it('ignores notified transactions on another card or outside the date window', async () => {
    seedAccount({ id: 'card-2', householdId: HH, name: 'Outro cartao', type: 'CREDIT', dueDay: 9, closingDay: 2 });
    seedNotified({ accountId: 'card-2', sourceRef: `notif:${'b2'.repeat(20)}` });
    seedNotified({ date: '2026-09-05', sourceRef: `notif:${'c3'.repeat(20)}` }); // 10 days before the line

    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });

    expect(preview.proposals.filter((p) => p.kind === 'enrich-exact')).toEqual([]);
  });

  it('keeps a household without notifications exactly as before: both lines are new', async () => {
    const preview = await buildCardOfxPreview({ account: card, buffer: ofx(STATEMENT) });
    expect(preview.proposals.map((p) => p.kind)).toEqual(['create', 'create']);
    expect(fakeServices.createTransaction).not.toHaveBeenCalled();
  });
});
