import { describe, expect, it } from 'vitest';

import {
  compareIdentity,
  detectRealignments,
  parseSheetRef,
  planilhaNotes,
  type RealignSheetRow,
  type RealignStored,
} from './maxfin-realign.js';
import type { MaxFinSectionKey } from './parsers/maxfin.types.js';

const KEY = '2026-10';
type Entry = [description: string, amount: number];

const sheet = (entries: Entry[], first = 11, section: MaxFinSectionKey = 'credit'): RealignSheetRow[] =>
  entries.map(([description, amount], i) => ({
    ref: `maxfin:${KEY}:${section}:${first + i}`,
    section,
    line: first + i,
    description,
    type: 'EXPENSE',
    amount,
    installment: null,
    accountId: `acc-${section}`,
  }));

const stored = (entries: Entry[], first = 11, section: MaxFinSectionKey = 'credit', extra: Partial<RealignStored> = {}): RealignStored[] =>
  entries.map(([description, amount], i) => ({
    id: `tx-${section}-${first + i}`,
    ref: `maxfin:${KEY}:${section}:${first + i}`,
    section,
    line: first + i,
    future: null,
    accountId: `acc-${section}`,
    type: 'EXPENSE',
    amount,
    description,
    notes: null,
    installment: null,
    linked: false,
    mergeTarget: false,
    ...extra,
  }));

const ORIGINAL: Entry[] = [
  ['Padaria Alfa', 10],
  ['Mercado Beta', 20],
  ['Farmacia Gama', 30],
  ['Posto Delta', 40],
  ['Cinema Epsilon', 50],
  ['Livraria Zeta', 60],
];

const detect = (sheetRows: RealignSheetRow[], storedRows: RealignStored[], tombstones: Array<{ section: MaxFinSectionKey; line: number }> = []) =>
  detectRealignments({ monthKey: KEY, sheetRows, stored: storedRows, tombstones });

describe('compareIdentity', () => {
  const row = sheet([['Mercado Beta', 20]])[0]!;
  const base = stored([['Mercado Beta', 20]])[0]!;

  it('matches on normalised description, type, amount and installment', () => {
    expect(compareIdentity(row, { ...base, description: '  MERCADO   beta ' })).toBe('match');
    expect(compareIdentity(row, { ...base, amount: 20.01 })).toBe('mismatch');
    expect(compareIdentity(row, { ...base, description: 'Mercado Gama' })).toBe('mismatch');
    expect(compareIdentity(row, { ...base, type: 'INCOME' })).toBe('mismatch');
    expect(compareIdentity(row, { ...base, accountId: 'acc-other' })).toBe('mismatch');
    expect(compareIdentity({ ...row, installment: { number: 2, total: 10 } }, base)).toBe('mismatch');
    expect(compareIdentity({ ...row, installment: { number: 2, total: 10 } }, { ...base, installment: { number: 2, total: 10 } })).toBe('match');
  });

  it('reads the sheet description of a row reconciled with the card statement from its note', () => {
    const linked = { ...base, linked: true, description: 'PADARIA BETA SP', notes: 'Planilha: Mercado Beta' };
    expect(compareIdentity(row, linked)).toBe('match');
    // The bank amount differed by cents: the note carries the sheet amount.
    expect(compareIdentity(row, { ...linked, amount: 19.98, notes: 'Planilha: Mercado Beta 20,00' })).toBe('match');
    // Without an amount in the note the amount is the sheet's: a different one is another row.
    expect(compareIdentity(row, { ...linked, amount: 19.98 })).toBe('mismatch');
    expect(compareIdentity(row, { ...linked, notes: 'Planilha: Outra Coisa' })).toBe('mismatch');
  });

  it('cannot compare a reconciled row without a note, or one that absorbed other rows', () => {
    expect(compareIdentity(row, { ...base, linked: true, description: 'LOJA X', notes: null })).toBe('neutral');
    expect(compareIdentity(row, { ...base, mergeTarget: true, description: 'LOJA X', amount: 99 })).toBe('neutral');
  });

  it('reads the first absorbed row from the note of the row that stayed after a merge', () => {
    const merged = { ...base, mergeTarget: true, description: 'LOJA X', amount: 50, notes: 'Planilha (soma de 2 linhas): Mercado Beta 20,00; Outra 30,00' };
    expect(compareIdentity(row, merged)).toBe('match');
    expect(compareIdentity(row, { ...merged, notes: 'Planilha (soma de 2 linhas): Outra 30,00; Mercado Beta 20,00' })).toBe('neutral');
  });
});

