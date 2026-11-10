import { describe, expect, it } from 'vitest';

import { reconcileCardOfx, type ReconcileInput, type RecurrenceOccurrence, type StoredCardRow } from './ofx-reconcile.js';
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
    installmentId: null, installmentNumber: null, totalInstallments: null, recurringTransactionId: 'rec-1', ...overrides,
  };
}

/** The occurrence as the service loads it for the recurrence step: with the names of the recurrence that generated it. */
function recurrence(row: StoredCardRow, names: string[] = ['Seguro Alfa']): RecurrenceOccurrence {
  return { row, names };
}

function run(lines: CardOfxStatementLine[], legacy: StoredCardRow[], recurrenceRows?: RecurrenceOccurrence[]) {
  const input: ReconcileInput = {
    lines, sheetRows: [], futures: [], legacy, knownRefs: new Map(), linkedTransactionIds: new Set(), planNumbers: new Map(), paymentReference: null,
    ...(recurrenceRows ? { recurrenceRows } : {}),
  };
  return reconcileCardOfx(input);
}

describe('statement OFX after the recurrence job generated the occurrence', () => {
  it('pairs when the bank line has the same day, amount and description as the occurrence (guard)', () => {
    const result = run([line('f1', 'Seguro Alfa', -90, '2026-10-05')], [occurrence({})]);
    expect(result.lines[0]).toMatchObject({ status: 'reconciled', transactionId: 'job-occurrence', reconciledBy: 'legacy' });
  });

  it('pairs through an alias of the recurrence when the bank uses another name, amount and day', () => {
    const row = occurrence({});
    const result = run([line('f1', 'Pg *Seguro Alfa Conecta', -87.4, '2026-10-03')], [row], [recurrence(row, ['Seguro Alfa', 'Pg Seguro Alfa Conecta'])]);
    expect(result.lines[0]?.status).toBe('proposed');
    expect(result.proposals.map((p) => p.kind)).toEqual(['enrich-recurrence']);
    expect(result.proposals[0]).toMatchObject({ target: { id: 'job-occurrence' }, defaultSelected: true, ambiguous: false });
  });

  it('pairs with the same name even when only the amount differs (expected amount is a forecast)', () => {
    const row = occurrence({});
    const result = run([line('f1', 'Seguro Alfa', -87.4, '2026-10-05')], [row], [recurrence(row)]);
    expect(result.lines[0]?.status).toBe('proposed');
    expect(result.proposals.map((p) => p.kind)).toEqual(['enrich-recurrence']);
  });

  it('keeps the old outcome (a second charge is proposed) when the service found no recurrence occurrence', () => {
    const result = run([line('f1', 'Pg *Seguro Alfa Conecta', -87.4, '2026-10-03')], [occurrence({})]);
    expect(result.proposals.map((p) => p.kind)).toEqual(['create']);
  });
});
