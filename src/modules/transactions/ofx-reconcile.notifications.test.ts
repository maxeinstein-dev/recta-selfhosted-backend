import { describe, expect, it } from 'vitest';

import { reconcileCardOfx, type ReconcileInput, type ReconcileResult, type StoredCardRow } from './ofx-reconcile.js';
import {
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';

// Step 6e: statement lines paired with transactions confirmed from bank notifications (sourceRef `notif:`).
// Invented merchants and amounts only.

function line(fitid: string, memo: string, signedAmount: number, date: string, occurrence = 1): CardOfxStatementLine {
  const kind = classifyCardOfxLine(memo, signedAmount);
  return {
    ref: cardOfxRef(fitid, memo, signedAmount, date, occurrence),
    fitid,
    date,
    amount: Math.abs(signedAmount),
    type: cardOfxLineType(kind),
    kind,
    memo,
    merchant: merchantFromMemo(memo),
    installment: installmentFromMemo(memo),
  };
}

let seq = 0;
function notif(description: string, amount: number, date: string, overrides: Partial<StoredCardRow> = {}): StoredCardRow {
  seq += 1;
  return {
    id: `notif-${seq}`,
    description,
    amount,
    type: 'EXPENSE',
    date,
    sourceRef: `notif:${String(seq).padStart(40, '0')}`,
    notes: null,
    paid: true,
    installmentId: null,
    installmentNumber: null,
    totalInstallments: null,
    ...overrides,
  };
}
function sheet(description: string, amount: number, date = '2026-10-01'): StoredCardRow {
  seq += 1;
  return {
    id: `sheet-${seq}`, description, amount, type: 'EXPENSE', date, sourceRef: `maxfin:2026-10:credit:${seq}`,
    notes: null, paid: true, installmentId: null, installmentNumber: null, totalInstallments: null,
  };
}

function run(partial: Partial<ReconcileInput> & Pick<ReconcileInput, 'lines'>): ReconcileResult {
  return reconcileCardOfx({
    sheetRows: [], futures: [], legacy: [], knownRefs: new Map(), linkedTransactionIds: new Set(), planNumbers: new Map(), paymentReference: null,
    ...partial,
  });
}

const pairs = (result: ReconcileResult) =>
  result.proposals.filter((p) => p.kind === 'enrich-exact').map((p) => [p.target!.id, p.refs[0]!] as const);

describe('reconcileCardOfx: transactions confirmed from notifications', () => {
  it('pairs a line with a notified purchase of the same type and exact amount, enriching it', () => {
    const l = line('n1', 'Padaria Aurora', -23.9, '2026-09-10');
    const row = notif('Padaria', 23.9, '2026-09-10');

    const result = run({ lines: [l], notifRows: [row] });

    expect(result.proposals).toHaveLength(1);
    const p = result.proposals[0]!;
    expect(p).toMatchObject({ kind: 'enrich-exact', defaultSelected: true, ambiguous: false, tieBroken: false, refs: [l.ref] });
    expect(p.target).toBe(row);
    expect(p.result).toEqual({ date: '2026-09-10', description: 'Padaria Aurora', notesAppend: 'Notificação: Padaria' });
    expect(result.lines[0]).toMatchObject({ status: 'proposed', group: p.group });
    expect(result.proposals.some((x) => x.kind === 'create')).toBe(false);
  });

  it('does nothing without notification rows (empty or absent): the line is new', () => {
    const l = line('n1', 'Padaria Aurora', -23.9, '2026-09-10');
    for (const notifRows of [undefined, []]) {
      const result = run({ lines: [l], notifRows });
      expect(result.proposals.map((p) => p.kind)).toEqual(['create']);
    }
  });

  it('needs the exact amount: an installment line against a notification of the total does not match', () => {
    const l = line('n1', 'Loja Boreal - Parcela 1/3', -100, '2026-09-10');
    const row = notif('Loja Boreal', 300, '2026-09-10');

    const result = run({ lines: [l], notifRows: [row] });

    expect(pairs(result)).toEqual([]);
    expect(result.proposals.map((p) => p.kind)).toEqual(['create']);
  });

  it('needs the same type: a refund never takes a purchase notification, and a refund pairs with a credit', () => {
    const refund = line('n1', 'Estorno Loja Cobalto', 40, '2026-09-10');
    const expense = notif('Loja Cobalto', 40, '2026-09-10');
    const credit = notif('Estorno Cobalto', 40, '2026-09-10', { type: 'INCOME' });

    expect(pairs(run({ lines: [refund], notifRows: [expense] }))).toEqual([]);
    expect(pairs(run({ lines: [refund], notifRows: [expense, credit] }))).toEqual([[credit.id, refund.ref]]);
  });

  it('does not pair payment or discount lines', () => {
    const pay = line('p1', 'Pagamento recebido', 500, '2026-09-03');
    const discount = line('d1', 'Desconto Antecipação Loja Boreal', 10, '2026-09-27');
    const rows = [notif('Pagamento', 500, '2026-09-03', { type: 'INCOME' }), notif('Desconto', 10, '2026-09-27', { type: 'INCOME' })];
    expect(pairs(run({ lines: [pay, discount], notifRows: rows }))).toEqual([]);
  });

  describe('date window: statement 1 day before to 5 days after the notification', () => {
    const row = () => notif('Mercado', 50, '2026-09-10');
    it.each([
      ['same day', '2026-09-10', true],
      ['posted 4 days later (long weekend)', '2026-09-14', true],
      ['posted 5 days later', '2026-09-15', true],
      ['posted 6 days later', '2026-09-16', false],
      ['dated 1 day before (time zone straddling midnight)', '2026-09-09', true],
      ['dated 2 days before', '2026-09-08', false],
    ])('%s', (_label, lineDate, paired) => {
      const l = line('w1', 'Mercado Zeta', -50, lineDate);
      expect(pairs(run({ lines: [l], notifRows: [row()] })).length).toBe(paired ? 1 : 0);
    });
  });

  it('two lines of the same amount and one notification: the closest date takes it, the other line is new', () => {
    const near = line('a', 'Cafeteria Sol', -20, '2026-09-11');
    const far = line('b', 'Cafeteria Lua', -20, '2026-09-14');
    const row = notif('Cafe', 20, '2026-09-11');

    const result = run({ lines: [far, near], notifRows: [row] });

    expect(pairs(result)).toEqual([[row.id, near.ref]]);
    expect(result.proposals.find((p) => p.kind === 'enrich-exact')!.tieBroken).toBe(true);
    expect(result.proposals.filter((p) => p.kind === 'create').flatMap((p) => p.refs)).toEqual([far.ref]);
  });

  it('with equal distance, words in common decide; then file order', () => {
    const a = line('a', 'Lanchonete Brisa', -30, '2026-09-10');
    const b = line('b', 'Livraria Atlas', -30, '2026-09-10');
    const row = notif('Livraria', 30, '2026-09-10');
    expect(pairs(run({ lines: [a, b], notifRows: [row] }))).toEqual([[row.id, b.ref]]);

    const plain = notif('Compra', 30, '2026-09-10');
    expect(pairs(run({ lines: [a, b], notifRows: [plain] }))).toEqual([[plain.id, a.ref]]);
  });

  it('two notifications and two lines of one amount pair one to one, nothing used twice', () => {
    const l1 = line('a', 'Bar Cedro', -15, '2026-09-10');
    const l2 = line('b', 'Bar Cedro', -15, '2026-09-12');
    const r1 = notif('Bar', 15, '2026-09-10');
    const r2 = notif('Bar', 15, '2026-09-12');
    expect(pairs(run({ lines: [l1, l2], notifRows: [r1, r2] })).sort()).toEqual([[r1.id, l1.ref], [r2.id, l2.ref]].sort());
  });

  it('a notified purchase and an unnotified one of the same amount: one pairs, the other is created (nothing is lost)', () => {
    const l1 = line('a', 'Cinema Delta', -42, '2026-09-10');
    const l2 = line('b', 'Cinema Delta', -42, '2026-09-10');
    const row = notif('Cinema', 42, '2026-09-10');

    const result = run({ lines: [l1, l2], notifRows: [row] });

    expect(pairs(result)).toHaveLength(1);
    expect(result.proposals.filter((p) => p.kind === 'create')).toHaveLength(1);
    expect(result.proposals.filter((p) => p.kind === 'create' || p.kind === 'enrich-exact').flatMap((p) => p.refs).sort()).toEqual([l1.ref, l2.ref].sort());
  });

  it('never steals a line from a sheet row: the sheet pairs first and the notification stays unmatched', () => {
    const l = line('a', 'Mercado Zeta', -80, '2026-09-10');
    const sheetRow = sheet('Mercado', 80);
    const row = notif('Mercado', 80, '2026-09-10');

    const result = run({ lines: [l], sheetRows: [sheetRow], notifRows: [row] });

    expect(pairs(result)).toEqual([[sheetRow.id, l.ref]]);
    expect(result.proposals.some((p) => p.target === row)).toBe(false);
  });

  it('with a sheet row and a second line of that amount, the notification takes the line the sheet did not want', () => {
    const l1 = line('a', 'Mercado Zeta', -80, '2026-09-10');
    const l2 = line('b', 'Mercado Zeta', -80, '2026-09-11');
    const sheetRow = sheet('Mercado', 80);
    const row = notif('Mercado', 80, '2026-09-11');

    const result = run({ lines: [l1, l2], sheetRows: [sheetRow], notifRows: [row] });

    expect(pairs(result).map(([target]) => target).sort()).toEqual([sheetRow.id, row.id].sort());
    expect(result.proposals.some((p) => p.kind === 'create')).toBe(false);
  });

  it('never steals a line from a legacy row (same day, amount, type and description)', () => {
    const l = line('a', 'Farmacia Teta', -25, '2026-09-10');
    const legacy = { ...sheet('Farmacia Teta', 25, '2026-09-10'), sourceRef: null };
    const row = notif('Farmacia', 25, '2026-09-10');

    const result = run({ lines: [l], legacy: [legacy], notifRows: [row] });

    expect(result.lines[0]).toMatchObject({ status: 'reconciled', reconciledBy: 'legacy', transactionId: legacy.id });
    expect(result.proposals).toEqual([]);
  });

  it('a line whose ref is already recorded is not paired again', () => {
    const l = line('a', 'Padaria Aurora', -23.9, '2026-09-10');
    const result = run({ lines: [l], knownRefs: new Map([[l.ref, 'tx-existing']]), notifRows: [notif('Padaria', 23.9, '2026-09-10')] });
    expect(result.lines[0]).toMatchObject({ status: 'reconciled', reconciledBy: 'ref', transactionId: 'tx-existing' });
    expect(result.proposals).toEqual([]);
  });

  it('a notification row already tied to an external ref is never a candidate', () => {
    const l = line('a', 'Padaria Aurora', -23.9, '2026-09-10');
    const row = notif('Padaria', 23.9, '2026-09-10');
    const result = run({ lines: [l], notifRows: [row], linkedTransactionIds: new Set([row.id]) });
    expect(result.proposals.map((p) => p.kind)).toEqual(['create']);
  });

  it('only takes rows whose sourceRef starts with notif:', () => {
    const l = line('a', 'Padaria Aurora', -23.9, '2026-09-10');
    const stranger = notif('Padaria', 23.9, '2026-09-10', { sourceRef: 'manual:abc' });
    const none = notif('Padaria', 23.9, '2026-09-10', { sourceRef: null });
    expect(pairs(run({ lines: [l], notifRows: [stranger, none] }))).toEqual([]);
  });

  it('leaves a purchase and its refund to the reversal step (existing behaviour): the notification stays unpaired', () => {
    // The reversal step runs first and is unselected by default; the notification neither steals from it nor is it
    // paired with a line that step already claimed.
    const purchase = line('m', 'Loja Mu', -149.9, '2026-09-08');
    const refund = line('m', 'Estorno de "Loja Mu" (Loja Mu)', 149.9, '2026-09-29');
    const row = notif('Loja Mu', 149.9, '2026-09-08');

    const result = run({ lines: [purchase, refund], notifRows: [row] });

    expect(result.proposals.map((p) => p.kind)).toEqual(['reversal']);
    expect(result.proposals[0]!.defaultSelected).toBe(false);
  });
});