describe('planilhaNotes', () => {
  it('reads the notes the card statement import appends, with and without an amount', () => {
    expect(planilhaNotes('Jantar · Planilha: Mercado Beta 1.234,50 · Planilha (soma de 2 linhas): A 1,00; B 2,00')).toEqual([
      { description: 'Mercado Beta 1.234,50', amount: null },
      { description: 'Mercado Beta', amount: 1234.5 },
    ]);
    expect(planilhaNotes(null)).toEqual([]);
  });
});

describe('detectRealignments', () => {
  it('proposes nothing for a sheet that did not change', () => {
    expect(detect(sheet(ORIGINAL), stored(ORIGINAL))).toEqual([]);
  });

  it('proposes nothing for equal purchases in a row when nothing moved', () => {
    const same: Entry[] = [['Uber Eta', 12.9], ['Uber Eta', 12.9], ['Uber Eta', 12.9], ['Uber Eta', 12.9]];
    expect(detect(sheet(same), stored(same))).toEqual([]);
  });

  it('explains a row inserted in the middle as one block with shift +1 and the inserted row as new', () => {
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    const [block, ...rest] = detect(sheet(edited), stored(ORIGINAL));

    expect(rest).toEqual([]);
    expect(block).toMatchObject({ section: 'credit', shift: 1, kind: 'insertion', firstLine: 14, lastLine: 17, ambiguous: false, requires: [] });
    expect(block!.rows.map((r) => [r.from, r.to, r.verified])).toEqual([
      [`maxfin:${KEY}:credit:13`, `maxfin:${KEY}:credit:14`, true],
      [`maxfin:${KEY}:credit:14`, `maxfin:${KEY}:credit:15`, true],
      [`maxfin:${KEY}:credit:15`, `maxfin:${KEY}:credit:16`, true],
      [`maxfin:${KEY}:credit:16`, `maxfin:${KEY}:credit:17`, true],
    ]);
    expect(block!.insertedRefs).toEqual([`maxfin:${KEY}:credit:13`]);
  });

  it('explains a row inserted at the start of the block', () => {
    const edited: Entry[] = [['Uber Novo', 15], ...ORIGINAL];
    const [block] = detect(sheet(edited), stored(ORIGINAL));
    expect(block).toMatchObject({ shift: 1, firstLine: 12, lastLine: 17 });
    expect(block!.rows).toHaveLength(6);
    expect(block!.insertedRefs).toEqual([`maxfin:${KEY}:credit:11`]);
  });

  it('proposes nothing for a row appended at the end (nothing moved)', () => {
    expect(detect(sheet([...ORIGINAL, ['Uber Novo', 15]]), stored(ORIGINAL))).toEqual([]);
  });

  it('moves several lines for several inserted rows', () => {
    const edited: Entry[] = [...ORIGINAL.slice(0, 1), ['Uber Novo', 15], ['Taxi Novo', 16], ...ORIGINAL.slice(1)];
    const [block] = detect(sheet(edited), stored(ORIGINAL));
    expect(block).toMatchObject({ shift: 2, firstLine: 14, lastLine: 18 });
    expect(block!.insertedRefs).toEqual([`maxfin:${KEY}:credit:12`, `maxfin:${KEY}:credit:13`]);
  });

  it('explains a removed row: shift -1, the removed row keeps its transaction and takes the line the block vacates', () => {
    const edited = [...ORIGINAL.slice(0, 2), ...ORIGINAL.slice(3)];
    const [block] = detect(sheet(edited), stored(ORIGINAL));

    expect(block).toMatchObject({ shift: -1, kind: 'removal', firstLine: 13, lastLine: 15, ambiguous: false });
    expect(block!.rows.map((r) => [r.from, r.to])).toEqual([
      [`maxfin:${KEY}:credit:14`, `maxfin:${KEY}:credit:13`],
      [`maxfin:${KEY}:credit:15`, `maxfin:${KEY}:credit:14`],
      [`maxfin:${KEY}:credit:16`, `maxfin:${KEY}:credit:15`],
    ]);
    expect(block!.removed).toEqual([
      { transactionId: `tx-credit-13`, from: `maxfin:${KEY}:credit:13`, to: `maxfin:${KEY}:credit:16`, description: 'Farmacia Gama', amount: 30 },
    ]);
    expect(block!.insertedRefs).toEqual([]);
  });

  it('treats two insertions as two blocks, each with its own shift, the upper one depending on the lower', () => {
    const edited: Entry[] = [
      ORIGINAL[0]!, ORIGINAL[1]!, ['Uber Novo', 15], ORIGINAL[2]!, ORIGINAL[3]!, ['Taxi Novo', 16], ORIGINAL[4]!, ORIGINAL[5]!,
    ];
    const blocks = detect(sheet(edited), stored(ORIGINAL));

    expect(blocks.map((b) => [b.shift, b.firstLine, b.lastLine, b.requires])).toEqual([
      [1, 14, 15, [`credit:17:2`]],
      [2, 17, 18, []],
    ]);
  });

  it('proposes nothing when only one row after the insertion can be matched', () => {
    expect(detect(sheet([['Uber Novo', 15], ['Padaria Alfa', 10]]), stored([['Padaria Alfa', 10]]))).toEqual([]);
  });

  it('flags a row inserted equal to its neighbour as ambiguous (unticked)', () => {
    const edited: Entry[] = [ORIGINAL[0]!, ORIGINAL[1]!, ORIGINAL[1]!, ...ORIGINAL.slice(2)];
    const [block] = detect(sheet(edited), stored(ORIGINAL));
    expect(block).toBeDefined();
    expect(block!.ambiguous).toBe(true);
    expect(block!.reason).toMatch(/lado a lado|também bate/);
  });

  it('flags a removal of one of two equal rows as ambiguous, or proposes nothing', () => {
    const original: Entry[] = [ORIGINAL[0]!, ORIGINAL[1]!, ORIGINAL[1]!, ORIGINAL[2]!, ORIGINAL[3]!];
    const edited: Entry[] = [ORIGINAL[0]!, ORIGINAL[1]!, ORIGINAL[2]!, ORIGINAL[3]!];
    const blocks = detect(sheet(edited), stored(original));
    for (const block of blocks) expect(block.ambiguous).toBe(true);
  });

  it('keeps sections apart: the same shift in two sections gives one block each', () => {
    const edited: Entry[] = [['Uber Novo', 15], ...ORIGINAL];
    const blocks = detect(
      [...sheet(edited, 11, 'credit'), ...sheet(edited, 31, 'debit')],
      [...stored(ORIGINAL, 11, 'credit'), ...stored(ORIGINAL, 31, 'debit')],
    );
    expect(blocks.map((b) => [b.section, b.shift])).toEqual([['credit', 1], ['debit', 1]]);
  });

  it('does not take a row whose amount differs as proof, and drops the part that would land on it', () => {
    // Posto Delta changed its amount in the same edit: the run is cut there. The upper part (Mercado, Farmacia) would
    // land on the stored Posto Delta, which nobody moves, so only the lower part is proposed.
    const edited: Entry[] = [ORIGINAL[0]!, ['Uber Novo', 15], ORIGINAL[1]!, ORIGINAL[2]!, ['Posto Delta', 41], ORIGINAL[4]!, ORIGINAL[5]!];
    const blocks = detect(sheet(edited), stored(ORIGINAL));
    expect(blocks.map((b) => [b.firstLine, b.lastLine, b.shift])).toEqual([[16, 17, 1]]);
  });

  it('moves a row reconciled with the card statement along, by the sheet description in its note', () => {
    const storedRows = stored(ORIGINAL);
    storedRows[3] = { ...storedRows[3]!, linked: true, description: 'POSTO DELTA 1234', amount: 39.9, notes: 'Planilha: Posto Delta 40,00' };
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    const [block] = detect(sheet(edited), storedRows);
    expect(block!.rows).toHaveLength(4);
    expect(block!.rows.every((r) => r.verified)).toBe(true);
  });

  it('lets a reconciled row that cannot be compared travel between verified rows, never at the edge', () => {
    const storedRows = stored(ORIGINAL);
    storedRows[3] = { ...storedRows[3]!, linked: true, description: 'LOJA 99', notes: null };
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    const [block] = detect(sheet(edited), storedRows);
    expect(block!.rows.map((r) => r.verified)).toEqual([true, false, true, true]);

    // At the edge the neutral row is left out of the run, so the run would land on it: nothing is proposed.
    const lastNeutral = stored(ORIGINAL);
    lastNeutral[5] = { ...lastNeutral[5]!, linked: true, description: 'LOJA 99', notes: null };
    expect(detect(sheet(edited), lastNeutral)).toEqual([]);
  });

  it('lets an absorbed row (tombstone line) travel between verified rows and moves nothing for it', () => {
    // The stored purchase of line 13 was merged into another row: its line is only an external reference.
    const storedRows = stored(ORIGINAL).filter((s) => s.line !== 13);
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    const [block] = detect(sheet(edited), storedRows, [{ section: 'credit', line: 13 }]);
    expect(block).toBeDefined();
    expect(block!.rows.map((r) => r.from.split(':').pop())).toEqual(['14', '15', '16']);
  });

  it('moves the generated future installments of a moved row (their reference carries the row line)', () => {
    const storedRows = [...stored(ORIGINAL), ...stored([['Posto Delta 3/10', 40]], 15).map((s) => ({ ...s, id: 'future-1', ref: `maxfin:${KEY}:credit:15:f1`, future: 1 }))];
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    const [block] = detect(sheet(edited), storedRows);
    expect(block!.followers).toEqual([{ transactionId: 'future-1', from: `maxfin:${KEY}:credit:15:f1`, to: `maxfin:${KEY}:credit:16:f1` }]);
  });

  it('drops a block that would land on a stored row nobody moves', () => {
    // Line 16 holds an unrelated stored row (edited by hand): the chain would collide with it.
    const storedRows = stored(ORIGINAL);
    storedRows[5] = { ...storedRows[5]!, description: 'Editado a mao' };
    const edited: Entry[] = [...ORIGINAL.slice(0, 2), ['Uber Novo', 15], ...ORIGINAL.slice(2)];
    expect(detect(sheet(edited), storedRows)).toEqual([]);
  });
});

describe('parseSheetRef', () => {
  it('reads sheet refs and generated installments, and nothing else', () => {
    expect(parseSheetRef('maxfin:2026-10:credit:15')).toEqual({ monthKey: '2026-10', section: 'credit', line: 15, future: null });
    expect(parseSheetRef('maxfin:2026-10:credit:15:f2')).toEqual({ monthKey: '2026-10', section: 'credit', line: 15, future: 2 });
    expect(parseSheetRef('maxfin:2026-10:credit:15:mv')).toBeNull();
    expect(parseSheetRef('ofx:abc')).toBeNull();
  });
});
