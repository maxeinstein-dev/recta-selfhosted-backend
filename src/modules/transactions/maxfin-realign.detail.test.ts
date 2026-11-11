import { describe, expect, it } from 'vitest';
import { blockToProposal } from './maxfin-realign.service.js';
import type { RealignBlock } from './maxfin-realign.js';

// Wording of the proposal detail shown on the import screen (invented data).
function block(over: Partial<RealignBlock>): RealignBlock {
  const row = (line: number) =>
    ({ transactionId: `t-${line}`, from: `maxfin:2025-03:credit:${line - 1}`, to: `maxfin:2025-03:credit:${line}`, sheetLine: line, verified: true, sheet: null, storedDescription: 'Loja Exemplo', storedAmount: 10 }) as unknown as RealignBlock['rows'][number];
  return {
    id: 'b1',
    section: 'credit',
    shift: 1,
    kind: 'insertion',
    firstLine: 14,
    lastLine: 17,
    rows: [row(14), row(15), row(16), row(17)],
    followers: [],
    removed: [],
    insertedRefs: [],
    requires: [],
    ambiguous: false,
    reason: null,
    ...over,
  };
}

describe('blockToProposal detail', () => {
  it('several rows moved by one inserted line: plural verb, single line named', () => {
    const { detail } = blockToProposal(block({}));
    expect(detail).toContain('4 lançamentos estão 1 linha abaixo da posição em que foram importados');
    expect(detail).toContain('(linha inserida acima, na linha 13)');
    expect(detail).not.toContain('foiram');
  });

  it('one row moved by two inserted lines: singular verb, line range', () => {
    const one = block({});
    const { detail } = blockToProposal(block({ shift: 2, firstLine: 15, lastLine: 15, rows: [one.rows[0]!] }));
    expect(detail).toContain('1 lançamento está 2 linhas abaixo da posição em que foi importado');
    expect(detail).toContain('(linhas inseridas acima, nas linhas 13 a 14)');
  });

  it('removal: plural verb as well', () => {
    const { detail } = blockToProposal(block({ shift: -1, kind: 'removal' }));
    expect(detail).toContain('4 lançamentos estão 1 linha acima da posição em que foram importados');
  });
});
