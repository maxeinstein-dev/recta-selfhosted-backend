import { describe, expect, it } from 'vitest';

import { computeClosing } from './card-ofx-closing.js';
import { reconcileCardOfx, toCents, type ReconcileInput, type StoredCardRow } from './ofx-reconcile.js';
import {
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';

const PERIOD = { start: '2026-02-01', end: '2026-03-01' };

function line(fitid: string, memo: string, signed: number, date: string): CardOfxStatementLine {
  const kind = classifyCardOfxLine(memo, signed);
  return {
    ref: cardOfxRef(fitid, memo, signed, date, 1),
    fitid,
    date,
    amount: Math.abs(signed),
    type: cardOfxLineType(kind),
    kind,
    memo,
    merchant: merchantFromMemo(memo),
    installment: installmentFromMemo(memo),
  };
}

let seq = 0;
function row(description: string, amount: number, date: string, extra: Partial<StoredCardRow> = {}): StoredCardRow {
  seq += 1;
  return {
    id: `r${seq}`,
    description,
    amount,
    type: 'EXPENSE',
    date,
    sourceRef: `maxfin:2026-03:credit:${seq}`,
    notes: null,
    paid: true,
    installmentId: null,
    installmentNumber: null,
    totalInstallments: null,
    ...extra,
  };
}

function closing(lines: CardOfxStatementLine[], sheetRows: StoredCardRow[], stored: StoredCardRow[] = sheetRows, endInclusive = false, extra: Partial<ReconcileInput> = {}) {
  const input: ReconcileInput = {
    lines,
    sheetRows,
    futures: [],
    legacy: [],
    knownRefs: new Map(),
    linkedTransactionIds: new Set(),
    planNumbers: new Map(),
    paymentReference: null,
    ...extra,
  };
  const result = reconcileCardOfx(input);
  const ofxTotalCents = lines
    .filter((l) => l.kind !== 'payment')
    .reduce((total, l) => total + (l.type === 'EXPENSE' ? toCents(l.amount) : -toCents(l.amount)), 0);
  return computeClosing({ period: PERIOD, endInclusive, ofxTotalCents, lines, result, stored });
}

describe('computeClosing', () => {
  it('closes at zero when every line is matched to a row inside the period', () => {
    const rows = [row('Mercado', 100, '2026-02-01'), row('Posto', 50, '2026-02-01')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10'), line('b', 'Posto Y', -50, '2026-02-12')];

    const result = closing(lines, rows);

    expect(result).toMatchObject({ ofxTotal: 150, recordedTotal: 150, delta: 0, explained: true });
    expect(result.components).toMatchObject({ uncreated: 0, heldMatches: 0, sheetOnlyInPeriod: 0, foreignInPeriod: 0, residual: 0 });
  });

  it('explains a new purchase held back and a sheet row without a bank line inside the period', () => {
    const rows = [row('Mercado', 100, '2026-02-01'), row('Sem par', 30, '2026-02-01')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10'), line('b', 'Livraria', -40, '2026-02-12')];

    const result = closing(lines, rows);

    // The bank charged 140; the card will hold 130 (100 + the leftover sheet row): +40 held back, -30 extra.
    expect(result).toMatchObject({ ofxTotal: 140, recordedTotal: 130, delta: 10, explained: true });
    expect(result.components).toMatchObject({ uncreated: 40, sheetOnlyInPeriod: 30, residual: 0 });
  });

  it('counts a selected new purchase in the card total (nothing sheet-side is left over)', () => {
    const rows = [row('Mercado', 100, '2026-02-01')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10'), line('b', 'Livraria', -40, '2026-02-12')];

    const result = closing(lines, rows);

    expect(result).toMatchObject({ recordedTotal: 140, delta: 0, explained: true });
  });

  it('keeps a sheet row dated outside the period out of the card total and reports it apart', () => {
    const rows = [row('Mercado', 100, '2026-02-01'), row('Sem par', 30, '2026-03-02')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10')];

    const result = closing(lines, rows);

    expect(result.sheetOnlyOutsidePeriod).toBe(30);
    expect(result.components.sheetOnlyInPeriod).toBe(0);
    expect(result.recordedTotal).toBe(100);
  });

  it('counts a card row of another statement inside the period as foreign', () => {
    const rows = [row('Mercado', 100, '2026-02-01')];
    const foreign = row('De outro mes', 25, '2026-02-20', { sourceRef: 'maxfin:2026-02:credit:9' });
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10')];

    const result = closing(lines, rows, [...rows, foreign]);

    expect(result).toMatchObject({ recordedTotal: 125, delta: -25, explained: true });
    expect(result.components.foreignInPeriod).toBe(25);
  });

  it('shows a merge at the bank amount, absorbed rows gone', () => {
    const rows = [row('Zorbyt - Item A', 36.86, '2026-02-01'), row('Zorbyt - Item B', 54.44, '2026-02-01')];
    const lines = [line('m', 'Zorbit Gama', -91.3, '2026-02-14')];

    const result = closing(lines, rows);

    expect(result).toMatchObject({ ofxTotal: 91.3, recordedTotal: 91.3, delta: 0, explained: true });
  });

  it('splits an amount difference (beyond the near-amount step) between a held new purchase and the sheet row that stands for it', () => {
    const rows = [row('Mercado', 100.5, '2026-02-01')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10')];

    const result = closing(lines, rows);

    expect(result.delta).toBe(-0.5);
    expect(result.components).toMatchObject({ uncreated: 100, sheetOnlyInPeriod: 100.5, residual: 0 });
    expect(result.explained).toBe(true);
  });

  it('is not explained when matched rows sit outside the period', () => {
    const rows = [row('Mercado', 100, '2026-02-01')];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-03-10')];

    const result = closing(lines, rows);

    expect(result.recordedTotal).toBe(0);
    expect(result.explained).toBe(false);
  });

  it('leaves the closing day to the next statement unless the OFX lists lines on it', () => {
    const rows = [row('Mercado', 100, '2026-02-01')];
    const next = row('Da proxima fatura', 60, '2026-03-01', { sourceRef: 'maxfin:2026-04:credit:1' });
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10')];

    const exclusive = closing(lines, rows, [...rows, next]);
    const inclusive = closing(lines, rows, [...rows, next], true);

    expect(exclusive).toMatchObject({ recordedTotal: 100, endInclusive: false });
    expect(inclusive).toMatchObject({ recordedTotal: 160, endInclusive: true });
    expect(inclusive.components.foreignInPeriod).toBe(60);
  });

  it('explains the sheet credit that stands for an advance payment (not in the OFX total)', () => {
    const credit = row('Pagamento antecipado', 245.53, '2026-02-01', { type: 'INCOME' });
    const rows = [row('Mercado', 100, '2026-02-01'), credit];
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10'), line('p', 'Pagamento recebido', 245.53, '2026-02-05'), line('q', 'Pagamento recebido', 900, '2026-02-06')];

    const result = closing(lines, rows);

    expect(result.components.advancePayments).toBe(-245.53);
    expect(result).toMatchObject({ ofxTotal: 100, recordedTotal: -145.53, delta: 245.53, explained: true });
  });

  it('explains an advance payment credit that is already reconciled with its payment line', () => {
    const credit = row('Pagamento antecipado', 245.53, '2026-02-01', { type: 'INCOME' });
    const rows = [row('Mercado', 100, '2026-02-01'), credit];
    const advance = line('p', 'Pagamento recebido', 245.53, '2026-02-05');
    const lines = [line('a', 'Mercado Zeta', -100, '2026-02-10'), advance, line('q', 'Pagamento recebido', 900, '2026-02-06')];

    const result = closing(lines, rows, rows, false, { knownRefs: new Map([[advance.ref, credit.id]]), linkedTransactionIds: new Set([credit.id]) });

    expect(result.components.advancePayments).toBe(-245.53);
    expect(result).toMatchObject({ delta: 245.53, explained: true });
  });

  it('shows a near-amount match at the bank amount (the row adopts it)', () => {
    const rows = [row('Livraria', 100.03, '2026-02-01')];
    const lines = [line('a', 'Livraria Zeta', -100, '2026-02-10')];

    const result = closing(lines, rows);

    expect(result).toMatchObject({ ofxTotal: 100, recordedTotal: 100, delta: 0, explained: true });
  });
});
