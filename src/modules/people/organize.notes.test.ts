import { describe, expect, it } from 'vitest';

import { buildFreeTextMatcher, classifyNote, readFreeText, reimbursementName } from './organize.notes.js';

// Invented names only.

describe('classifyNote', () => {
  it('reads the importer vocabulary through parseShareHint', () => {
    expect(classifyNote('*Dividir com Ana')).toMatchObject({ kind: 'hint', person: 'Ana', hint: { kind: 'split', percent: 50 } });
    expect(classifyNote('*Ana')).toMatchObject({ kind: 'hint', person: 'Ana', hint: { kind: 'owed_to_me', percent: 100 } });
    expect(classifyNote('Pagar a Ana')).toMatchObject({ kind: 'hint', person: 'Ana', hint: { kind: 'owed_by_me' } });
    expect(classifyNote('pagar à Ana')).toMatchObject({ kind: 'hint', person: 'Ana' });
    expect(classifyNote('*Reembolsar')).toEqual({ kind: 'reimbursable', segment: '*Reembolsar' });
  });

  it('reads "Divivir" as "Dividir" when the note starts with the star', () => {
    expect(classifyNote('*Divivir com Ana')).toMatchObject({ kind: 'hint', person: 'Ana', hint: { kind: 'split' } });
    expect(classifyNote('* divivir com Ana')).toMatchObject({ kind: 'hint', person: 'Ana', hint: { kind: 'split' } });
  });

  it('keeps the typo note without the star as free text (the sheet only marks shares with the star)', () => {
    expect(classifyNote('Divivir com Ana')).toEqual({ kind: 'free', text: 'Divivir com Ana' });
  });

  it('strips stray stars and spaces from the name', () => {
    expect(classifyNote('*Dividir com *Ana')).toMatchObject({ person: 'Ana' });
    expect(classifyNote('**  Ana  Maria ')).toMatchObject({ kind: 'hint', person: 'Ana Maria' });
  });

  it('finds the hint in the first segment of the text the importer builds', () => {
    const note = '*Dividir com Ana · previsto R$ 300,00 · antecipou 2 parcelas (3..4)';
    expect(classifyNote(note)).toEqual(expect.objectContaining({ kind: 'hint', person: 'Ana', segment: '*Dividir com Ana' }));
  });

  it('does not make a person out of a sharing word: "*Dividir", "*Dividido com todos"', () => {
    expect(classifyNote('*Dividir')).toEqual({ kind: 'free', text: '*Dividir' });
    expect(classifyNote('*Dividido com todo mundo')).toEqual({ kind: 'free', text: '*Dividido com todo mundo' });
    expect(classifyNote('*')).toEqual({ kind: 'free', text: '*' });
  });

  it('classifies everything else as free text, and nothing as none', () => {
    expect(classifyNote('compra no mercado')).toEqual({ kind: 'free', text: 'compra no mercado' });
    expect(classifyNote('')).toEqual({ kind: 'none' });
    expect(classifyNote('   ')).toEqual({ kind: 'none' });
    expect(classifyNote(null)).toEqual({ kind: 'none' });
    expect(classifyNote(undefined)).toEqual({ kind: 'none' });
  });

  it('caps the person name at 100 characters', () => {
    const result = classifyNote(`*${'a'.repeat(300)}`);
    expect(result.kind === 'hint' && result.person.length).toBe(100);
  });
});

describe('readFreeText', () => {
  it('finds known people as whole words, ignoring case and accents', () => {
    const reading = readFreeText('Jantar da JOSÉ e eu', ['jose', 'ana']);
    expect(reading.mentionedKeys).toEqual(['jose']);
    expect(reading.sharingWord).toBeNull();
  });

  it('does not match inside another word', () => {
    expect(readFreeText('Anarquia total', ['ana']).mentionedKeys).toEqual([]);
    expect(readFreeText('banana', ['ana']).mentionedKeys).toEqual([]);
  });

  it('matches multi-word names and punctuation around them', () => {
    expect(readFreeText('Pizza (com ana maria), sábado', ['ana maria']).mentionedKeys).toEqual(['ana maria']);
  });

  it('spots the sharing words, with their spelled-out form', () => {
    expect(readFreeText('Dividido com todo mundo', []).sharingWord).toBe('dividido');
    expect(readFreeText('Divivir com a turma', []).sharingWord).toBe('divivir');
    expect(readFreeText('vão me reembolsar', []).sharingWord).toBe('reembolso');
    expect(readFreeText('Pagar depois', []).sharingWord).toBe('pagar');
    expect(readFreeText('só uma observação', []).sharingWord).toBeNull();
  });
});

describe('reimbursementName', () => {
  it('reads "Reembolso - Nome" with the usual dashes', () => {
    expect(reimbursementName('Reembolso - Otto')).toBe('Otto');
    expect(reimbursementName('reembolso – Ana Maria')).toBe('Ana Maria');
    expect(reimbursementName('Reembolso: *Ana')).toBe('Ana');
  });

  it('is null for anything else', () => {
    expect(reimbursementName('Reembolso')).toBeNull();
    expect(reimbursementName('Reembolso - ')).toBeNull();
    expect(reimbursementName('Lulu')).toBeNull();
    expect(reimbursementName('Pedido de reembolso - Ana')).toBeNull();
  });
});

