import { describe, expect, it } from 'vitest';

import {
  RECURRENCE_DAYS_LINE_AFTER,
  RECURRENCE_DAYS_LINE_BEFORE,
  reconcileCardOfx,
  type ReconcileInput,
  type RecurrenceOccurrence,
  type StoredCardRow,
} from './ofx-reconcile.js';
import { cardOfxLineType, cardOfxRef, classifyCardOfxLine, installmentFromMemo, merchantFromMemo, type CardOfxStatementLine } from './parsers/ofx-card.parser.js';

// Step 6f: a left-over statement line pairs with an occurrence a recurrence generated, by the recurrence name. Invented data.

function line(fitid: string, memo: string, signedAmount: number, date: string): CardOfxStatementLine {
  const kind = classifyCardOfxLine(memo, signedAmount);
  return {
    ref: cardOfxRef(fitid, memo, signedAmount, date, 1), fitid, date, amount: Math.abs(signedAmount), type: cardOfxLineType(kind), kind, memo,
    merchant: merchantFromMemo(memo), installment: installmentFromMemo(memo),
  };
}

function row(id: string, overrides: Partial<StoredCardRow> = {}): StoredCardRow {
  return {
    id, description: 'Plano Beta', amount: 50, type: 'EXPENSE', date: '2026-10-10', sourceRef: null, notes: 'Auto-generated from recurring transaction: rec-1',
    paid: true, installmentId: null, installmentNumber: null, totalInstallments: null, recurringTransactionId: 'rec-1', ...overrides,
  };
}

function occ(id: string, overrides: Partial<StoredCardRow> = {}, names: string[] = ['Plano Beta']): RecurrenceOccurrence {
  return { row: row(id, overrides), names };
}

function run(lines: CardOfxStatementLine[], recurrenceRows?: RecurrenceOccurrence[], extra: Partial<ReconcileInput> = {}) {
  return reconcileCardOfx({
    lines, sheetRows: [], futures: [], legacy: [], knownRefs: new Map(), linkedTransactionIds: new Set(), planNumbers: new Map(), paymentReference: null,
    ...(recurrenceRows ? { recurrenceRows } : {}),
    ...extra,
  });
}

