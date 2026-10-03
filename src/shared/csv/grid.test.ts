import { describe, expect, it } from 'vitest';

import { bufferToGrid, decodeCsvBuffer, detectDelimiter, parseCsvGrid } from './grid.js';

const BOM = Buffer.from([0xef, 0xbb, 0xbf]);

describe('decodeCsvBuffer', () => {
  it('decodes valid UTF-8 and reports utf-8', () => {
    const result = decodeCsvBuffer(Buffer.from('Café,Mês', 'utf8'));

    expect(result).toEqual({ text: 'Café,Mês', encoding: 'utf-8', hadBom: false });
  });

  it('strips a UTF-8 BOM and reports hadBom', () => {
    const result = decodeCsvBuffer(Buffer.concat([BOM, Buffer.from('a,b', 'utf8')]));

    expect(result).toEqual({ text: 'a,b', encoding: 'utf-8', hadBom: true });
  });

  it('falls back to windows-1252 when the bytes are not valid UTF-8', () => {
    const result = decodeCsvBuffer(Buffer.from([0x43, 0x61, 0x66, 0xe9]));

    expect(result).toEqual({ text: 'Café', encoding: 'windows-1252', hadBom: false });
  });

  it('maps the 0x80-0x9F range as windows-1252, not latin1', () => {
    // 0x80 is the euro sign in cp1252 but a C1 control character in latin1
    const result = decodeCsvBuffer(Buffer.from([0x80, 0x20, 0xe9]));

    expect(result.text).toBe('€ é');
    expect(result.encoding).toBe('windows-1252');
  });

  it('prefers UTF-8 when the bytes are valid in both encodings', () => {
    // "é" in UTF-8 is C3 A9, which cp1252 would read as "Ã©"
    const result = decodeCsvBuffer(Buffer.from([0xc3, 0xa9]));

    expect(result).toEqual({ text: 'é', encoding: 'utf-8', hadBom: false });
  });

  it('handles an empty buffer and a BOM-only buffer', () => {
    expect(decodeCsvBuffer(Buffer.alloc(0))).toEqual({ text: '', encoding: 'utf-8', hadBom: false });
    expect(decodeCsvBuffer(Buffer.from(BOM))).toEqual({ text: '', encoding: 'utf-8', hadBom: true });
  });
});

describe('detectDelimiter after a whitespace-only first line', () => {
  it('still recognises a quoted first cell on the next line (whitespace-only first line)', () => {
    // The quote is only an opening quote at the start of a field; the blank line must not leave the scanner mid-field.
    // Quoted separators must not be counted: with the quote missed, the commas inside it would tie the vote.
    expect(detectDelimiter('   \n"a,b,c";d;e\n')).toBe(';');
    expect(detectDelimiter('  \n"a;b;c;d",e,f\n')).toBe(',');
  });
});

describe('detectDelimiter', () => {
  it('returns , for comma separated input', () => {
    expect(detectDelimiter('a,b,c\n1,2,3')).toBe(',');
  });

  it('returns ; for semicolon separated input', () => {
    expect(detectDelimiter('data;descricao;valor\n1;2;3')).toBe(';');
  });

  it('ignores delimiters inside double quotes', () => {
    expect(detectDelimiter('"x;y;z",a,b')).toBe(',');
    expect(detectDelimiter('"a,b,c";d')).toBe(';');
  });

  it('defaults to , on a tie or when no delimiter is present', () => {
    expect(detectDelimiter('a;b,c')).toBe(',');
    expect(detectDelimiter('just text')).toBe(',');
    expect(detectDelimiter('')).toBe(',');
  });

  it('skips leading blank lines and decides on the first non-empty line', () => {
    expect(detectDelimiter('\r\n\n   \na;b;c\n1,2,3,4')).toBe(';');
  });

  it('is not fooled by a quoted first cell that spans lines', () => {
    expect(detectDelimiter('"Finanças X\nMês de outubro de 2026";;;\na,b,c,d')).toBe(';');
  });
});