describe('classifyNote: what follows the star must look like one person', () => {
  const reasonOf = (note: string) => {
    const result = classifyNote(note);
    return result.kind === 'free' ? result.reason : undefined;
  };

  it('sends collectives to review as free text, with the reason', () => {
    for (const note of ['*Dividir com todo mundo', '*Dividir com todos', '*todas', '*Dividir com a galera', '*Dividir com a turma']) {
      expect(classifyNote(note)).toMatchObject({ kind: 'free', reason: expect.stringContaining('parece um grupo') });
    }
  });

  it('sends compound names to review', () => {
    for (const note of ['*Dividir com Ana e Bia', '*Ana, Bia', '*Ana & Bia', '*Ana + Bia', '*Ana/Bia']) {
      expect(reasonOf(note)).toMatch(/cita mais de uma pessoa/);
    }
  });

  it('sends phrases that are not names to review: digits, bills and items, very long names', () => {
    for (const note of ['*Parcela 3/10', '*Parcela 3 de 10', 'Pagar a conta de luz', 'Pagar a fatura do cartão', 'Pagar a Ana2', '*Dividir com Maria da Silva Santos Lima']) {
      expect(reasonOf(note)).toMatch(/não parece o nome de uma pessoa/);
    }
  });

  it('keeps ordinary names as hints, accents and two words included', () => {
    for (const [note, person] of [['*Dividir com José', 'José'], ['*Ana Paula', 'Ana Paula'], ['Pagar a Maria da Silva', 'Maria da Silva'], ['*Eduardo', 'Eduardo']] as const) {
      expect(classifyNote(note)).toMatchObject({ kind: 'hint', person });
    }
    // a name that merely contains the letter e is not a conjunction
    expect(classifyNote('*Renata')).toMatchObject({ kind: 'hint', person: 'Renata' });
  });
});

describe('buildFreeTextMatcher', () => {
  it('reads many notes against the same keys, in order of appearance', () => {
    const matcher = buildFreeTextMatcher(['ana', 'bia', 'ana maria']);
    expect(matcher.read('Bia e Ana foram').mentionedKeys).toEqual(['bia', 'ana']);
    expect(matcher.read('com Ana Maria hoje').mentionedKeys).toEqual(['ana', 'ana maria']);
    expect(matcher.read('ninguem').mentionedKeys).toEqual([]);
  });

  it('matches names in any script, not only Latin letters', () => {
    expect(buildFreeTextMatcher(['иван']).read('Обед с Иван в субботу').mentionedKeys).toEqual(['иван']);
  });

  it('ignores keys that normalize to no words and lists a key once however often it is mentioned', () => {
    const matcher = buildFreeTextMatcher(['', '---', 'ana']);
    expect(matcher.read('ana ana ana').mentionedKeys).toEqual(['ana']);
  });
});

describe('classifyNote with registered people', () => {
  const known = (...keys: string[]) => (key: string) => keys.includes(key);

  it('takes a registered name as written, however it looks', () => {
    expect(classifyNote('*Dividir com Luz Marina', known('luz marina'))).toMatchObject({ kind: 'hint', person: 'Luz Marina' });
    expect(classifyNote('*Dividir com Ana e Bia', known('ana e bia'))).toMatchObject({ kind: 'hint', person: 'Ana e Bia' });
    expect(classifyNote('*Todos', known('todos'))).toMatchObject({ kind: 'hint', person: 'Todos' });
    // the same texts for strangers still go to review
    expect(classifyNote('*Dividir com Ana e Bia', known('ana'))).toMatchObject({ kind: 'free', reason: expect.any(String) });
    expect(classifyNote('*Dividir com Luz Marina')).toMatchObject({ kind: 'free', reason: expect.stringContaining('não parece') });
  });

  it('takes the registered part before a suffix remark', () => {
    expect(classifyNote('Pagar a Bia - mensalidade', known('bia'))).toMatchObject({ kind: 'hint', person: 'Bia', segment: 'Pagar a Bia - mensalidade' });
    expect(classifyNote('*Dividir com André (irmão)', known('andre'))).toMatchObject({ kind: 'hint', person: 'André' });
    expect(classifyNote('*Dividir com André(irmão)', known('andre'))).toMatchObject({ kind: 'hint', person: 'André' });
  });

  it('keeps today\'s reading when the part before the remark is not registered', () => {
    expect(classifyNote('*Dividir com Caio - almoço', known('bia'))).toMatchObject({ kind: 'hint', person: 'Caio - almoço' });
    expect(classifyNote('*Dividir com Caio (irmão)', known())).toMatchObject({ kind: 'hint', person: 'Caio (irmão)' });
  });

  it('a registered person never turns a sharing word into a name', () => {
    expect(classifyNote('*Dividir', known('dividir'))).toEqual({ kind: 'free', text: '*Dividir' });
  });
});
