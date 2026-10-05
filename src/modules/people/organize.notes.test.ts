import { describe, expect, it } from 'vitest';

import { classifyNote, readFreeText, reimbursementName } from './organize.notes.js';

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