describe('parseCsvGrid', () => {
  it('parses a MaxFin-style sheet whose first cell spans two lines', () => {
    const text = [
      '"Finanças X',
      'Mês de outubro de 2026",,,',
      'Data,Descrição,Valor,Obs',
      '01/10/2026,Aluguel,"R$ 1.300,00",',
    ].join('\n');

    expect(parseCsvGrid(text)).toEqual([
      ['Finanças X\nMês de outubro de 2026', '', '', ''],
      ['Data', 'Descrição', 'Valor', 'Obs'],
      ['01/10/2026', 'Aluguel', 'R$ 1.300,00', ''],
    ]);
  });

  it('keeps the delimiter inside quoted amounts', () => {
    expect(parseCsvGrid('"R$ 1.300,00","R$ -45,90"')).toEqual([['R$ 1.300,00', 'R$ -45,90']]);
  });

  it('unescapes doubled quotes inside quoted cells', () => {
    expect(parseCsvGrid('"He said ""hi""",""""')).toEqual([['He said "hi"', '"']]);
  });

  it('returns empty quoted cells as empty strings', () => {
    expect(parseCsvGrid('"",x,""')).toEqual([['', 'x', '']]);
  });

  it('does not trim cells', () => {
    expect(parseCsvGrid(' a , b ')).toEqual([[' a ', ' b ']]);
  });

  it('terminates records on CRLF without leaving \\r in cells', () => {
    expect(parseCsvGrid('a,b\r\n1,2\r\n')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('terminates records on a lone CR', () => {
    expect(parseCsvGrid('a,b\r1,2')).toEqual([
      ['a', 'b'],
      ['1', '2'],
    ]);
  });

  it('handles mixed line endings in one file', () => {
    expect(parseCsvGrid('a\r\nb\rc\nd')).toEqual([['a'], ['b'], ['c'], ['d']]);
  });

  it('normalizes line breaks inside quoted cells to \\n', () => {
    expect(parseCsvGrid('"x\r\ny",1\n"p\rq",2')).toEqual([
      ['x\ny', '1'],
      ['p\nq', '2'],
    ]);
  });

  it('preserves blank lines as a single empty cell so row numbers match the file', () => {
    expect(parseCsvGrid('a,b\n\n1,2')).toEqual([['a', 'b'], [''], ['1', '2']]);
    expect(parseCsvGrid('a,b\r\n\r\n1,2')).toEqual([['a', 'b'], [''], ['1', '2']]);
  });

  it('does not emit an extra record for a trailing line terminator', () => {
    expect(parseCsvGrid('a,b\n')).toEqual([['a', 'b']]);
    expect(parseCsvGrid('a,b\r\n')).toEqual([['a', 'b']]);
    expect(parseCsvGrid('a,b\n\n')).toEqual([['a', 'b'], ['']]);
  });

  it('returns no rows for empty text and one blank row for a single line break', () => {
    expect(parseCsvGrid('')).toEqual([]);
    expect(parseCsvGrid('\n')).toEqual([['']]);
  });

  it('keeps a stray quote inside an unquoted field literally', () => {
    expect(parseCsvGrid('a,b"c,d')).toEqual([['a', 'b"c', 'd']]);
    expect(parseCsvGrid('5" screen,x')).toEqual([['5" screen', 'x']]);
  });

  it('tolerates text after a closing quote and an unterminated quote at EOF', () => {
    expect(parseCsvGrid('"a"b,c')).toEqual([['ab', 'c']]);
    expect(parseCsvGrid('x,"unterminated\nstill inside')).toEqual([['x', 'unterminated\nstill inside']]);
  });

  it('keeps leading and trailing empty cells', () => {
    expect(parseCsvGrid(',')).toEqual([['', '']]);
    expect(parseCsvGrid('"a",')).toEqual([['a', '']]);
    expect(parseCsvGrid(',a,,')).toEqual([['', 'a', '', '']]);
  });

  it('uses ; when detected and honours an explicit delimiter', () => {
    expect(parseCsvGrid('a;b;"c;d"\n1;2;3')).toEqual([
      ['a', 'b', 'c;d'],
      ['1', '2', '3'],
    ]);
    expect(parseCsvGrid('a;b,c', ';')).toEqual([['a', 'b,c']]);
    expect(parseCsvGrid('a;b,c', ',')).toEqual([['a;b', 'c']]);
  });
});

describe('bufferToGrid', () => {
  it('decodes, detects the delimiter and parses in one call', () => {
    const csv =
      'Data;Descrição;Valor\r\n' +
      '01/10/2026;"Café; padaria";"R$ 12,50"\r\n' +
      '\r\n' +
      '02/10/2026;Mercado;"R$ 230,00"\r\n';
    const result = bufferToGrid(Buffer.concat([BOM, Buffer.from(csv, 'utf8')]));

    expect(result.delimiter).toBe(';');
    expect(result.encoding).toBe('utf-8');
    expect(result.hadBom).toBe(true);
    expect(result.grid).toEqual([
      ['Data', 'Descrição', 'Valor'],
      ['01/10/2026', 'Café; padaria', 'R$ 12,50'],
      [''],
      ['02/10/2026', 'Mercado', 'R$ 230,00'],
    ]);
  });

  it('handles a windows-1252 export with comma delimiter', () => {
    // latin1 encoding writes one byte per character, producing the same bytes a cp1252 export would
    const result = bufferToGrid(Buffer.from('Data,Descrição\n01/10/2026,Café\n', 'latin1'));

    expect(result.delimiter).toBe(',');
    expect(result.encoding).toBe('windows-1252');
    expect(result.hadBom).toBe(false);
    expect(result.grid).toEqual([
      ['Data', 'Descrição'],
      ['01/10/2026', 'Café'],
    ]);
  });
});