const kinds = (r: ReturnType<typeof run>) => r.proposals.map((p) => p.kind);
const shift = (base: string, days: number) => new Date(Date.parse(`${base}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

describe('reconcile step 6f: recurrence occurrences', () => {
  it('pairs the same name with another amount and day; the result carries the bank date and memo, and the old description goes to the notes', () => {
    const r = run([line('a', 'Plano Beta', -47.9, '2026-10-12')], [occ('o1')]);
    expect(kinds(r)).toEqual(['enrich-recurrence']);
    expect(r.proposals[0]).toMatchObject({
      target: { id: 'o1' }, defaultSelected: true, ambiguous: false, reason: null, tieBroken: false,
      result: { date: '2026-10-12', description: 'Plano Beta', notesAppend: 'Recorrência: Plano Beta 50,00' },
    });
    expect(r.lines[0]).toMatchObject({ status: 'proposed', transactionId: null });
  });

  it('pairs through an alias', () => {
    const r = run([line('a', 'Pg *Plano Beta Mensal', -47.9, '2026-10-10')], [occ('o1', {}, ['Plano Beta', 'Pg Plano Beta Mensal'])]);
    expect(kinds(r)).toEqual(['enrich-recurrence']);
  });

  it('does not pair a different name without an alias, and keeps proposing the creation', () => {
    const r = run([line('a', 'Pg *Plano Beta Mensal', -50, '2026-10-10')], [occ('o1')]);
    expect(kinds(r)).toEqual(['create']);
    expect(r.proposals[0]!.target).toBeNull();
  });

  it('does not pair an income line with an expense occurrence, nor an expense line with an income occurrence', () => {
    const credit = line('c', 'Plano Beta', 50, '2026-10-10');
    expect(credit.type).toBe('INCOME');
    const r = run([credit], [occ('o1', { type: 'EXPENSE' })]);
    expect(kinds(r)).not.toContain('enrich-recurrence');
    const rIncomeOcc = run([line('d', 'Plano Beta', -50, '2026-10-10')], [occ('o2', { type: 'INCOME' })]);
    expect(kinds(rIncomeOcc)).toEqual(['create']);
  });

  describe('window', () => {
    const base = '2026-10-10';

    it('uses the documented constants', () => {
      expect(RECURRENCE_DAYS_LINE_BEFORE).toBe(7);
      expect(RECURRENCE_DAYS_LINE_AFTER).toBe(10);
    });

    it('accepts the first and the last day of the window', () => {
      expect(kinds(run([line('a', 'Plano Beta', -50, shift(base, -RECURRENCE_DAYS_LINE_BEFORE))], [occ('o1', { date: base })]))).toEqual(['enrich-recurrence']);
      expect(kinds(run([line('a', 'Plano Beta', -50, shift(base, RECURRENCE_DAYS_LINE_AFTER))], [occ('o1', { date: base })]))).toEqual(['enrich-recurrence']);
    });

    it('refuses one day outside the window on both sides', () => {
      expect(kinds(run([line('a', 'Plano Beta', -50, shift(base, -RECURRENCE_DAYS_LINE_BEFORE - 1))], [occ('o1', { date: base })]))).toEqual(['create']);
      expect(kinds(run([line('a', 'Plano Beta', -50, shift(base, RECURRENCE_DAYS_LINE_AFTER + 1))], [occ('o1', { date: base })]))).toEqual(['create']);
    });

    it('never reaches the neighbouring month, even over the shortest gap (28 days)', () => {
      const feb = occ('feb', { date: '2026-02-01' });
      const mar = occ('mar', { date: '2026-03-01' });
      // 23 days after the first (out of reach) and 5 before the second.
      const r = run([line('a', 'Plano Beta', -50, '2026-02-24')], [feb, mar]);
      expect(r.proposals[0]).toMatchObject({ kind: 'enrich-recurrence', target: { id: 'mar' }, ambiguous: false });
      // 10 days after the first and 18 before the second: only the first.
      const r2 = run([line('a', 'Plano Beta', -50, '2026-02-11')], [feb, mar]);
      expect(r2.proposals[0]).toMatchObject({ target: { id: 'feb' }, ambiguous: false });
      expect(RECURRENCE_DAYS_LINE_BEFORE + RECURRENCE_DAYS_LINE_AFTER).toBeLessThan(28);
    });
  });

  describe('one to one', () => {
    it('two occurrences for one line: the closest date wins and the proposal is ambiguous and unselected', () => {
      const r = run([line('a', 'Plano Beta', -50, '2026-10-12')], [occ('far', { date: '2026-10-06' }), occ('near', { date: '2026-10-11' })]);
      expect(r.proposals).toHaveLength(1);
      expect(r.proposals[0]).toMatchObject({ kind: 'enrich-recurrence', target: { id: 'near' }, ambiguous: true, defaultSelected: false, reason: 'recurrence-ambiguous', tieBroken: true });
    });

    it('same distance: the closest amount, then the stable order', () => {
      const lineA = line('a', 'Plano Beta', -50, '2026-10-10');
      const byAmount = run([lineA], [occ('far', { date: '2026-10-08', amount: 80 }), occ('close', { date: '2026-10-12', amount: 51 })]);
      expect(byAmount.proposals[0]!.target!.id).toBe('close');
      const byOrder = run([lineA], [occ('first', { date: '2026-10-08', amount: 50 }), occ('second', { date: '2026-10-12', amount: 50 })]);
      expect(byOrder.proposals[0]!.target!.id).toBe('first');
    });

    it('two lines for one occurrence: only one line takes it, the other is created', () => {
      const closer = line('b', 'Plano Beta', -50, '2026-10-11');
      const r = run([line('a', 'Plano Beta', -50, '2026-10-14'), closer], [occ('o1')]);
      expect(kinds(r).sort()).toEqual(['create', 'enrich-recurrence']);
      const pair = r.proposals.find((p) => p.kind === 'enrich-recurrence')!;
      expect(pair.refs).toEqual([closer.ref]);
      expect(pair.ambiguous).toBe(true);
    });

    it('two lines and two occurrences: each pairs with its own, unambiguously', () => {
      const r = run(
        [line('a', 'Plano Beta', -50, '2026-10-10'), line('b', 'Plano Beta', -50, '2026-11-10')],
        [occ('oct', { date: '2026-10-10' }), occ('nov', { date: '2026-11-10' })],
      );
      expect(r.proposals.map((p) => p.target!.id).sort()).toEqual(['nov', 'oct']);
      expect(r.proposals.every((p) => !p.ambiguous)).toBe(true);
    });
  });

  describe('candidates', () => {
    it('an occurrence already tied to an OFX ref is not a candidate', () => {
      const r = run([line('a', 'Plano Beta', -50, '2026-10-10')], [occ('o1')], { linkedTransactionIds: new Set(['o1']) });
      expect(kinds(r)).toEqual(['create']);
    });

    it('an occurrence the legacy rule already took (exact day, amount and description) is not taken twice', () => {
      const legacyRow = row('o1', { amount: 50, date: '2026-10-10' });
      const r = run([line('a', 'Plano Beta', -50, '2026-10-10'), line('b', 'Plano Beta', -50, '2026-10-11')], [{ row: legacyRow, names: ['Plano Beta'] }], { legacy: [legacyRow] });
      expect(r.lines[0]).toMatchObject({ status: 'reconciled', reconciledBy: 'legacy', transactionId: 'o1' });
      expect(kinds(r)).toEqual(['create']);
    });

    it('an installment line is not paired with an occurrence', () => {
      const r = run([line('a', 'Plano Beta - Parcela 2/6', -50, '2026-10-10')], [occ('o1')]);
      expect(kinds(r)).not.toContain('enrich-recurrence');
    });

    it('a line a sheet row already took is not taken again', () => {
      const sheetRow = row('s1', { description: 'Plano Beta', amount: 50, sourceRef: 'maxfin:2026-10:credit:1', recurringTransactionId: null });
      const r = run([line('a', 'Plano Beta', -50, '2026-10-10')], [occ('o1')], { sheetRows: [sheetRow] });
      expect(kinds(r)).toEqual(['enrich-exact']);
    });
  });

  it('without recurrence occurrences the result is identical to the one without the input', () => {
    const lines = [line('a', 'Plano Beta', -50, '2026-10-10'), line('b', 'Loja Gama', -20, '2026-10-11')];
    const without = run(lines);
    expect(run(lines, [])).toEqual(without);
    expect(kinds(without)).toEqual(['create', 'create']);
  });
});
