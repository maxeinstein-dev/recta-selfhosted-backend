import { describe, expect, it } from 'vitest';

import { reconcileCardOfx, type ReconcileInput, type StoredCardRow } from './ofx-reconcile.js';
import { cardOfxLineType, cardOfxRef, classifyCardOfxLine, installmentFromMemo, merchantFromMemo, type CardOfxStatementLine } from './parsers/ofx-card.parser.js';

/**
 * Opposite direction of the recurrence adoption: the recurrence job generated the month's card occurrence first (no
 * sourceRef, the recurrence name, the expected amount, the scheduled day) and the statement OFX arrives later. Invented data.
 */
function line(fitid: string, memo: string, signedAmount: number, date: string): CardOfxStatementLine {
  const kind = classifyCardOfxLine(memo, signedAmount);
  return {
    ref: cardOfxRef(fitid, memo, signedAmount, date, 1), fitid, date, amount: Math.abs(signedAmount), type: cardOfxLineType(kind), kind, memo,
    merchant: merchantFromMemo(memo), installment: installmentFromMemo(memo),
  };
}

function occurrence(overrides: Partial<StoredCardRow>): StoredCardRow {
  return {
    id: 'job-occurrence', description: 'Seguro Alfa', amount: 90, type: 'EXPENSE', date: '2026-10-05', sourceRef: null,
    notes: 'Auto-generated from recurring transaction: rec-1 on 2026-10-05T01:00:00.000Z', paid: true,
    installmentId: null, installmentNumber: null, totalInstallments: null, ...overrides,
  };
}

function run(lines: CardOfxStatementLine[], legacy: StoredCardRow[]) {
  const input: ReconcileInput = {
    lines, sheetRows: [], futures: [], legacy, knownRefs: new Map(), linkedTransactionIds: new Set(), planNumbers: new Map(), paymentReference: null,
  };
  return reconcileCardOfx(input);
}

describe('statement OFX after the recurrence job generated the occurrence', () => {
  it('pairs when the bank line has the same day, amount and description as the occurrence (guard)', () => {
    const result = run([line('f1', 'Seguro Alfa', -90, '2026-10-05')], [occurrence({})]);
    expect(result.lines[0]).toMatchObject({ status: 'reconciled', transactionId: 'job-occurrence', reconciledBy: 'legacy' });
  });

  // CURRENT BEHAVIOUR, NOT DESIRED: the legacy rule is an exact key (day, cents, type, description). A bank line carries
  // the bank's name, the real amount and the purchase day, so it never pairs and the statement creates a second charge.
  // Recorded here so that fixing it (pairing through the recurrence name and aliases) turns this test red on purpose.
  it('does NOT pair when the bank uses another name, amount or day (known gap, not fixed in this batch)', () => {
    const result = run([line('f1', 'Pg *Seguro Alfa Conecta', -87.4, '2026-10-03')], [occurrence({})]);
    expect(result.lines[0]?.status).toBe('proposed');
    expect(result.lines[0]?.transactionId).toBeNull();
    expect(result.proposals.map((p) => p.kind)).toEqual(['create']);
  });

  it('does not pair even with the same name when only the amount differs (expected amount is a forecast)', () => {
    const result = run([line('f1', 'Seguro Alfa', -87.4, '2026-10-05')], [occurrence({})]);
    expect(result.lines[0]?.status).toBe('proposed');
  });
});
