import { describe, expect, it } from 'vitest';

import { merchantTokens, reconcileCardOfx, type ReconcileInput, type ReconcileProposal, type StoredCardRow } from './ofx-reconcile.js';
import {
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';

// Neighbour-month and merchant-group steps. Synthetic stores and amounts only.

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
function row(month: string, description: string, amount: number, extra: Partial<StoredCardRow> = {}): StoredCardRow {
  seq += 1;
  return {
    id: `row-${seq}`,
    description,
    amount,
    type: 'EXPENSE',
    date: `${month}-01`,
    sourceRef: `maxfin:${month}:credit:${seq}`,
    notes: null,
    paid: true,
    installmentId: null,
    installmentNumber: null,
    totalInstallments: null,
    ...extra,
  };
}

function run(partial: Partial<ReconcileInput> & Pick<ReconcileInput, 'lines'>) {
  return reconcileCardOfx({
    sheetRows: [],
    futures: [],
    legacy: [],
    knownRefs: new Map(),
    linkedTransactionIds: new Set(),
    planNumbers: new Map(),
    paymentReference: null,
    ...partial,
  });
}

const of = (result: ReturnType<typeof run>, kind: ReconcileProposal['kind']) => result.proposals.filter((p) => p.kind === kind);

describe('neighbour months', () => {
  // The statement is February's (sheet month 2026-02); the sheet typed the purchase in March.
  const anchor = row('2026-02', 'Banca Ponto', 1);
  const pontoLine = line('anc', 'Banca Ponto', -1, '2026-02-03');
  const purchase = line('n1', 'Livraria Sol', -57.9, '2026-02-26');

  it('matches a left-over line to an unlinked row of the next month: same amount, a shared word, within 10 days', () => {
    const next = row('2026-03', 'Livraria', 57.9);

    const result = run({ lines: [pontoLine, purchase], sheetRows: [anchor], neighbourRows: [next], neighbourStatementMonths: new Set(['2026-03']) });

    const [match] = of(result, 'enrich-neighbour');
    expect(match).toMatchObject({
      defaultSelected: true,
      ambiguous: false,
      reason: null,
      refs: [purchase.ref],
      target: { id: next.id },
      result: { date: '2026-02-26', description: 'Livraria Sol', notesAppend: 'Planilha: Livraria' },
    });
    expect(match!.group).toBe(`enrich-neighbour|${purchase.ref}|${next.id}`);
    expect(of(result, 'create')).toEqual([]);
    // The adjacent month's row is never reported as left over of THIS invoice.
    expect(result.sheetOnly).toEqual([]);
  });

  it('works for the previous month too; a fuzzy prefix (zorbit/zorbyt) only proposes, unselected', () => {
    const prev = row('2026-01', 'Livraria item a', 36.86, { date: '2026-01-31' });
    const strong = line('n2', 'Livraria*Gama', -36.86, '2026-02-04');
    const prevFuzzy = row('2026-01', 'Zorbyt item a', 36.86, { date: '2026-01-31' });
    const fuzzy = line('n2b', 'Zorbit*Gama', -36.86, '2026-02-04');
    const months = new Set(['2026-01']);

    const [match] = of(run({ lines: [pontoLine, strong], sheetRows: [anchor], neighbourRows: [prev], neighbourStatementMonths: months }), 'enrich-neighbour');
    const [weak] = of(run({ lines: [pontoLine, fuzzy], sheetRows: [anchor], neighbourRows: [prevFuzzy], neighbourStatementMonths: months }), 'enrich-neighbour');

    expect(match).toMatchObject({ defaultSelected: true, target: { id: prev.id } });
    expect(weak).toMatchObject({ defaultSelected: false, reason: 'neighbour-weak' });
  });

  it('is unselected unless the neighbour month statement was already imported (probes: Netflix, Posto)', () => {
    const netflix = row('2026-01', 'Netflix', 55.9, { date: '2026-01-31' });
    const bought = line('n4', 'NETFLIX.COM', -55.9, '2026-02-04');
    const posto = row('2026-01', 'Posto Ipiranga', 100, { date: '2026-01-31' });
    const shell = line('n5', 'POSTO SHELL', -100, '2026-02-04');

    const notImported = of(run({ lines: [pontoLine, bought], sheetRows: [anchor], neighbourRows: [netflix] }), 'enrich-neighbour')[0]!;
    const imported = of(run({ lines: [pontoLine, bought], sheetRows: [anchor], neighbourRows: [netflix], neighbourStatementMonths: new Set(['2026-01']) }), 'enrich-neighbour')[0]!;
    const generic = of(run({ lines: [pontoLine, shell], sheetRows: [anchor], neighbourRows: [posto], neighbourStatementMonths: new Set(['2026-01']) }), 'enrich-neighbour')[0]!;

    expect(notImported).toMatchObject({ defaultSelected: false, reason: 'neighbour-month-not-imported' });
    expect(imported).toMatchObject({ defaultSelected: true, reason: null });
    expect(generic).toMatchObject({ defaultSelected: false, reason: 'neighbour-weak' });
  });

  it('needs the exact amount, the same type, a word in common and at most 10 days', () => {
    const none = (next: StoredCardRow) => of(run({ lines: [pontoLine, purchase], sheetRows: [anchor], neighbourRows: [next] }), 'enrich-neighbour');

    expect(none(row('2026-03', 'Livraria', 57.91))).toEqual([]);
    expect(none(row('2026-03', 'Livraria', 57.9, { type: 'INCOME' }))).toEqual([]);
    expect(none(row('2026-03', 'Padaria', 57.9))).toEqual([]);
  });

  it('accepts exactly 10 days and refuses 11', () => {
    const at = (date: string) => of(run({ lines: [pontoLine, purchase], sheetRows: [anchor], neighbourRows: [row('2026-03', 'Livraria', 57.9, { date })] }), 'enrich-neighbour');

    // From 26 Feb (a 28-day month): 8 March is 10 days away, 9 March is 11.
    expect(at('2026-03-08')).toHaveLength(1);
    expect(at('2026-03-09')).toEqual([]);
  });

  it('never touches rows already linked, unpaid, installment, or flagged as blocked', () => {
    const base = (extra: Partial<StoredCardRow>) => row('2026-03', 'Livraria', 57.9, extra);
    const linked = base({});
    const check = (next: StoredCardRow, linkedIds: string[] = []) =>
      of(run({ lines: [pontoLine, purchase], sheetRows: [anchor], neighbourRows: [next], linkedTransactionIds: new Set(linkedIds) }), 'enrich-neighbour');

    expect(check(linked, [linked.id])).toEqual([]);
    expect(check(base({ paid: false }))).toEqual([]);
    expect(check(base({ installmentNumber: 2, totalInstallments: 5 }))).toEqual([]);
    expect(check(base({ mergeBlocked: true }))).toEqual([]);
  });

  it('is unselected, with a reason, when the line has two candidate rows or the row two candidate lines', () => {
    const a = row('2026-03', 'Livraria', 57.9);
    const b = row('2026-03', 'Livraria Sol', 57.9, { date: '2026-03-02' });
    const twoRows = run({ lines: [pontoLine, purchase], sheetRows: [anchor], neighbourRows: [a, b] });
    expect(of(twoRows, 'enrich-neighbour')).toHaveLength(1);
    expect(of(twoRows, 'enrich-neighbour')[0]).toMatchObject({ defaultSelected: false, ambiguous: true, reason: 'neighbour-ambiguous' });

    const second = line('n3', 'Livraria Norte', -57.9, '2026-02-27');
    const twoLines = run({ lines: [pontoLine, purchase, second], sheetRows: [anchor], neighbourRows: [a] });
    expect(of(twoLines, 'enrich-neighbour')).toHaveLength(1);
    expect(of(twoLines, 'enrich-neighbour')[0]).toMatchObject({ defaultSelected: false, reason: 'neighbour-ambiguous' });
    // The other line stays new.
    expect(of(twoLines, 'create')).toHaveLength(1);
  });

  it('comes after the exact match of this month: a row of this month wins, the neighbour row stays', () => {
    const own = row('2026-02', 'Livraria', 57.9);
    const next = row('2026-03', 'Livraria', 57.9);

    const result = run({ lines: [pontoLine, purchase], sheetRows: [anchor, own], neighbourRows: [next] });

    expect(of(result, 'enrich-exact').map((p) => p.target!.id)).toContain(own.id);
    expect(of(result, 'enrich-neighbour')).toEqual([]);
  });
});

describe('merchant groups', () => {
  const sheet = row('2026-02', 'Taxi/55', 40);
  // 16 unrelated lines of 33,33 push the 99 line out of the plain sum step's window of 15.
  const fillers = Array.from({ length: 16 }, (_, i) => line(`f${i}`, `Loja Fantasia ${i}`, -33.33, '2026-02-05'));
  const taxi = line('g1', 'Taxi', -15, '2026-02-06');
  const rides = line('g2', 'Dl*Taxibras', -10, '2026-02-07');
  const numbered = line('g3', 'Pg *55 Corrida', -15, '2026-02-08');

  it('matches a sheet row against several lines of the same merchant, selected when the solution is unique', () => {
    const result = run({ lines: [...fillers, taxi, rides, numbered], sheetRows: [sheet] });

    const [group] = of(result, 'enrich-group');
    expect(group).toMatchObject({ defaultSelected: true, ambiguous: false, reason: null, target: { id: sheet.id } });
    expect(group!.refs).toEqual([taxi.ref, rides.ref, numbered.ref].sort());
    expect(group!.result).toMatchObject({ date: '2026-02-06', description: 'Taxi/55' });
    expect(group!.result!.notesAppend).toContain('Taxi');
    expect(of(result, 'enrich-sum')).toEqual([]);
  });

  it('keeps the plain sum step first: when it finds the total, no group is proposed', () => {
    const result = run({ lines: [taxi, rides, numbered], sheetRows: [sheet] });

    expect(of(result, 'enrich-sum')).toHaveLength(1);
    expect(of(result, 'enrich-group')).toEqual([]);
  });

  it('is ambiguous and unselected when two subsets of the merchant make the total', () => {
    const other = line('g4', 'Dl*Taxix', -25, '2026-02-09');

    const [group] = of(run({ lines: [...fillers, taxi, rides, numbered, other], sheetRows: [sheet] }), 'enrich-group');

    expect(group).toMatchObject({ defaultSelected: false, ambiguous: true, reason: 'ambiguous' });
  });

  it('needs a merchant token in common, and ignores generic words', () => {
    const mismatch = row('2026-02', 'Presente', 40);
    expect(of(run({ lines: [...fillers, taxi, rides, numbered], sheetRows: [mismatch] }), 'enrich-group')).toEqual([]);
    const generic = row('2026-02', 'Loja', 40);
    expect(of(run({ lines: [...fillers, line('g5', 'Loja Fantasia', -15, '2026-02-09'), line('g6', 'Loja Azul', -25, '2026-02-09')], sheetRows: [generic] }), 'enrich-group')).toEqual([]);
  });

  it('never groups into a blocked row, an installment row, an income row, or a row smaller than the lines need', () => {
    for (const extra of [{ mergeBlocked: true }, { type: 'INCOME' as const }, { installmentNumber: 2, totalInstallments: 4 }]) {
      const guarded = row('2026-02', 'Taxi/55', 40, extra);
      expect(of(run({ lines: [...fillers, taxi, rides, numbered], sheetRows: [guarded] }), 'enrich-group'), JSON.stringify(extra)).toEqual([]);
    }
  });

  it('is unselected (pool-too-large or ambiguous) when the merchant has more lines than the window and another subset exists', () => {
    // 14 Taxi lines: more than the window of 12, with several subsets of 40.
    const many = Array.from({ length: 14 }, (_, i) => line(`m${i}`, `Dl*Taxix${i}`, -(10 + (i % 2) * 5), '2026-02-10'));

    const [group] = of(run({ lines: [...fillers, ...many], sheetRows: [sheet] }), 'enrich-group');

    expect(group).toMatchObject({ defaultSelected: false });
    expect(['ambiguous', 'pool-too-large']).toContain(group!.reason);
  });

  it('is exact to the cent', () => {
    const off = row('2026-02', 'Taxi/55', 40.01);

    expect(of(run({ lines: [...fillers, taxi, rides, numbered], sheetRows: [off] }), 'enrich-group')).toEqual([]);
  });

  it('never double-uses lines or rows together with the earlier steps (property)', () => {
    const result = run({ lines: [...fillers, taxi, rides, numbered], sheetRows: [sheet, row('2026-02', 'Fantasia', 66.66)] });

    const refs = result.proposals.flatMap((p) => p.refs);
    const targets = result.proposals.flatMap((p) => (p.target ? [p.target.id] : []));
    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('merchantTokens', () => {
  it('keeps 3+ letter words and 2+ digit numbers, drops accents and generic words', () => {
    expect([...merchantTokens('Pg *55 Corrida - Loja Água Ltda 2/3')].sort()).toEqual(['55', 'agua', 'corrida']);
  });
});
