import { describe, expect, it } from 'vitest';

import { aliasAlike, reconcileCardOfx, type ReconcileInput, type StoredCardRow } from './ofx-reconcile.js';
import {
  cardOfxLineType,
  cardOfxRef,
  classifyCardOfxLine,
  installmentFromMemo,
  merchantFromMemo,
  type CardOfxStatementLine,
} from './parsers/ofx-card.parser.js';

// Near-amount step: the same purchase a few cents apart. Synthetic stores and amounts only.

function line(fitid: string, memo: string, signed: number, date = '2026-04-10'): CardOfxStatementLine {
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
function row(description: string, amount: number, extra: Partial<StoredCardRow> = {}): StoredCardRow {
  seq += 1;
  const match = /(\d{1,2})\/(\d{1,2})/.exec(description);
  return {
    id: `near-${seq}`,
    description,
    amount,
    type: 'EXPENSE',
    date: '2026-04-01',
    sourceRef: `maxfin:2026-04:credit:${seq}`,
    notes: null,
    paid: true,
    installmentId: match ? `maxfin:p:${match[2]}` : null,
    installmentNumber: match ? Number(match[1]) : null,
    totalInstallments: match ? Number(match[2]) : null,
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

const near = (result: ReturnType<typeof run>) => result.proposals.filter((p) => p.kind === 'enrich-near');

describe('near amounts', () => {
  const anchorRow = () => row('Banca Ponto', 1);
  const anchorLine = line('anc', 'Banca Ponto', -1);

  it('matches a few cents apart and adopts the bank memo and date, noting the sheet amount', () => {
    const r = row('Livraria Sol', 55.37);

    const [p] = near(run({ lines: [anchorLine, line('a', 'Livraria Sol Central', -55.35)], sheetRows: [anchorRow(), r] }));

    expect(p).toMatchObject({
      defaultSelected: true,
      reason: null,
      ambiguous: false,
      target: { id: r.id },
      result: { date: '2026-04-10', description: 'Livraria Sol Central', notesAppend: 'Planilha: Livraria Sol 55,37' },
    });
  });

  it('accepts 1 to 5 cents and refuses 6; exact amounts stay with the exact step', () => {
    const at = (bank: number) => near(run({ lines: [anchorLine, line('a', 'Mercado Sol', -bank)], sheetRows: [anchorRow(), row('Mercado Sol', 10)] }));

    expect(at(10.01)).toHaveLength(1);
    expect(at(9.95)).toHaveLength(1);
    expect(at(10.05)).toHaveLength(1);
    expect(at(10.06)).toEqual([]);
    expect(at(10)).toEqual([]);
  });

  it('is selected with the same installment N/M even without a word in common', () => {
    const r = row('Item Teta 2/3', 55.37);

    const [p] = near(run({ lines: [anchorLine, line('b', 'Loja Omega - Parcela 2/3', -55.35)], sheetRows: [anchorRow(), r] }));

    expect(p).toMatchObject({ defaultSelected: true, reason: null });
  });

  it('is selected through the alias table (ifood ~ ifd) or an exact 5+ letter word; a fuzzy prefix or nothing in common is not enough', () => {
    const ifood = near(run({ lines: [anchorLine, line('c', 'Ifd*Gama Lanches', -46.79)], sheetRows: [anchorRow(), row('Almoco Delta Ifood', 46.76)] }))[0]!;
    const word = near(run({ lines: [anchorLine, line('d', 'Livraria Norte', -36.88)], sheetRows: [anchorRow(), row('Livraria item a', 36.86)] }))[0]!;
    const fuzzy = near(run({ lines: [anchorLine, line('d2', 'Zorbit*Gama', -36.88)], sheetRows: [anchorRow(), row('Zorbyt item a', 36.86)] }))[0]!;
    const weak = near(run({ lines: [anchorLine, line('e', 'Padaria Central', -24.02)], sheetRows: [anchorRow(), row('Lanche com amigo', 24)] }))[0]!;

    expect(ifood).toMatchObject({ defaultSelected: true, reason: null });
    expect(word).toMatchObject({ defaultSelected: true, reason: null });
    expect(fuzzy).toMatchObject({ defaultSelected: false, ambiguous: false, reason: 'near-amount' });
    expect(weak).toMatchObject({ defaultSelected: false, ambiguous: false, reason: 'near-amount' });
  });

  it('never selects on a generic shop word or a look-alike store (probes)', () => {
    const pair = (sheet: string, sheetAmount: number, bank: string, bankAmount: number) =>
      near(run({ lines: [anchorLine, line('p', bank, -bankAmount)], sheetRows: [anchorRow(), row(sheet, sheetAmount)] }))[0]!;

    // 'mercado' and 'posto' are generic; 'meli' alone is not 'mercado livre'.
    expect(pair('Mercado Central', 50.03, 'Mercado Livre*ABC', 50)).toMatchObject({ defaultSelected: false, reason: 'near-amount' });
    expect(pair('Meli Doces', 50.02, 'MERCADO LIVRE', 50)).toMatchObject({ defaultSelected: false, reason: 'near-amount' });
    expect(pair('Posto Ipiranga', 100.02, 'POSTO SHELL', 100)).toMatchObject({ defaultSelected: false, reason: 'near-amount' });
    // The real Mercado Livre subscription alias stays strong.
    expect(pair('Meli+', 8.92, 'MERCADO LIVRE*MELI', 8.9)).toMatchObject({ defaultSelected: true, reason: null });
  });

  it('is unselected when either side has another candidate', () => {
    const two = near(run({ lines: [anchorLine, line('f', 'Mercado Sol', -10.02)], sheetRows: [anchorRow(), row('Mercado Sol', 10), row('Mercado Sol Norte', 10.01)] }));
    expect(two).toHaveLength(1);
    expect(two[0]).toMatchObject({ defaultSelected: false, ambiguous: true, reason: 'near-ambiguous' });

    const twoLines = near(run({ lines: [anchorLine, line('g', 'Mercado Sol', -10.02), line('h', 'Mercado Sol Leste', -10.03)], sheetRows: [anchorRow(), row('Mercado Sol', 10)] }));
    expect(twoLines).toHaveLength(1);
    expect(twoLines[0]).toMatchObject({ defaultSelected: false, reason: 'near-ambiguous' });
  });

  it('never uses unpaid, blocked, prepaid, other-type rows, nor payment lines', () => {
    const lines = [anchorLine, line('i', 'Mercado Sol', -10.02)];
    for (const extra of [{ paid: false }, { mergeBlocked: true }, { type: 'INCOME' as const }]) {
      expect(near(run({ lines, sheetRows: [anchorRow(), row('Mercado Sol', 10, extra)] })), JSON.stringify(extra)).toEqual([]);
    }
    expect(near(run({ lines, sheetRows: [anchorRow(), row('Mercado Sol 2/5 +2', 10)] }))).toEqual([]);
    const pay = line('j', 'Pagamento recebido', 10.02);
    expect(near(run({ lines: [anchorLine, pay], sheetRows: [anchorRow(), row('Pagamento', 10, { type: 'INCOME' })] }))).toEqual([]);
  });

  it('comes after the exact match: an exact row wins and the near one stays left over', () => {
    const exact = row('Mercado Sol', 10);
    const close = row('Mercado Sol Norte', 10.02);

    const result = run({ lines: [anchorLine, line('k', 'Mercado Sol', -10)], sheetRows: [anchorRow(), exact, close] });

    expect(result.proposals.filter((p) => p.kind === 'enrich-exact').map((p) => p.target!.id)).toContain(exact.id);
    expect(near(result)).toEqual([]);
    expect(result.sheetOnly.map((r) => r.id)).toEqual([close.id]);
  });

  it('never double-uses a row or a line', () => {
    const result = run({
      lines: [anchorLine, line('l', 'Mercado Sol', -10.02), line('m', 'Mercado Norte', -20.04)],
      sheetRows: [anchorRow(), row('Mercado Sol', 10), row('Mercado Norte', 20)],
    });

    const refs = result.proposals.flatMap((p) => p.refs);
    const targets = result.proposals.flatMap((p) => (p.target ? [p.target.id] : []));
    expect(new Set(refs).size).toBe(refs.length);
    expect(new Set(targets).size).toBe(targets.length);
  });
});

describe('aliasAlike', () => {
  it('knows the few aliases and nothing else', () => {
    expect(aliasAlike('Almoco Ifood', 'Ifd*Padoca Beta')).toBe(true);
    expect(aliasAlike('Mercado Livre', 'Mercado Livre 123')).toBe(true);
    expect(aliasAlike('Mercado Livre', 'Meli+')).toBe(true);
    expect(aliasAlike('Meli Doces', 'MERCADO LIVRE')).toBe(false);
    expect(aliasAlike('Corrida Uber', 'Dl*Uber Trip')).toBe(true);
    expect(aliasAlike('Padaria', 'Ifd*Padaria Central')).toBe(false);
    expect(aliasAlike('Mercado Sol', 'Mercado Norte')).toBe(false);
    expect(aliasAlike('Cafe', 'Chifdoo')).toBe(false);
  });
});
