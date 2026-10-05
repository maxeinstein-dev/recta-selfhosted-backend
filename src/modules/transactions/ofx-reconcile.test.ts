import { describe, expect, it } from 'vitest';

import {
  buildGroupId,
  countSubsetSums,
  MAX_GROUP_ID_LENGTH,
  MAX_GROUP_REFS,
  parseGroupId,
  reconcileCardOfx,
  subsetSumMatches,
  SUM_COUNT_BUDGET,
  SUM_MAX_CANDIDATES,
  toCents,
  wordsOf,
  type ReconcileInput,
  type ReconcileProposal,
  type ReconcileResult,
  type StoredCardRow,
} from './ofx-reconcile.js';
import {
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';

// Synthetic fixtures (invented stores and amounts) that reproduce the shapes of a real invoice: prepaid plans with
// their discount, aggregates typed as one sheet row, ties, a reversal pair, payments and advances.

const MONTH = '2026-10';

/** An OFX line exactly as the parser builds it. */
function line(fitid: string, memo: string, signedAmount: number, date = '2026-09-15', occurrence = 1): CardOfxStatementLine {
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

/** Installments first..last of one plan, as Nubank lists a prepayment: one FITID, "Parcela n/total". */
function planLines(fitid: string, merchant: string, first: number, last: number, total: number, each: number): CardOfxStatementLine[] {
  const lines: CardOfxStatementLine[] = [];
  for (let n = first; n <= last; n++) {
    lines.push(line(fitid, `${merchant} - Parcela ${n}/${total}`, -each, n === first ? '2026-09-02' : '2026-09-27'));
  }
  return lines;
}

let rowSeq = 0;

/** A card row the monthly sheet imported (phase 1): day 01, N/M stored, "+K" kept in the description. */
function sheetRow(description: string, amount: number, overrides: Partial<StoredCardRow> = {}): StoredCardRow {
  rowSeq += 1;
  const match = /(\d{1,2})\/(\d{1,2})/.exec(description);
  return {
    id: `sheet-${rowSeq}`,
    description,
    amount,
    type: 'EXPENSE',
    date: `${MONTH}-01`,
    sourceRef: `maxfin:${MONTH}:credit:${rowSeq}`,
    notes: null,
    paid: true,
    installmentId: match ? `maxfin:${description.split(' ')[0]!.toLowerCase()}:${match[2]}` : null,
    installmentNumber: match ? Number(match[1]) : null,
    totalInstallments: match ? Number(match[2]) : null,
    ...overrides,
  };
}

function storedRow(overrides: Partial<StoredCardRow> & Pick<StoredCardRow, 'id' | 'description' | 'amount'>): StoredCardRow {
  return {
    type: 'EXPENSE',
    date: `${MONTH}-01`,
    sourceRef: null,
    notes: null,
    paid: true,
    installmentId: null,
    installmentNumber: null,
    totalInstallments: null,
    ...overrides,
  };
}

function run(partial: Partial<ReconcileInput> & Pick<ReconcileInput, 'lines'>): ReconcileResult {
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

function proposalsOf(result: ReconcileResult, kind: ReconcileProposal['kind']): ReconcileProposal[] {
  return result.proposals.filter((p) => p.kind === kind);
}

function proposalFor(result: ReconcileResult, ref: string): ReconcileProposal {
  const proposal = result.proposals.find((p) => p.refs.includes(ref));
  if (!proposal) throw new Error(`no proposal covers ${ref}`);
  return proposal;
}

function refsOf(lines: CardOfxStatementLine[]): string[] {
  return lines.map((l) => l.ref).sort();
}

// ---------------------------------------------------------------------------
// A whole invoice with a sheet (the October shape)
// ---------------------------------------------------------------------------

describe('reconcileCardOfx: an invoice whose month has sheet rows', () => {
  // Five prepaid plans: installments N..N+K of one FITID plus the prepayment discount.
  const planA = [...planLines('fa', 'Curso Alfa - NuPay', 9, 20, 20, 50), line('fa', 'Desconto Antecipação Curso Alfa', 80, '2026-09-27')];
  const planB = [...planLines('fb', 'Loja Beta', 3, 7, 8, 30), line('fb', 'Desconto Antecipação Loja Beta', 6, '2026-09-27')];
  const planC = [...planLines('fc', 'Academia Gama', 6, 10, 12, 99.9), line('fc', 'Desconto Antecipação Academia Gama', 15.45, '2026-09-27')];
  const planD = [...planLines('fd', 'Ótica Delta', 1, 5, 5, 75), line('fd', 'Desconto Antecipação Ótica Delta', 9.99, '2026-09-27')];
  const planE = [...planLines('fe', 'Pet Epsilon', 4, 5, 7, 40), line('fe', 'Desconto Antecipação Pet Epsilon', 1.2, '2026-09-27')];
  const market = line('f1', 'Mercado Zeta', -123.45, '2026-09-20');
  const bakery = line('f2', 'Padaria Eta', -25, '2026-09-21');
  const pharmacy = line('f3', 'Farmacia Teta', -25, '2026-09-22');
  const iota = line('f4', 'Loja Iota - Parcela 2/5', -60, '2026-09-03');
  const kappa = line('f5', 'Loja Kappa - Parcela 4/5', -60, '2026-09-04');
  const fuel = [line('f6', 'Posto Lambda', -95, '2026-09-05'), line('f7', 'Posto Lambda', -110, '2026-09-12'), line('f8', 'Posto Lambda', -70, '2026-09-19')];
  const snack = [line('f9', 'Pastelaria Sigma', -38, '2026-09-06'), line('f10', 'Pastelaria Sigma', -9, '2026-09-06')];
  const reversed = [line('fm', 'Loja Mu', -149.9, '2026-09-08'), line('fm', 'Estorno de "Loja Mu" (Loja Mu)', 149.9, '2026-09-29')];
  const payment = line('fp', 'Pagamento recebido', 1500, '2026-09-02');
  const lines = [...planA, ...planB, ...planC, ...planD, ...planE, market, bakery, pharmacy, iota, kappa, ...fuel, ...snack, ...reversed, payment];

  const rows = {
    planA: sheetRow('Curso Alfa 9/20 +11', 520),
    planB: sheetRow('Loja Beta 3/8 +4', 144),
    planC: sheetRow('Academia Gama 6/12 +4', 484.06), // one cent off the bank: within the plan tolerance
    planD: sheetRow('Otica Delta 1/5 +4', 365.01),
    planE: sheetRow('Pet Epsilon 4/7 +1', 78.8),
    market: sheetRow('Mercado', 123.45),
    pharmacy: sheetRow('Farmácia', 25),
    bakery: sheetRow('Padaria', 25),
    one: sheetRow('Compra Um 4/5', 60),
    two: sheetRow('Compra Dois 2/5', 60),
    fuel: sheetRow('Combustivel', 275),
    snack: sheetRow('Pastelaria', 47),
  };
  const result = run({ lines, sheetRows: Object.values(rows) });

  it('matches every sheet row and leaves only the reversal pair on the OFX side', () => {
    expect(result.sheetOnly).toEqual([]);
    expect(proposalsOf(result, 'enrich-plan')).toHaveLength(5);
    expect(proposalsOf(result, 'enrich-exact')).toHaveLength(5);
    expect(proposalsOf(result, 'enrich-sum')).toHaveLength(2);
    expect(proposalsOf(result, 'reversal')).toHaveLength(1);
    expect(proposalsOf(result, 'create')).toEqual([]);
    expect(result.payment?.line.ref).toBe(payment.ref);
    expect(result.monthHasSheet).toBe(true);
  });

  it('pairs each "+K" row with installments N..N+K of one FITID and its discount', () => {
    for (const [row, plan] of [
      [rows.planA, planA],
      [rows.planB, planB],
      [rows.planC, planC],
      [rows.planD, planD],
      [rows.planE, planE],
    ] as const) {
      const proposal = proposalFor(result, plan[0]!.ref);
      expect(proposal).toMatchObject({ kind: 'enrich-plan', defaultSelected: true, ambiguous: false });
      expect(proposal.target?.id).toBe(row.id);
      expect(proposal.refs).toEqual(refsOf(plan));
    }
  });

  it('keeps the sheet description of a plan, takes the first line date and lists the lines in the notes', () => {
    const proposal = proposalFor(result, planE[0]!.ref);

    expect(proposal.result).toEqual({
      date: '2026-09-02',
      description: 'Pet Epsilon 4/7 +1',
      notesAppend:
        'OFX: 02/09 Pet Epsilon - Parcela 4/7 -40,00; 27/09 Pet Epsilon - Parcela 5/7 -40,00; 27/09 Desconto Antecipação Pet Epsilon +1,20',
    });
  });

  it('enriches one-to-one matches with the bank date and memo, the sheet text going to the notes', () => {
    expect(proposalFor(result, market.ref)).toMatchObject({
      kind: 'enrich-exact',
      target: { id: rows.market.id },
      result: { date: '2026-09-20', description: 'Mercado Zeta', notesAppend: 'Planilha: Mercado' },
    });
  });

  it('breaks ties of the same amount by words in common', () => {
    expect(proposalFor(result, bakery.ref).target?.id).toBe(rows.bakery.id);
    expect(proposalFor(result, pharmacy.ref).target?.id).toBe(rows.pharmacy.id);
    expect(proposalFor(result, bakery.ref).tieBroken).toBe(true);
    expect(proposalFor(result, market.ref).tieBroken).toBe(false);
  });

  it('breaks ties of the same amount by equal N/M before words', () => {
    expect(proposalFor(result, kappa.ref).target?.id).toBe(rows.one.id);
    expect(proposalFor(result, iota.ref).target?.id).toBe(rows.two.id);
  });

  it('pairs a sheet total with the purchases that add up to it (3 and 2 lines)', () => {
    const fuelSum = proposalFor(result, fuel[0]!.ref);
    expect(fuelSum).toMatchObject({ kind: 'enrich-sum', defaultSelected: true, ambiguous: false, target: { id: rows.fuel.id } });
    expect(fuelSum.refs).toEqual(refsOf(fuel));
    expect(fuelSum.result).toMatchObject({ date: '2026-09-05', description: 'Combustivel' });

    const snackSum = proposalFor(result, snack[0]!.ref);
    expect(snackSum).toMatchObject({ kind: 'enrich-sum', target: { id: rows.snack.id } });
    expect(snackSum.refs).toEqual(refsOf(snack));
  });

  it('proposes the purchase and its refund as an unselected reversal', () => {
    expect(proposalFor(result, reversed[0]!.ref)).toMatchObject({
      kind: 'reversal',
      refs: refsOf(reversed),
      defaultSelected: false,
      target: null,
      result: null,
    });
  });

  it('gives every line a status and every proposed line its group', () => {
    lines.forEach((l, i) => {
      const state = result.lines[i]!;
      if (l.kind === 'payment') {
        expect(state).toMatchObject({ status: 'payment', group: null });
      } else {
        expect(state.status).toBe('proposed');
        expect(result.proposals.find((p) => p.group === state.group)?.refs).toContain(l.ref);
      }
    });
  });

  it('builds deterministic group ids from kind, sorted refs and target', () => {
    for (const proposal of result.proposals) {
      expect(proposal.group).toBe(buildGroupId(proposal.kind, proposal.refs, proposal.target?.id ?? null));
    }
    const again = run({ lines: [...lines].reverse(), sheetRows: Object.values(rows) });
    expect(new Set(again.proposals.map((p) => p.group))).toEqual(new Set(result.proposals.map((p) => p.group)));
  });
});

// ---------------------------------------------------------------------------
// Single rules
// ---------------------------------------------------------------------------

describe('reconcileCardOfx: prepaid plans', () => {
  it('does not take a plan whose net is more than 2 cents off the row', () => {
    const plan = [...planLines('fa', 'Loja Alfa', 3, 4, 4, 50), line('fa', 'Desconto Antecipação Loja Alfa', 2)];
    const row = sheetRow('Loja Alfa 3/4 +1', 97.97);

    const result = run({ lines: plan, sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')).toEqual([]);
    expect(result.sheetOnly).toEqual([row]);
  });

  it('needs every installment N..N+K of the row in one FITID', () => {
    // 3 and 5 instead of 3 and 4; their net (110) is not the row either, so no other step takes them.
    const lines = [line('fa', 'Loja Alfa - Parcela 3/10', -50), line('fa', 'Loja Alfa - Parcela 5/10', -60)];
    const row = sheetRow('Loja Alfa 3/10 +1', 100);

    const result = run({ lines, sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')).toEqual([]);
    expect(result.sheetOnly).toEqual([row]);
  });

  it('takes only N..N+K and leaves the other installments of the FITID to the next steps', () => {
    const plan = planLines('fa', 'Loja Alfa', 3, 5, 10, 50);
    const row = sheetRow('Loja Alfa 3/10 +1', 100);

    const result = run({ lines: plan, sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')[0]?.refs).toEqual(refsOf(plan.slice(0, 2)));
    expect(proposalFor(result, plan[2]!.ref).kind).toBe('create');
  });
});

describe('reconcileCardOfx: plans without "+K" (net of a FITID)', () => {
  it('pairs a sheet expense with the net of every remaining line of one FITID', () => {
    const plan = [...planLines('fx', 'Loja Xi', 3, 4, 5, 100), line('fx', 'Desconto Antecipação Loja Xi', 4)];
    const row = sheetRow('Loja Xi', 196);

    const result = run({ lines: plan, sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')).toEqual([
      expect.objectContaining({ refs: refsOf(plan), target: expect.objectContaining({ id: row.id }) }),
    ]);
  });

  it('needs at least two lines (one line is an exact match, not a plan)', () => {
    const single = line('fx', 'Loja Xi', -196);
    const row = sheetRow('Loja Xi', 196);

    const result = run({ lines: [single], sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')).toEqual([]);
    expect(proposalsOf(result, 'enrich-exact')).toHaveLength(1);
  });
});

describe('reconcileCardOfx: exact matches', () => {
  it('pairs a sheet credit (negative value in the sheet) with a refund of the same amount', () => {
    const refund = line('fr', 'Estorno de "Loja Ro" (Loja Ro)', 35);
    const credit = sheetRow('Estorno Loja Ro', 35, { type: 'INCOME' });

    expect(proposalsOf(run({ lines: [refund], sheetRows: [credit] }), 'enrich-exact')).toEqual([
      expect.objectContaining({ refs: [refund.ref], target: expect.objectContaining({ id: credit.id }) }),
    ]);
  });

  it('accepts one cent of installment rounding when both sides carry the same N/M', () => {
    const bank = line('fa', 'Loja Alfa - Parcela 3/10', -33.34);
    const row = sheetRow('Loja Alfa 3/10', 33.33);

    const [exact] = proposalsOf(run({ lines: [bank], sheetRows: [row] }), 'enrich-exact');

    expect(exact).toMatchObject({
      refs: [bank.ref],
      defaultSelected: true,
      target: { id: row.id, amount: 33.33 },
      result: { date: bank.date, description: bank.memo, notesAppend: 'Planilha: Loja Alfa 3/10' },
    });
  });

  it('never accepts a cent without the same N/M, nor two cents with it', () => {
    const cases: Array<[CardOfxStatementLine, StoredCardRow]> = [
      [line('fa', 'Mercado Beta', -10.01), sheetRow('Mercado', 10)],
      [line('fa', 'Loja Alfa - Parcela 4/10', -33.34), sheetRow('Loja Alfa 3/10', 33.33)],
      [line('fa', 'Loja Alfa - Parcela 3/10', -33.35), sheetRow('Loja Alfa 3/10', 33.33)],
    ];
    for (const [bank, row] of cases) {
      const result = run({ lines: [bank], sheetRows: [row] });
      expect(proposalsOf(result, 'enrich-exact'), bank.memo).toEqual([]);
      expect(result.sheetOnly).toEqual([row]);
    }
  });

  it('prefers the same N/M a cent away to an exact amount without N/M, then the exact amount, then words', () => {
    const sameInstallment = line('fa', 'Loja Alfa - Parcela 3/10', -33.34);
    const plain = line('fb', 'Banca Beta', -33.33);
    const row = sheetRow('Loja Alfa 3/10', 33.33);
    expect(proposalFor(run({ lines: [plain, sameInstallment], sheetRows: [row] }), sameInstallment.ref).target?.id).toBe(row.id);

    const cent = line('fc', 'Curso Gama - Parcela 3/10', -50.01); // shares a word with the row, one cent off
    const exactAmount = line('fd', 'Loja Delta - Parcela 3/10', -50);
    const other = sheetRow('Curso Gama 3/10', 50);
    expect(proposalFor(run({ lines: [cent, exactAmount], sheetRows: [other] }), exactAmount.ref).target?.id).toBe(other.id);
  });

  it('never pairs different types of the same amount', () => {
    const refund = line('fr', 'Estorno de "Loja Ro" (Loja Ro)', 35);
    const expense = sheetRow('Loja Ro', 35);

    const result = run({ lines: [refund], sheetRows: [expense] });

    expect(proposalsOf(result, 'enrich-exact')).toEqual([]);
    expect(result.sheetOnly).toEqual([expense]);
  });
});

describe('reconcileCardOfx: proposals are disjoint', () => {
  it('never puts a line or a sheet row in two proposals, ambiguous sums included', () => {
    const lines = [line('s1', 'Loja Um', -10), line('s2', 'Loja Dois', -20), line('s3', 'Loja Tres', -15), line('s4', 'Loja Quatro', -15)];
    const rows = [sheetRow('Compras A', 30), sheetRow('Compras B', 30)];

    const result = run({ lines, sheetRows: rows });

    // The first row has two subsets (ambiguous, one proposal); the second takes what is left (15 + 15).
    expect(proposalsOf(result, 'enrich-sum').map((p) => [p.target?.id, p.ambiguous, p.refs])).toEqual([
      [rows[0]!.id, true, refsOf([lines[0]!, lines[1]!])],
      [rows[1]!.id, false, refsOf([lines[2]!, lines[3]!])],
    ]);
    const refs = result.proposals.flatMap((p) => p.refs);
    const targets = result.proposals.flatMap((p) => (p.target ? [p.target.id] : []));
    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('reconcileCardOfx: sums', () => {
  it('marks a sum with more than one subset ambiguous and unselected', () => {
    const lines = [line('s1', 'Loja Um', -10), line('s2', 'Loja Dois', -20), line('s3', 'Loja Tres', -15), line('s4', 'Loja Quatro', -15)];
    const row = sheetRow('Compras', 30);

    const [sum] = proposalsOf(run({ lines, sheetRows: [row] }), 'enrich-sum');

    expect(sum).toMatchObject({ ambiguous: true, defaultSelected: false, target: { id: row.id } });
    // The subset that keeps the lines tried first (file order here): 10 + 20.
    expect(sum!.refs).toEqual(refsOf([lines[0]!, lines[1]!]));
  });

  it('tries lines that share words with the row first', () => {
    const others = Array.from({ length: SUM_MAX_CANDIDATES }, (_, i) => line(`o${i}`, `Loja ${i}`, -(1 + i / 100)));
    const own = [line('a1', 'Sorveteria Sigma', -7), line('a2', 'Sorveteria Sigma', -5)];
    const row = sheetRow('Sorvete Sigma', 12);

    const [sum] = proposalsOf(run({ lines: [...others, ...own], sheetRows: [row] }), 'enrich-sum');

    expect(sum?.refs).toEqual(refsOf(own));
  });

  it('searches at most 15 candidates per row (the 16th line onwards is not tried)', () => {
    const filler = Array.from({ length: SUM_MAX_CANDIDATES }, (_, i) => line(`o${i}`, `Loja ${i}`, -(1 + i / 100)));
    const late = [line('l1', 'Posto Lambda', -7), line('l2', 'Posto Lambda', -5)];

    const result = run({ lines: [...filler, ...late], sheetRows: [sheetRow('Combustivel', 12)] });

    expect(proposalsOf(result, 'enrich-sum')).toEqual([]);
  });

  it('resolves smaller rows first so a large total does not absorb a small aggregate', () => {
    const lines = [line('t1', 'Loja Tau', -40), line('t2', 'Loja Tau', -10), line('t3', 'Loja Tau', -50)];
    const big = sheetRow('Compras grandes', 100);
    const small = sheetRow('Compras pequenas', 50); // 40 + 10, or the single 50 for the exact step

    const result = run({ lines, sheetRows: [big, small] });

    // The exact step takes the single 50 for the small row; the big one then finds no subset of 40 + 10.
    expect(proposalFor(result, lines[2]!.ref)).toMatchObject({ kind: 'enrich-exact', target: { id: small.id } });
    expect(result.sheetOnly).toEqual([big]);

    const twoAggregates = run({
      lines: [line('u1', 'Loja Upsilon', -30), line('u2', 'Loja Upsilon', -20), line('u3', 'Loja Upsilon', -50)],
      sheetRows: [sheetRow('Total do mes', 100), sheetRow('Lanches', 50)],
    });
    const lanches = twoAggregates.proposals.find((p) => p.target?.description === 'Lanches');
    expect(lanches).toMatchObject({ kind: 'enrich-exact' }); // the single 50 line
    expect(twoAggregates.sheetOnly.map((r) => r.description)).toEqual(['Total do mes']);
  });

  it('is ambiguous when another subset exists outside the search window (16 eligible lines)', () => {
    // The best 15 candidates hold only 2 + 3; the 16th (1) makes 1 + 4 another way to reach 5, 13 times over.
    const amounts = [2, 3, ...Array<number>(13).fill(4), 1];
    const lines = amounts.map((amount, i) => line(`u${i}`, 'Loja', -amount));

    const [sum] = proposalsOf(run({ lines, sheetRows: [sheetRow('Zzz', 5)] }), 'enrich-sum');

    expect(sum).toMatchObject({ ambiguous: true, defaultSelected: false });
    expect(sum!.refs).toEqual(refsOf([lines[0]!, lines[1]!]));
  });

  it('is ambiguous for a real-shaped pool: the words pick one subset and two more lines hide a second', () => {
    const own = [line('a1', 'Pastelaria Sigma', -38), line('a2', 'Pastelaria Sigma', -9)];
    const fillers = Array.from({ length: 13 }, (_, i) => line(`o${i}`, `Loja ${i}`, -46)); // eligible, combine with nothing
    const hidden = [line('h1', 'Banca Eta', -17), line('h2', 'Banca Teta', -30)]; // 17 + 30 = 47 too

    const [sum] = proposalsOf(run({ lines: [...own, ...fillers, ...hidden], sheetRows: [sheetRow('Pastelaria', 47)] }), 'enrich-sum');

    expect(sum).toMatchObject({ ambiguous: true, defaultSelected: false });
    expect(sum!.refs).toEqual(refsOf(own));
  });

  it('stays selected when a pool larger than the window holds no other subset', () => {
    const own = [line('a1', 'Pastelaria Sigma', -38), line('a2', 'Pastelaria Sigma', -9)];
    const fillers = Array.from({ length: 14 }, (_, i) => line(`o${i}`, `Loja ${i}`, -46));

    const [sum] = proposalsOf(run({ lines: [...own, ...fillers], sheetRows: [sheetRow('Pastelaria', 47)] }), 'enrich-sum');

    expect(sum).toMatchObject({ ambiguous: false, defaultSelected: true });
    expect(sum!.refs).toEqual(refsOf(own));
  });

  it('counts a pool larger than the window as ambiguous once the counting budget is spent', () => {
    // 5,000.00 against 102 lines: 102 * 500,000 cells is over SUM_COUNT_BUDGET, so the count is not attempted.
    expect(102 * 500_000).toBeGreaterThan(SUM_COUNT_BUDGET);
    const own = [line('a1', 'Reforma Sigma', -3000), line('a2', 'Reforma Sigma', -2000)];
    const fillers = Array.from({ length: 100 }, (_, i) => line(`o${i}`, `Loja ${i}`, -4999.99));

    const [sum] = proposalsOf(run({ lines: [...own, ...fillers], sheetRows: [sheetRow('Reforma', 5000)] }), 'enrich-sum');

    expect(sum).toMatchObject({ ambiguous: true, defaultSelected: false });
    expect(sum!.refs).toEqual(refsOf(own));
  });

  it('only sums purchases, never credits or payments', () => {
    const lines = [line('c1', 'Loja Chi', -20), line('c2', 'Estorno de "Loja Psi" (Loja Psi)', 10), line('c3', 'Loja Omega', -10)];
    const row = sheetRow('Total', 40);

    expect(proposalsOf(run({ lines, sheetRows: [row] }), 'enrich-sum')).toEqual([]);
  });
});

describe('reconcileCardOfx: stored future installments', () => {
  const futureOf = (id: string, number: number, total: number, amount: number, extra: Partial<StoredCardRow> = {}) =>
    storedRow({
      id,
      description: `Loja A ${number}/${total}`,
      amount,
      date: `2026-${String(9 + number).padStart(2, '0')}-01`,
      sourceRef: `maxfin:2026-09:credit:17:f${number - 3}`,
      notes: 'parcela futura gerada na importação de "Loja A 3/10"',
      installmentId: 'maxfin:loja-a:10',
      installmentNumber: number,
      totalInstallments: total,
      ...extra,
    });

  it('lets the real installment consume the stored future of the same N/M and amount', () => {
    const real = line('fa', 'Loja Alfa - Parcela 4/10', -50, '2026-11-03');
    const future = futureOf('fut-4', 4, 10, 50);

    const result = run({ lines: [real], futures: [future] });

    expect(proposalsOf(result, 'consume-future')).toEqual([
      expect.objectContaining({
        refs: [real.ref],
        defaultSelected: true,
        target: expect.objectContaining({ id: 'fut-4' }),
        result: { date: '2026-11-03', description: 'Loja Alfa - Parcela 4/10', notesAppend: 'Parcela futura: Loja A 4/10' },
      }),
    ]);
    expect(proposalsOf(result, 'create')).toEqual([]);
  });

  it('lets one stored future be consumed once: a second line of the same N/M and amount is new', () => {
    const first = line('fa', 'Loja Alfa - Parcela 4/10', -50);
    const second = line('fb', 'Loja Alfa - Parcela 4/10', -50, '2026-11-04'); // another purchase, same shape
    const future = futureOf('fut-4', 4, 10, 50);

    const result = run({ lines: [first, second], futures: [future] });

    expect(proposalsOf(result, 'consume-future')).toHaveLength(1);
    expect(proposalsOf(result, 'consume-future')[0]!.target?.id).toBe('fut-4');
    expect(proposalsOf(result, 'create')).toHaveLength(1);
    expect(new Set(result.proposals.flatMap((p) => p.refs)).size).toBe(2);
  });

  it('accepts one cent of difference and no more', () => {
    const real = line('fa', 'Loja Alfa - Parcela 4/10', -33.34);

    expect(proposalsOf(run({ lines: [real], futures: [futureOf('f', 4, 10, 33.33)] }), 'consume-future')).toHaveLength(1);
    expect(proposalsOf(run({ lines: [real], futures: [futureOf('f', 4, 10, 33.32)] }), 'consume-future')).toEqual([]);
  });

  it('consumes the futures N+1..N+K of a prepayment and leaves the discount as a new credit', () => {
    const plan = [...planLines('fa', 'Loja Alfa', 4, 7, 10, 50), line('fa', 'Desconto Antecipação Loja Alfa', 12)];
    const futures = [4, 5, 6, 7, 8].map((n) => futureOf(`fut-${n}`, n, 10, 50));

    const result = run({ lines: plan, futures });

    const consumed = proposalsOf(result, 'consume-future');
    expect(consumed.map((p) => p.target?.id)).toEqual(['fut-4', 'fut-5', 'fut-6', 'fut-7']);
    const [discount] = proposalsOf(result, 'create');
    expect(discount).toMatchObject({ refs: [plan[4]!.ref], defaultSelected: true, futureNumbers: [] });
  });

  it('prefers the plan the purchase itself generated (ofx:<FITID>) over another plan with the same N/M', () => {
    const real = line('fa', 'Loja Alfa - Parcela 4/10', -50);
    const other = futureOf('other', 4, 10, 50);
    const own = futureOf('own', 4, 10, 50, { installmentId: 'ofx:fa', sourceRef: 'ofx:fa:0000000a:f1', date: '2026-12-01' });

    expect(proposalsOf(run({ lines: [real], futures: [other, own] }), 'consume-future')[0]?.target?.id).toBe('own');
  });

  it('never offers a future that already represents an OFX line', () => {
    const real = line('fa', 'Loja Alfa - Parcela 4/10', -50);
    const future = futureOf('fut-4', 4, 10, 50);

    const result = run({ lines: [real], futures: [future], linkedTransactionIds: new Set(['fut-4']) });

    expect(proposalsOf(result, 'consume-future')).toEqual([]);
  });
});

describe('reconcileCardOfx: new lines', () => {
  const novo = line('fn', 'Loja Nova - Parcela 1/3', -70);
  const avulsa = line('fo', 'Banca Omicron', -9.5);

  it('creates one proposal per purchase, selected and with its futures in a month without sheet rows', () => {
    const result = run({ lines: [novo, avulsa] });

    expect(proposalsOf(result, 'create')).toEqual([
      expect.objectContaining({ refs: [novo.ref], defaultSelected: true, futureNumbers: [2, 3], futureBaseRef: novo.ref }),
      expect.objectContaining({ refs: [avulsa.ref], defaultSelected: true, futureNumbers: [], futureBaseRef: null }),
    ]);
  });

  it('skips future numbers its plan already stores', () => {
    const result = run({ lines: [novo], planNumbers: new Map([['ofx:fn', new Set([3])]]) });

    expect(proposalsOf(result, 'create')[0]?.futureNumbers).toEqual([2]);
  });

  it('comes unselected and without futures in a month that has sheet rows', () => {
    const result = run({ lines: [novo], sheetRows: [sheetRow('Outra coisa', 1)] });

    expect(proposalsOf(result, 'create')).toEqual([
      expect.objectContaining({ refs: [novo.ref], defaultSelected: false, futureNumbers: [] }),
    ]);
  });

  it('counts a month as a sheet month even when all its rows are already reconciled', () => {
    const row = sheetRow('Outra coisa', 1);

    const result = run({ lines: [novo], sheetRows: [row], linkedTransactionIds: new Set([row.id]) });

    expect(result.monthHasSheet).toBe(true);
    expect(result.sheetOnly).toEqual([]);
    expect(proposalsOf(result, 'create')[0]?.defaultSelected).toBe(false);
  });

  it('keeps the lines of one purchase together and generates no futures when part of it is elsewhere', () => {
    const plan = planLines('fq', 'Loja Qui', 2, 3, 6, 25);
    const known = new Map([[plan[0]!.ref, 'tx-known']]);

    const result = run({ lines: plan, knownRefs: known });

    expect(proposalsOf(result, 'create')).toEqual([
      expect.objectContaining({ refs: [plan[1]!.ref], futureNumbers: [], futureBaseRef: null }),
    ]);
  });
});

describe('reconcileCardOfx: lines already reconciled', () => {
  it('reports a line whose ref is recorded as reconciled, with its transaction', () => {
    const l = line('fa', 'Mercado Beta', -89.9);

    const result = run({ lines: [l], knownRefs: new Map([[l.ref, 'tx-1']]) });

    expect(result.lines[0]).toEqual({ status: 'reconciled', group: null, transactionId: 'tx-1', reconciledBy: 'ref' });
    expect(result.proposals).toEqual([]);
  });

  it('takes a sheet row that already represents OFX lines out of the candidates and out of sheetOnly', () => {
    const l = line('fa', 'Mercado Beta', -89.9);
    const row = sheetRow('Mercado', 89.9);

    const result = run({ lines: [l], sheetRows: [row], linkedTransactionIds: new Set([row.id]) });

    expect(proposalsOf(result, 'enrich-exact')).toEqual([]);
    expect(result.sheetOnly).toEqual([]);
  });

  it('matches legacy rows (no ref: same day, amount, type and description) one to one', () => {
    const twin = line('fa', 'Mercado Beta', -89.9, '2026-09-30');
    const second = line('fa', 'Mercado Beta', -89.9, '2026-09-30', 2);
    const legacy = storedRow({ id: 'legacy-1', description: 'Mercado  beta', amount: 89.9, date: '2026-09-30' });

    const result = run({ lines: [twin, second], legacy: [legacy] });

    expect(result.lines[0]).toMatchObject({ status: 'reconciled', transactionId: 'legacy-1', reconciledBy: 'legacy' });
    expect(result.lines[1]).toMatchObject({ status: 'proposed' });
  });

  it('does not take a legacy row of another day, amount or type', () => {
    const l = line('fa', 'Mercado Beta', -89.9, '2026-09-30');
    const legacy = [
      storedRow({ id: 'a', description: 'Mercado Beta', amount: 89.9, date: '2026-09-29' }),
      storedRow({ id: 'b', description: 'Mercado Beta', amount: 89.91, date: '2026-09-30' }),
      storedRow({ id: 'c', description: 'Mercado Beta', amount: 89.9, date: '2026-09-30', type: 'INCOME' }),
    ];

    expect(run({ lines: [l], legacy }).lines[0]?.status).toBe('proposed');
  });
});

describe('reconcileCardOfx: payments', () => {
  const pays = [
    line('p1', 'Pagamento recebido', 31, '2026-08-05'),
    line('p2', 'Pagamento recebido', 152.4, '2026-08-11'),
    line('p3', 'Pagamento recebido', 1000.5, '2026-08-09'),
    line('p4', 'Pagamento recebido', 207.15, '2026-08-20'),
  ];

  it('takes the payment closest to the previous invoice as its payment', () => {
    expect(run({ lines: pays, paymentReference: 1000 }).payment?.line.ref).toBe(pays[2]!.ref);
    expect(run({ lines: pays, paymentReference: 150 }).payment?.line.ref).toBe(pays[1]!.ref);
  });

  it('takes the largest payment when there is no reference', () => {
    expect(run({ lines: pays, paymentReference: null }).payment?.line.ref).toBe(pays[2]!.ref);
  });

  it('pairs the other payments (advances) with sheet credits of the same amount, the rest staying information', () => {
    const credits = [sheetRow('Pagamento antecipado', 31, { type: 'INCOME' }), sheetRow('Adiantamento', 207.15, { type: 'INCOME' })];

    const result = run({ lines: pays, paymentReference: 1000, sheetRows: credits });

    expect(proposalsOf(result, 'enrich-exact').map((p) => [p.refs[0], p.target?.id])).toEqual([
      [pays[0]!.ref, credits[0]!.id],
      [pays[3]!.ref, credits[1]!.id],
    ]);
    expect(result.unpairedAdvances.map((l) => l.ref)).toEqual([pays[1]!.ref]);
    expect(result.lines.map((s) => s.status)).toEqual(['proposed', 'payment', 'payment', 'proposed']);
    expect(result.proposals.some((p) => p.kind === 'create')).toBe(false);
  });

  it('flags a legacy card credit that already holds the payment', () => {
    const legacy = storedRow({ id: 'legacy-pay', description: 'Pagamento recebido', amount: 1000.5, type: 'INCOME', date: '2026-08-09' });

    const result = run({ lines: pays, paymentReference: 1000, legacy: [legacy] });

    expect(result.payment).toEqual({ line: pays[2], legacyDuplicateId: 'legacy-pay' });
  });

  it('never picks a payment line whose ref is already recorded', () => {
    const result = run({ lines: pays, paymentReference: 1000, knownRefs: new Map([[pays[2]!.ref, 'tx']]) });

    expect(result.payment?.line.ref).not.toBe(pays[2]!.ref);
  });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

describe('countSubsetSums', () => {
  it('counts the subsets of two values or more that reach the target, capped', () => {
    expect(countSubsetSums([2, 3], 5)).toBe(1);
    expect(countSubsetSums([2, 3, 1, 4], 5)).toBe(2); // 2+3 and 1+4
    expect(countSubsetSums([1, 1, 1, 1, 1, 1], 3, 2)).toBe(2); // 20 subsets, capped at 2
    expect(countSubsetSums([1, 1, 1, 1, 1, 1], 3, 100)).toBe(20);
  });

  it('ignores a value equal to the target (a subset of one) and values above it', () => {
    expect(countSubsetSums([5, 2, 3], 5)).toBe(1);
    expect(countSubsetSums([5, 7], 5)).toBe(0);
    expect(countSubsetSums([], 5)).toBe(0);
  });

  it('agrees with subsetSumMatches on random inputs', () => {
    let seed = 99;
    const next = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed % n;
    };
    for (let i = 0; i < 200; i++) {
      const values = Array.from({ length: 2 + next(12) }, () => 1 + next(9));
      const target = 3 + next(14);
      expect(countSubsetSums(values, target, 1_000_000), values.join(',')).toBe(subsetSumMatches(values, target).count);
    }
  });
});

describe('subsetSumMatches', () => {
  it('counts every subset of two values or more and returns the one that keeps the earliest values', () => {
    expect(subsetSumMatches([10, 20, 15, 15], 30)).toEqual({ count: 2, best: [0, 1] });
    expect(subsetSumMatches([15, 10, 20, 15], 30)).toEqual({ count: 2, best: [0, 3] });
    expect(subsetSumMatches([100, 120, 80, 46, 6], 300)).toEqual({ count: 1, best: [0, 1, 2] });
  });

  it('ignores single values and reports no match', () => {
    expect(subsetSumMatches([30, 1, 2], 30)).toEqual({ count: 0, best: null });
    expect(subsetSumMatches([1, 2], 10)).toEqual({ count: 0, best: null });
  });

  it('refuses more than SUM_MAX_CANDIDATES values', () => {
    expect(() => subsetSumMatches(Array.from({ length: SUM_MAX_CANDIDATES + 1 }, () => 1), 2)).toThrow();
  });
});

describe('group id size', () => {
  const LONG_FITID = 'x'.repeat(64);

  it('splits a purchase with more lines than a group may list, keeping every id under the cap', () => {
    const lines = Array.from({ length: 1000 }, (_, i) => line(LONG_FITID, `Loja Fatiada ${i}`, -(1 + i / 100), '2026-09-15'));

    const proposals = proposalsOf(run({ lines }), 'create');

    expect(proposals.map((p) => p.refs.length)).toEqual([150, 150, 150, 150, 150, 150, 100]);
    expect(proposals.every((p) => p.defaultSelected)).toBe(true);
    expect(Math.max(...proposals.map((p) => p.group.length))).toBeLessThanOrEqual(MAX_GROUP_ID_LENGTH);
    expect(new Set(proposals.flatMap((p) => p.refs)).size).toBe(1000);
    for (const p of proposals) expect(parseGroupId(p.group)?.refs).toEqual(p.refs);
  });

  it('keeps the longest possible group id under the cap', () => {
    const refs = Array.from({ length: MAX_GROUP_REFS }, (_, i) => `ofx:${LONG_FITID}:${String(i).padStart(8, '0')}`);

    expect(buildGroupId('enrich-plan', refs, '00000000-0000-4000-8000-000000000000').length).toBeLessThan(MAX_GROUP_ID_LENGTH);
  });

  it('leaves a FITID with more lines than a group may list to the create proposals, never to a plan', () => {
    const lines = Array.from({ length: MAX_GROUP_REFS + 1 }, (_, i) => line('big', 'Loja Grande', -1, `2026-09-${String(1 + (i % 28)).padStart(2, '0')}`, 1 + Math.floor(i / 28)));
    const row = sheetRow('Loja Grande', MAX_GROUP_REFS + 1);

    const result = run({ lines, sheetRows: [row] });

    expect(proposalsOf(result, 'enrich-plan')).toEqual([]);
    expect(proposalsOf(result, 'create').every((p) => p.group.length <= MAX_GROUP_ID_LENGTH)).toBe(true);
  });
});

describe('group ids', () => {
  it('round-trips kind, refs and target', () => {
    const id = buildGroupId('enrich-sum', ['ofx:b:2', 'ofx:a:1'], 'tx-1');

    expect(id).toBe('enrich-sum|ofx:a:1,ofx:b:2|tx-1');
    expect(parseGroupId(id)).toEqual({ kind: 'enrich-sum', refs: ['ofx:a:1', 'ofx:b:2'], targetId: 'tx-1' });
    expect(parseGroupId(buildGroupId('create', ['ofx:a:1'], null))).toEqual({ kind: 'create', refs: ['ofx:a:1'], targetId: null });
  });

  it('rejects text that is not a group id', () => {
    for (const bad of ['', 'create', 'steal|ofx:a:1|', 'create||', 'create|ofx:a:1,|', 'a|b|c|d']) {
      expect(parseGroupId(bad), bad).toBeNull();
    }
  });
});

describe('wordsOf', () => {
  it('drops accents, case, short words, numbers and installment noise', () => {
    expect(wordsOf('Açaí da Praça - NuPay - Parcela 3/10')).toEqual(new Set(['acai', 'praca']));
  });
});

describe('properties (seeded fuzz)', () => {
  const NAMES = ['Padaria', 'Mercado Livre', 'Posto Shell', 'Farmacia', 'Uber', 'Pastelaria', 'Combustivel', 'Loja X'];

  function generator(seed: number) {
    let state = seed;
    const random = () => (state = (state * 1664525 + 1013904223) % 4294967296) / 4294967296;
    return { random, int: (n: number) => Math.floor(random() * n) };
  }

  it('never double-uses a line or a row, matches a cent only with equal N/M, and never selects an ambiguous sum', () => {
    const { random, int } = generator(12345);
    let selectedSums = 0;
    for (let iteration = 0; iteration < 250; iteration++) {
      const count = 5 + int(26);
      const lines: CardOfxStatementLine[] = [];
      for (let i = 0; i < count; i++) {
        const r = random();
        const amount = (1 + int(6)) * (random() < 0.2 ? 1.01 : 1);
        const kind = r < 0.8 ? 'purchase' : r < 0.9 ? 'refund' : 'discount';
        const installment = kind === 'purchase' && random() < 0.4 ? { number: 1 + int(4), total: 4 + int(3) } : null;
        const name = NAMES[int(NAMES.length)]!;
        const memo = kind === 'discount' ? 'Desconto Antecipação' : installment ? `${name} - Parcela ${installment.number}/${installment.total}` : name;
        const date = `2026-09-${String(1 + int(28)).padStart(2, '0')}`;
        const signed = Math.round((kind === 'purchase' ? -amount : amount) * 100) / 100;
        const fitid = `f${int(Math.max(2, count / 2))}`;
        lines.push({
          ref: cardOfxRef(fitid, memo, signed, date, 1 + i),
          fitid,
          date,
          amount: Math.abs(signed),
          type: kind === 'purchase' ? 'EXPENSE' : 'INCOME',
          kind,
          memo,
          merchant: name,
          installment,
        });
      }
      const rows: StoredCardRow[] = Array.from({ length: int(count) }, (_, i) => {
        const installment = random() < 0.4 ? { number: 1 + int(4), total: 4 + int(3), prepaid: random() < 0.3 ? 1 + int(2) : 0 } : null;
        const name = NAMES[int(NAMES.length)]!;
        return storedRow({
          id: `s${i}`,
          description: installment ? `${name} ${installment.number}/${installment.total}${installment.prepaid ? ` +${installment.prepaid}` : ''}` : name,
          amount: Math.round((1 + int(12)) * (random() < 0.15 ? 1.01 : 1) * 100) / 100,
          type: random() < 0.9 ? 'EXPENSE' : 'INCOME',
          installmentNumber: installment?.number ?? null,
          totalInstallments: installment?.total ?? null,
        });
      });
      const futures = Array.from({ length: int(4) }, (_, i) => {
        const total = 4 + int(3);
        return storedRow({
          id: `fu${i}`,
          description: `Loja X ${1 + int(4)}/${total}`,
          amount: 1 + int(6),
          date: '2026-11-01',
          installmentId: `p${i}`,
          installmentNumber: 1 + int(4),
          totalInstallments: total,
        });
      });

      const result = run({ lines, sheetRows: rows, futures });

      const refs = result.proposals.flatMap((p) => p.refs);
      const targets = result.proposals.flatMap((p) => (p.target ? [p.target.id] : []));
      expect(new Set(refs).size, `iteration ${iteration}: a line is in two proposals`).toBe(refs.length);
      expect(new Set(targets).size, `iteration ${iteration}: a row is in two proposals`).toBe(targets.length);
      lines.forEach((l, i) => {
        if (result.lines[i]!.status === 'proposed') expect(refs, `iteration ${iteration}: orphan line`).toContain(l.ref);
      });
      for (const [index, p] of result.proposals.entries()) {
        if (p.kind === 'enrich-sum' && p.ambiguous) expect(p.defaultSelected, `iteration ${iteration}: ambiguous but selected`).toBe(false);
        if (p.kind === 'enrich-exact') {
          const target = p.target!;
          const bank = lines.find((l) => l.ref === p.refs[0])!;
          const difference = Math.abs(toCents(target.amount) - toCents(bank.amount));
          expect(difference, `iteration ${iteration}: exact over a cent`).toBeLessThanOrEqual(1);
          if (difference === 1) {
            const same = bank.installment && target.installmentNumber === bank.installment.number && target.totalInstallments === bank.installment.total;
            expect(same, `iteration ${iteration}: a cent without equal N/M`).toBeTruthy();
          }
          expect(target.type).toBe(bank.type);
        }
        if (p.kind === 'enrich-sum' && p.defaultSelected) {
          // A selected sum is the only subset of two or more among all the purchases still free at that point.
          selectedSums += 1;
          const rowCents = toCents(p.target!.amount);
          const earlier = new Set(result.proposals.slice(0, index).flatMap((q) => q.refs));
          const pool = lines.filter((l) => l.kind === 'purchase' && toCents(l.amount) <= rowCents && !earlier.has(l.ref));
          if (pool.length <= 16) {
            const cents = pool.map((l) => toCents(l.amount));
            let subsets = 0;
            for (let mask = 1; mask < 1 << cents.length; mask++) {
              if ((mask & (mask - 1)) === 0) continue;
              let total = 0;
              for (let bit = 0; bit < cents.length; bit++) if ((mask >> bit) & 1) total += cents[bit]!;
              if (total === rowCents) subsets += 1;
            }
            expect(subsets, `iteration ${iteration}: a selected sum with ${subsets} subsets`).toBe(1);
          }
        }
      }
    }
    expect(selectedSums).toBeGreaterThan(0); // the property is not vacuous
  });
});

describe('performance', () => {
  it('reconciles 200 lines against 120 sheet rows quickly', () => {
    const lines: CardOfxStatementLine[] = [];
    const rows: StoredCardRow[] = [];
    let seed = 7;
    const next = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648;
      return seed;
    };
    for (let i = 0; i < 200; i++) lines.push(line(`perf-${i}`, `Loja Perf ${i % 37}`, -((next() % 40000) + 100) / 100));
    // 60 exact rows, then 60 totals below what 15 candidates add up to: each one runs the whole subset search.
    for (let i = 0; i < 60; i++) rows.push(sheetRow(`Linha ${i}`, lines[i * 3]!.amount));
    for (let i = 0; i < 60; i++) rows.push(sheetRow(`Total ${i}`, 1500 + i / 100));

    const started = performance.now();
    const result = run({ lines, sheetRows: rows });
    const elapsed = performance.now() - started;

    expect(proposalsOf(result, 'enrich-exact').length).toBeGreaterThanOrEqual(60);
    expect(elapsed).toBeLessThan(1500);
  });
});
