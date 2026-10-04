import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';

import { bufferToGrid } from '../../../shared/csv/grid.js';
import {
  clampText,
  detectMonthFromFilename,
  detectMonthFromTitle,
  detectYearFromName,
  findMaxFinHeaderIndex,
  parseInstallment,
  parseMaxFinGrid,
  parseMoneyBR,
  parseShareHint,
  sheetNameFromCsvFilename,
  slugify,
} from './maxfin.parser.js';
import type {
  Grid,
  MaxFinParseResult,
  MaxFinRow,
  MaxFinSectionKey,
  MaxFinSectionSummary,
} from './maxfin.types.js';

/**
 * Test-only RFC 4180 splitter. The real tokenizer lives in shared/csv and is
 * built in another lane; this one only needs to turn the fixture into a Grid.
 * Records end at CR, LF or CRLF outside quotes; quoted fields keep newlines
 * and unescape doubled quotes; blank lines become [''].
 */
function splitCsvForTests(text: string): Grid {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      row.push(field);
      field = '';
    } else if (ch === '\r' || ch === '\n') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field);
      rows.push(row);
      row = [];
      field = '';
    } else {
      field += ch;
    }
  }
  if (field.length > 0 || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

const FIXTURE_FILENAME = 'FINANÇAS_2026.xlsx - OUT.csv';
const fixtureText = readFileSync(
  new URL('./__fixtures__/maxfin-sample.csv', import.meta.url),
  'utf8',
);
const fixtureGrid = splitCsvForTests(fixtureText);
const fixture = parseMaxFinGrid(fixtureGrid);

const HEADER_ROW = [
  '',
  'Descrição',
  'Categoria',
  'Entrada - Previsto ',
  'Recebido ',
  'À receber',
  'Saída - Previsto',
  'Realizado ',
  'Saldo',
  '',
];

/** Title on line 1, blank line 2, header on line 3: data rows start at sourceLine 4. */
function buildGrid(
  rows: string[][],
  title = 'Finanças Teste\nMês de janeiro de 2026',
): Grid {
  return [[title], [''], HEADER_ROW, ...rows];
}

function rowOf(result: MaxFinParseResult, description: string): MaxFinRow {
  const row = result.rows.find((r) => r.description === description);
  if (!row) throw new Error(`row not found: ${description}`);
  return row;
}

function sectionOf(
  result: MaxFinParseResult,
  key: MaxFinSectionKey,
): MaxFinSectionSummary {
  const section = result.sections.find((s) => s.key === key);
  if (!section) throw new Error(`section not found: ${key}`);
  return section;
}

describe('parseMoneyBR', () => {
  it('parses Brazilian currency cells', () => {
    expect(parseMoneyBR('R$ 0,00')).toBe(0);
    expect(parseMoneyBR('-R$ 156,00')).toBe(-156);
    expect(parseMoneyBR('R$ 1.300,00')).toBe(1300);
    expect(parseMoneyBR('1.234,56')).toBeCloseTo(1234.56, 2);
    expect(parseMoneyBR('1234,56')).toBeCloseTo(1234.56, 2);
  });

  it('accepts plain decimal numbers', () => {
    expect(parseMoneyBR('1234.56')).toBeCloseTo(1234.56, 2);
    expect(parseMoneyBR(' 42 ')).toBe(42);
  });

  it('returns null for empty or non-numeric cells', () => {
    expect(parseMoneyBR('')).toBeNull();
    expect(parseMoneyBR('   ')).toBeNull();
    expect(parseMoneyBR('Saldo')).toBeNull();
    expect(parseMoneyBR('R$')).toBeNull();
  });
});

describe('parseInstallment', () => {
  it('parses "N/M" without prepaid installments', () => {
    expect(parseInstallment('Loja A 3/10')).toEqual({
      number: 3,
      total: 10,
      prepaid: 0,
      baseDescription: 'Loja A',
      installmentId: 'maxfin:loja-a:10',
      futureCount: 7,
    });
  });

  it('parses "+K" with or without spaces and closes the plan when N + K = M', () => {
    expect(parseInstallment('Curso B 5/12 +7')).toEqual({
      number: 5,
      total: 12,
      prepaid: 7,
      baseDescription: 'Curso B',
      installmentId: 'maxfin:curso-b:12',
      futureCount: 0,
    });
    expect(parseInstallment('Remédios 1/4 + 1')).toEqual({
      number: 1,
      total: 4,
      prepaid: 1,
      baseDescription: 'Remédios',
      installmentId: 'maxfin:remedios:4',
      futureCount: 2,
    });
  });

  it('keeps the installmentId stable across months of the same plan', () => {
    expect(parseInstallment('Curso B 5/12 +7')?.installmentId).toBe(
      parseInstallment('curso b 6/12')?.installmentId,
    );
  });

  it('returns null when there is no installment pattern', () => {
    expect(parseInstallment('Mercado')).toBeNull();
    expect(parseInstallment('Pedido 123/4567')).toBeNull();
  });

  it('rejects invalid installments (N outside 1..M or N + K > M)', () => {
    expect(parseInstallment('Loja Z 0/5')).toBeNull();
    expect(parseInstallment('Loja Z 6/5')).toBeNull();
    expect(parseInstallment('Loja Z 3/5 +4')).toBeNull();
  });
});

describe('parseShareHint', () => {
  it('recognizes "*Dividir com X" as a 50% split', () => {
    expect(parseShareHint('*Dividir com Fulano')).toEqual({
      kind: 'split',
      person: 'Fulano',
      percent: 50,
    });
  });

  it('recognizes "*Reembolsar" as reimbursable', () => {
    expect(parseShareHint('*Reembolsar')).toEqual({
      kind: 'reimbursable',
      person: null,
      percent: 100,
    });
  });

  it('recognizes "*X" as owed to me', () => {
    expect(parseShareHint('*Fulano')).toEqual({
      kind: 'owed_to_me',
      person: 'Fulano',
      percent: 100,
    });
  });

  it('recognizes "Pagar a X" as owed by me', () => {
    expect(parseShareHint('Pagar a Fulano')).toEqual({
      kind: 'owed_by_me',
      person: 'Fulano',
    });
  });

  it('is case/accent-insensitive and keeps the person casing', () => {
    expect(parseShareHint('  * DIVIDIR COM Maria José ')).toEqual({
      kind: 'split',
      person: 'Maria José',
      percent: 50,
    });
    expect(parseShareHint('pagar à Maria')).toEqual({
      kind: 'owed_by_me',
      person: 'Maria',
    });
    expect(parseShareHint('*REEMBOLSAR')).toEqual({
      kind: 'reimbursable',
      person: null,
      percent: 100,
    });
  });

  it('returns null for other notes', () => {
    expect(parseShareHint('observação qualquer')).toBeNull();
    expect(parseShareHint('')).toBeNull();
    expect(parseShareHint('*')).toBeNull();
    expect(parseShareHint(null)).toBeNull();
    expect(parseShareHint(undefined)).toBeNull();
  });
});

describe('slugify', () => {
  it('lowercases, strips accents and collapses non-alphanumerics into dashes', () => {
    expect(slugify('Remédios')).toBe('remedios');
    expect(slugify('  Curso B  ')).toBe('curso-b');
    expect(slugify('Ação & Reação (2x)')).toBe('acao-reacao-2x');
    expect(slugify('-Loja A-')).toBe('loja-a');
    expect(slugify('***')).toBe('');
  });
});

describe('detectMonthFromTitle', () => {
  it('reads "Mês de <nome> de <ano>" regardless of case and accents', () => {
    expect(detectMonthFromTitle('Finanças Fulano\nMês de março de 2026')).toEqual({
      year: 2026,
      month: 3,
    });
    expect(detectMonthFromTitle('MES DE MARCO DE 2026')).toEqual({ year: 2026, month: 3 });
    expect(detectMonthFromTitle('Mês de Outubro de 2026')).toEqual({ year: 2026, month: 10 });
  });

  it('returns null when there is no month', () => {
    expect(detectMonthFromTitle('Finanças Fulano')).toBeNull();
    expect(detectMonthFromTitle('')).toBeNull();
  });
});

describe('detectMonthFromFilename', () => {
  it('reads the month abbreviation and the year from the sheet export name', () => {
    expect(detectMonthFromFilename(FIXTURE_FILENAME)).toEqual({ year: 2026, month: 10 });
    expect(detectMonthFromFilename('financas 2025 - mar.csv')).toEqual({
      year: 2025,
      month: 3,
    });
  });

  it('requires a standalone abbreviation and a year', () => {
    expect(detectMonthFromFilename('checkout_2026.csv')).toBeNull();
    expect(detectMonthFromFilename('FINANÇAS - OUT.csv')).toBeNull();
    expect(detectMonthFromFilename('')).toBeNull();
  });
});

describe('parseMaxFinGrid – month detection', () => {
  it('detects the month from the two-line title', () => {
    expect(fixture.month).toEqual({ year: 2026, month: 3 });
    expect(fixture.monthSource).toBe('title');
    const date = fixture.rows[0]?.date;
    expect(date?.getFullYear()).toBe(2026);
    expect(date?.getMonth()).toBe(2);
    expect(date?.getDate()).toBe(1);
    expect(date?.getHours()).toBe(0);
  });

  it('falls back to the filename when the title has no month', () => {
    const grid = buildGrid(
      [['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']],
      'Finanças Teste',
    );
    const result = parseMaxFinGrid(grid, { filename: FIXTURE_FILENAME });

    expect(result.month).toEqual({ year: 2026, month: 10 });
    expect(result.monthSource).toBe('filename');
    expect(result.rows[0]?.sourceRef).toBe('maxfin:2026-10:bills:4');
  });

  it('lets monthOverride win over title and filename', () => {
    const result = parseMaxFinGrid(fixtureGrid, {
      filename: FIXTURE_FILENAME,
      monthOverride: { year: 2024, month: 7 },
    });

    expect(result.month).toEqual({ year: 2024, month: 7 });
    expect(result.monthSource).toBe('override');
    expect(result.rows.every((r) => r.sourceRef.startsWith('maxfin:2024-07:'))).toBe(true);
    expect(result.rows[0]?.date.getMonth()).toBe(6);
  });

  it('reports no month with a warning, placeholder date and "unknown" sourceRef', () => {
    const grid = buildGrid(
      [['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']],
      'Finanças Teste',
    );
    const result = parseMaxFinGrid(grid, { filename: 'planilha.csv' });

    expect(result.month).toBeNull();
    expect(result.monthSource).toBe('none');
    expect(result.warnings.some((w) => /m[êe]s/i.test(w))).toBe(true);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.date.getTime()).toBe(new Date(1970, 0, 1).getTime());
    expect(result.rows[0]?.sourceRef).toBe('maxfin:unknown:bills:4');
  });
});

describe('parseMaxFinGrid – month from the tab name', () => {
  const untitled = (): Grid =>
    buildGrid([['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']], 'Finanças Teste');

  it('reports the title when the tab name agrees with it, the year coming from the title', () => {
    const result = parseMaxFinGrid(fixtureGrid, { sheetName: 'MAR' });

    expect(result).toMatchObject({ month: { year: 2026, month: 3 }, monthSource: 'title' });
    expect(result.warnings.filter((w) => w.includes('título da aba'))).toEqual([]);
  });

  it('prefers the tab name over a title copied from another month, and says so', () => {
    const result = parseMaxFinGrid(fixtureGrid, { sheetName: 'NOV' });

    expect(result).toMatchObject({ month: { year: 2026, month: 11 }, monthSource: 'sheet' });
    expect(result.warnings).toContain(
      'O título da aba diz março/2026, mas a aba se chama "NOV": usei novembro/2026 (ano do título).',
    );
    expect(result.rows.every((r) => r.sourceRef.startsWith('maxfin:2026-11:'))).toBe(true);
    expect(result.rows[0]?.date.getMonth()).toBe(10);
  });

  it('takes the year from the tab name before the title', () => {
    const result = parseMaxFinGrid(fixtureGrid, { sheetName: 'Outubro 2025' });

    expect(result).toMatchObject({ month: { year: 2025, month: 10 }, monthSource: 'sheet' });
    expect(result.warnings).toContain(
      'O título da aba diz março/2026, mas a aba se chama "Outubro 2025": usei outubro/2025 (ano do nome da aba).',
    );
  });

  it('without a title month, takes the year from the file name, then from fallbackYear', () => {
    expect(
      parseMaxFinGrid(untitled(), { sheetName: 'OUT', filename: 'FINANÇAS_2026.xlsx - OUT.csv', fallbackYear: 2030 }),
    ).toMatchObject({ month: { year: 2026, month: 10 }, monthSource: 'sheet' });
    expect(parseMaxFinGrid(untitled(), { sheetName: 'OUT', fallbackYear: 2027 })).toMatchObject({
      month: { year: 2027, month: 10 },
      monthSource: 'sheet',
    });
    expect(parseMaxFinGrid(untitled(), { sheetName: 'OUT' })).toMatchObject({ month: null, monthSource: 'none' });
  });

  it('falls back to the title, then to the file name, when the tab name has no month', () => {
    expect(parseMaxFinGrid(fixtureGrid, { sheetName: 'Resumo' })).toMatchObject({
      month: { year: 2026, month: 3 },
      monthSource: 'title',
    });
    expect(parseMaxFinGrid(untitled(), { sheetName: 'Resumo', filename: 'financas 2025 - mar.csv' })).toMatchObject({
      month: { year: 2025, month: 3 },
      monthSource: 'filename',
    });
  });

  it('never takes the month from the file name when the tab name has one', () => {
    const result = parseMaxFinGrid(untitled(), { sheetName: 'OUT', filename: 'Planilha março 2026 - OUT.csv' });

    expect(result).toMatchObject({ month: { year: 2026, month: 10 }, monthSource: 'sheet' });
  });

  it('lets monthOverride win over the tab name', () => {
    expect(parseMaxFinGrid(fixtureGrid, { sheetName: 'NOV', monthOverride: { year: 2024, month: 7 } })).toMatchObject({
      month: { year: 2024, month: 7 },
      monthSource: 'override',
    });
  });
});

describe('parseMaxFinGrid – year of a tab whose title names another month', () => {
  const titled = (title: string): Grid =>
    buildGrid([['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']], `Finanças Teste\n${title}`);
  const ROLLED = 'ano seguinte ao do título: a aba é uma cópia feita depois dele';

  it('keeps the year of the title when the tab is the same month, whatever the file name says', () => {
    const result = parseMaxFinGrid(titled('Mês de dezembro de 2026'), { sheetName: 'DEZ', filename: 'FINANÇAS_2027.xlsx - DEZ.csv' });

    expect(result).toMatchObject({ month: { year: 2026, month: 12 }, monthSource: 'title' });
    expect(result.warnings.filter((warning) => warning.includes('título da aba'))).toEqual([]);
  });

  it('takes the year from the tab name first', () => {
    const result = parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'SET 2025', filename: 'FINANÇAS_2026.xlsx - SET 2025.csv' });

    expect(result.month).toEqual({ year: 2025, month: 9 });
    expect(result.warnings).toContain('O título da aba diz outubro/2026, mas a aba se chama "SET 2025": usei setembro/2025 (ano do nome da aba).');
  });

  it('keeps a backward copy (SET made from OUT) in the year of the file name', () => {
    const result = parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'SET', filename: 'FINANÇAS_2026.xlsx - SET.csv' });

    expect(result).toMatchObject({ month: { year: 2026, month: 9 }, monthSource: 'sheet' });
    expect(result.warnings).toContain('O título da aba diz outubro/2026, mas a aba se chama "SET": usei setembro/2026 (ano do nome do arquivo).');
  });

  it('takes JAN copied from DEZ in a file named for the next year as January of that year', () => {
    const result = parseMaxFinGrid(titled('Mês de dezembro de 2026'), { sheetName: 'JAN', filename: 'X_2027.xlsx - JAN.csv' });

    expect(result.month).toEqual({ year: 2027, month: 1 });
    expect(result.warnings).toContain('O título da aba diz dezembro/2026, mas a aba se chama "JAN": usei janeiro/2027 (ano do nome do arquivo).');
  });

  it('reads the file-name year from the workbook part of a tab download, or from fileYear', () => {
    expect(parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'SET', filename: 'Planilha 2025.xlsx - SET.csv' }).month).toEqual({
      year: 2025,
      month: 9,
    });
    expect(parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'SET', fileYear: 2024, fallbackYear: 2030 }).month).toEqual({
      year: 2024,
      month: 9,
    });
  });

  it('with no year but the title, takes a JAN tab copied from DEZ as January of the next year, and says why', () => {
    const result = parseMaxFinGrid(titled('Mês de dezembro de 2026'), { sheetName: 'JAN', filename: 'Planilha.xlsx - JAN.csv' });

    expect(result).toMatchObject({ month: { year: 2027, month: 1 }, monthSource: 'sheet' });
    expect(result.warnings).toContain(`O título da aba diz dezembro/2026, mas a aba se chama "JAN": usei janeiro/2027 (${ROLLED}).`);
    expect(result.rows[0]?.sourceRef).toBe('maxfin:2027-01:bills:4');
  });

  it('with no year but the title, keeps a later month in the title year and moves an earlier one to the next', () => {
    const later = parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'NOV' });
    const earlier = parseMaxFinGrid(titled('Mês de outubro de 2026'), { sheetName: 'SET' });

    expect(later.month).toEqual({ year: 2026, month: 11 });
    expect(later.warnings).toContain('O título da aba diz outubro/2026, mas a aba se chama "NOV": usei novembro/2026 (ano do título).');
    expect(earlier.month).toEqual({ year: 2027, month: 9 });
    expect(earlier.warnings).toContain(`O título da aba diz outubro/2026, mas a aba se chama "SET": usei setembro/2027 (${ROLLED}).`);
  });

  it('never needs fallbackYear when the title names a month', () => {
    expect(parseMaxFinGrid(titled('Mês de dezembro de 2026'), { sheetName: 'JAN', fallbackYear: 2031 }).month).toEqual({
      year: 2027,
      month: 1,
    });
  });
});

describe('sheetNameFromCsvFilename', () => {
  it('reads the tab of a "<workbook> - <tab>.csv" download name, after the last " - "', () => {
    expect(sheetNameFromCsvFilename('FINANÇAS_2026.xlsx - OUT.csv')).toBe('OUT');
    expect(sheetNameFromCsvFilename('Contas - casa - NOV.CSV')).toBe('NOV');
    expect(sheetNameFromCsvFilename('Finanças 2026 - OUT (1).csv')).toBe('OUT (1)');
  });

  it('splits a long crafted name in linear time', () => {
    const crafted = `${' - '.repeat(30_000)}x`;
    const started = performance.now();

    expect(sheetNameFromCsvFilename(crafted)).toBeNull();
    expect(sheetNameFromCsvFilename(`${crafted}.csv`)).toBe('x');
    expect(performance.now() - started).toBeLessThan(50);
  });

  it('returns null for other names', () => {
    expect(sheetNameFromCsvFilename('planilha.csv')).toBeNull();
    expect(sheetNameFromCsvFilename('OUT.csv')).toBeNull();
    expect(sheetNameFromCsvFilename('Finanças - OUT.xlsx')).toBeNull();
    expect(sheetNameFromCsvFilename('Finanças -  .csv')).toBeNull();
  });

  it('keeps month 10 for a CSV named "Finanças 2026 - OUT.csv", with or without a title', () => {
    const filename = 'Finanças 2026 - OUT.csv';
    const sheetName = sheetNameFromCsvFilename(filename) ?? undefined;
    const rows = [['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']];

    expect(parseMaxFinGrid(buildGrid(rows, 'Finanças Teste'), { filename, sheetName })).toMatchObject({
      month: { year: 2026, month: 10 },
      monthSource: 'sheet',
    });
    expect(
      parseMaxFinGrid(buildGrid(rows, 'Finanças Teste\nMês de outubro de 2026'), { filename, sheetName }),
    ).toMatchObject({ month: { year: 2026, month: 10 }, monthSource: 'title' });
  });
});

describe('detectYearFromName', () => {
  it('reads the first standalone 4-digit number', () => {
    expect(detectYearFromName('FINANÇAS_2026.xlsx')).toBe(2026);
    expect(detectYearFromName('2025-2026')).toBe(2025);
    expect(detectYearFromName('planilha 20261.xlsx')).toBeNull();
    expect(detectYearFromName('planilha.xlsx')).toBeNull();
  });
});

describe('findMaxFinHeaderIndex', () => {
  it('finds the "Descrição" header row, or -1', () => {
    expect(findMaxFinHeaderIndex(fixtureGrid)).toBe(4);
    expect(findMaxFinHeaderIndex([['Resumo'], ['', 'Total']])).toBe(-1);
  });
});

describe('parseMaxFinGrid – header', () => {
  it('starts reading on the row after the "Descrição" header', () => {
    expect(fixtureGrid[4]?.[1]).toBe('Descrição');
    expect(fixture.skipped[0]).toEqual({
      sourceLine: 6,
      description: 'Mês anterior',
      reason: 'Mês anterior',
    });
    expect(fixture.rows[0]?.sourceLine).toBe(7);
  });

  it('matches the header column regardless of case, accents and spaces', () => {
    const grid: Grid = [
      ['Finanças Teste\nMês de março de 2026'],
      ['', '  DESCRICAO ', 'Categoria'],
      ['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00'],
    ];
    const result = parseMaxFinGrid(grid);

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]?.sourceLine).toBe(3);
  });

  it('returns no rows and a warning when the header is missing', () => {
    const grid: Grid = [
      ['Finanças Teste\nMês de março de 2026'],
      [''],
      ['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00'],
    ];
    const result = parseMaxFinGrid(grid);

    expect(result.rows).toEqual([]);
    expect(result.skipped).toEqual([]);
    expect(result.warnings.some((w) => w.includes('Descrição'))).toBe(true);
    expect(result.month).toEqual({ year: 2026, month: 3 });
    expect(result.sections.map((s) => s.count)).toEqual([0, 0, 0, 0]);
  });
});

describe('parseMaxFinGrid – fixture sections', () => {
  it('summarizes the four sections in a fixed order', () => {
    expect(fixture.sections.map((s) => s.key)).toEqual(['income', 'bills', 'credit', 'debit']);
    expect(fixture.sections.map((s) => s.label)).toEqual([
      'Entradas',
      'Contas fixas',
      'Cartão',
      'Débito/pix',
    ]);
  });

  it('counts and sums income rows (no sheet total)', () => {
    const income = sectionOf(fixture, 'income');
    expect(income.count).toBe(2);
    expect(income.sum).toBeCloseTo(6000, 2);
    expect(income.sheetTotalPlanned).toBeNull();
    expect(income.sheetTotalRealized).toBeNull();
  });

  it('counts and sums bills and captures the sheet totals', () => {
    const bills = sectionOf(fixture, 'bills');
    expect(bills.count).toBe(3);
    expect(bills.sum).toBeCloseTo(1549.9, 2);
    expect(bills.sheetTotalPlanned).toBeCloseTo(1570, 2);
    expect(bills.sheetTotalRealized).toBeCloseTo(1399.9, 2);
  });

  it('counts and sums credit card rows, net of the refund; the sheet Total has no Realizado', () => {
    const credit = sectionOf(fixture, 'credit');
    expect(credit.count).toBe(11);
    // 2072.50 of purchases minus the 156.00 refund: the same net as the sheet Total.
    expect(credit.sum).toBeCloseTo(1916.5, 2);
    expect(credit.sheetTotalPlanned).toBeCloseTo(1916.5, 2);
    expect(credit.sheetTotalRealized).toBeNull();
  });

  it('counts and sums debit/pix rows', () => {
    const debit = sectionOf(fixture, 'debit');
    expect(debit.count).toBe(2);
    expect(debit.sum).toBeCloseTo(245, 2);
    expect(debit.sheetTotalPlanned).toBeCloseTo(245, 2);
    expect(debit.sheetTotalRealized).toBeCloseTo(245, 2);
  });

  it('accepts 18 rows and skips 4', () => {
    expect(fixture.rows).toHaveLength(18);
    expect(fixture.skipped).toHaveLength(4);
  });
});

describe('parseMaxFinGrid – value rules', () => {
  it('income: Recebido wins over Previsto and marks the row as paid', () => {
    expect(rowOf(fixture, 'Salário Empresa X')).toMatchObject({
      section: 'income',
      type: 'INCOME',
      amount: 5200,
      planned: 5000,
      realized: 5200,
      paid: true,
      categoryKey: 'Salário',
      rawNote: null,
      notes: 'previsto R$ 5.000,00',
      flag: null,
      installment: null,
      shareHint: null,
    });
  });

  it('income: only Previsto keeps the row unpaid and uses the description as category', () => {
    expect(rowOf(fixture, 'Freela Cliente Y')).toMatchObject({
      section: 'income',
      amount: 800,
      planned: 800,
      realized: null,
      paid: false,
      categoryKey: 'Freela Cliente Y',
      notes: null,
    });
  });

  it('bills: Realizado lower than Previsto keeps the realized amount and notes the planned one', () => {
    expect(rowOf(fixture, 'Internet')).toMatchObject({
      section: 'bills',
      type: 'EXPENSE',
      amount: 99.9,
      planned: 120,
      realized: 99.9,
      paid: true,
      notes: 'previsto R$ 120,00',
    });
  });

  it('bills: equal Previsto and Realizado produces no generated note', () => {
    expect(rowOf(fixture, 'Aluguel')).toMatchObject({
      amount: 1300,
      paid: true,
      notes: null,
    });
  });

  it('bills: only Previsto keeps the row unpaid', () => {
    expect(rowOf(fixture, 'Academia')).toMatchObject({
      amount: 150,
      planned: 150,
      realized: null,
      paid: false,
    });
  });

  it('credit: rows are always paid, even without Realizado', () => {
    const creditRows = fixture.rows.filter((r) => r.section === 'credit');
    expect(creditRows.every((r) => r.paid)).toBe(true);

    const grid = buildGrid([
      ['', 'Total', '', '', '', '', 'R$ 0,00', ''],
      ['', 'Compra sem realizado', 'Lazer', '', '', '', 'R$ 50,00', ''],
    ]);
    const result = parseMaxFinGrid(grid);
    expect(rowOf(result, 'Compra sem realizado')).toMatchObject({
      section: 'credit',
      amount: 50,
      realized: null,
      paid: true,
    });
  });

  it('expense without category gets an empty categoryKey', () => {
    expect(rowOf(fixture, 'Farmácia').categoryKey).toBe('');
  });

  it('keeps the flag from column A', () => {
    expect(rowOf(fixture, 'Mercado').flag).toBe('ok');
    expect(rowOf(fixture, 'Loja A 3/10').flag).toBe('-');
    expect(rowOf(fixture, 'Jantar').flag).toBeNull();
  });

  it('treats a row with both income and expense values as income and warns', () => {
    const grid = buildGrid([
      ['', 'Ambíguo', 'Outros', 'R$ 10,00', '', '', 'R$ 20,00', ''],
    ]);
    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Ambíguo')).toMatchObject({
      section: 'income',
      type: 'INCOME',
      amount: 10,
    });
    expect(result.warnings.some((w) => w.includes('entrada e saída'))).toBe(true);
  });
});

describe('parseMaxFinGrid – installments', () => {
  it('parses "N/M" on a credit row and keeps the raw description', () => {
    expect(rowOf(fixture, 'Loja A 3/10')).toMatchObject({
      description: 'Loja A 3/10',
      installment: {
        number: 3,
        total: 10,
        prepaid: 0,
        baseDescription: 'Loja A',
        installmentId: 'maxfin:loja-a:10',
        futureCount: 7,
      },
      notes: null,
    });
  });

  it('closes the plan when "+K" reaches the total and notes the prepaid installments', () => {
    expect(rowOf(fixture, 'Curso B 5/12 +7')).toMatchObject({
      flag: 'ok',
      installment: {
        number: 5,
        total: 12,
        prepaid: 7,
        installmentId: 'maxfin:curso-b:12',
        futureCount: 0,
      },
      notes: 'antecipou 7 parcelas (6..12)',
    });
  });

  it('handles a partial "+K" written with spaces', () => {
    expect(rowOf(fixture, 'Remédios 1/4 + 1')).toMatchObject({
      installment: {
        number: 1,
        total: 4,
        prepaid: 1,
        baseDescription: 'Remédios',
        futureCount: 2,
      },
      notes: 'antecipou 1 parcela (2)',
    });
  });

  it('ignores an invalid installment, keeps the row and warns', () => {
    const grid = buildGrid([
      ['', 'Loja Z 0/5', 'Compras', '', '', '', 'R$ 10,00', 'R$ 10,00'],
    ]);
    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Loja Z 0/5').installment).toBeNull();
    expect(result.warnings.some((w) => w.includes('Loja Z 0/5'))).toBe(true);
  });

  it('gives rows of the same plan the same installmentId', () => {
    const grid = buildGrid([
      ['', 'Curso B 5/12 +7', 'Educação', '', '', '', 'R$ 10,00', 'R$ 10,00'],
      ['', 'Curso B 6/12', 'Educação', '', '', '', 'R$ 10,00', 'R$ 10,00'],
    ]);
    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Curso B 6/12').installment?.installmentId).toBe(
      rowOf(result, 'Curso B 5/12 +7').installment?.installmentId,
    );
  });
});

describe('parseMaxFinGrid – notes and share hints', () => {
  it('reads "*Dividir com X" as a 50% split and keeps the raw note', () => {
    expect(rowOf(fixture, 'Jantar')).toMatchObject({
      rawNote: '*Dividir com Fulano',
      notes: '*Dividir com Fulano',
      shareHint: { kind: 'split', person: 'Fulano', percent: 50 },
    });
  });

  it('reads "*X" as owed to me', () => {
    expect(rowOf(fixture, 'Presente').shareHint).toEqual({
      kind: 'owed_to_me',
      person: 'Fulano',
      percent: 100,
    });
  });

  it('reads "*Reembolsar" as reimbursable', () => {
    expect(rowOf(fixture, 'Passagem').shareHint).toEqual({
      kind: 'reimbursable',
      person: null,
      percent: 100,
    });
  });

  it('reads "Pagar a X" as owed by me', () => {
    expect(rowOf(fixture, 'Conta de luz')).toMatchObject({
      section: 'debit',
      rawNote: 'Pagar a Fulano',
      shareHint: { kind: 'owed_by_me', person: 'Fulano' },
    });
  });

  it('joins the raw note and the generated notes with " · "', () => {
    const grid = buildGrid([
      [
        'ok',
        'Curso D 2/6 +2',
        'Educação',
        '',
        '',
        '',
        'R$ 300,00',
        'R$ 280,00',
        '',
        '*Dividir com Fulano',
      ],
    ]);
    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Curso D 2/6 +2').notes).toBe(
      '*Dividir com Fulano · previsto R$ 300,00 · antecipou 2 parcelas (3..4)',
    );
  });

  it('leaves notes null when there is nothing to say', () => {
    expect(rowOf(fixture, 'Mercado')).toMatchObject({ rawNote: null, notes: null });
  });
});

describe('parseMaxFinGrid – skipped rows', () => {
  it('records the carry-over, zero and value-less rows with their reasons', () => {
    expect(fixture.skipped).toEqual([
      { sourceLine: 6, description: 'Mês anterior', reason: 'Mês anterior' },
      { sourceLine: 20, description: 'Assinatura C', reason: 'valor zero' },
      { sourceLine: 31, description: 'Porquinho - Lazer', reason: 'sem valor' },
      { sourceLine: 32, description: 'Reserva', reason: 'sem valor' },
    ]);
  });

  it('silently skips rows without a description', () => {
    const grid = buildGrid([
      ['', '', '', 'R$ 10,00', 'R$ 10,00'],
      [''],
      ['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00'],
    ]);
    const result = parseMaxFinGrid(grid);

    expect(result.skipped).toEqual([]);
    expect(result.rows.map((r) => r.description)).toEqual(['Mercado']);
  });
});

describe('parseMaxFinGrid – negative values', () => {
  const money = (value: string) => `R$ ${value}`;
  const total = ['', 'Total', '', '', '', '', '', '', '', ''];

  it('imports the refund of the fixture card block as a credit instead of skipping it', () => {
    expect(rowOf(fixture, 'Estorno Loja A')).toMatchObject({
      sourceRef: 'maxfin:2026-03:credit:21',
      section: 'credit',
      type: 'INCOME',
      amount: 156,
      planned: -156,
      realized: -156,
      paid: true,
      categoryKey: 'Compras',
      notes: 'valor negativo na planilha: lançado como crédito',
    });
    expect(fixture.skipped.map((row) => row.description)).not.toContain('Estorno Loja A');
  });

  it('flips the type in every block and keeps the block, so the row stays on the same account', () => {
    const grid = buildGrid([
      ['', 'Ajuste salário', 'Salário', '-R$ 200,00', '-R$ 200,00', '', '', '', '', ''],
      ['', 'Aluguel', 'Moradia', '', '', '', money('1.000,00'), money('1.000,00'), '', ''],
      ['', 'Devolução condomínio', 'Moradia', '', '', '', '-R$ 80,00', '', '', ''],
      total,
      ['', 'Estorno Loja Z', 'Compras', '', '', '', '-R$ 90,00', '-R$ 90,00', '', ''],
      total,
      ['', 'Pix devolvido', '', '', '', '', '-R$ 15,00', '-R$ 15,00', '', ''],
      total,
    ]);

    const result = parseMaxFinGrid(grid);

    expect(result.rows.map((r) => [r.description, r.section, r.type, r.amount, r.paid])).toEqual([
      ['Ajuste salário', 'income', 'EXPENSE', 200, true],
      ['Aluguel', 'bills', 'EXPENSE', 1000, true],
      ['Devolução condomínio', 'bills', 'INCOME', 80, false],
      ['Estorno Loja Z', 'credit', 'INCOME', 90, true],
      ['Pix devolvido', 'debit', 'INCOME', 15, true],
    ]);
    expect(rowOf(result, 'Ajuste salário')).toMatchObject({
      categoryKey: 'Salário',
      notes: 'valor negativo na planilha: lançado como débito',
    });
    expect(rowOf(result, 'Devolução condomínio').notes).toBe('valor negativo na planilha: lançado como crédito');
    expect(result.skipped).toEqual([]);
  });

  it('takes the sign from the realized value when there is one, otherwise from the planned one', () => {
    const grid = buildGrid([
      ['', 'Realizado negativo', 'Casa', '', '', '', money('100,00'), '-R$ 50,00', '', ''],
      ['', 'Realizado positivo', 'Casa', '', '', '', '-R$ 40,00', money('40,00'), '', ''],
      ['', 'Realizado zero', 'Casa', '', '', '', '-R$ 30,00', money('0,00'), '', ''],
      ['', 'Tudo zero', 'Casa', '', '', '', money('0,00'), money('0,00'), '', ''],
      total,
      total,
      total,
    ]);

    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Realizado negativo')).toMatchObject({
      type: 'INCOME',
      amount: 50,
      paid: true,
      notes: 'previsto R$ 100,00 · valor negativo na planilha: lançado como crédito',
    });
    expect(rowOf(result, 'Realizado positivo')).toMatchObject({
      type: 'EXPENSE',
      amount: 40,
      paid: true,
      notes: 'previsto -R$ 40,00',
    });
    expect(rowOf(result, 'Realizado zero')).toMatchObject({
      type: 'INCOME',
      amount: 30,
      paid: false,
      notes: 'valor negativo na planilha: lançado como crédito',
    });
    expect(result.skipped).toEqual([{ sourceLine: 7, description: 'Tudo zero', reason: 'valor zero' }]);
  });

  it('nets the credits out of the block sum, so it compares with a sheet Total that does the same', () => {
    const grid = buildGrid([
      ['', 'Aluguel', 'Moradia', '', '', '', money('1.000,00'), money('1.000,00'), '', ''],
      ['', 'Devolução', 'Moradia', '', '', '', '-R$ 80,00', '-R$ 80,00', '', ''],
      ['', 'Total', '', '', '', '', money('920,00'), money('920,00'), '', ''],
      ['', 'Mercado', 'Alimentação', '', '', '', money('200,00'), money('200,00'), '', ''],
      ['', 'Estorno', 'Alimentação', '', '', '', '-R$ 50,00', '-R$ 50,00', '', ''],
      ['', 'Total', '', '', '', '', money('150,00'), '', '', ''],
      total,
    ]);

    const result = parseMaxFinGrid(grid);

    expect(result.sections.map((s) => [s.key, s.count, s.sum])).toEqual([
      ['income', 0, 0],
      ['bills', 2, 920],
      ['credit', 2, 150],
      ['debit', 0, 0],
    ]);
    expect(result.warnings.filter((w) => w.includes('difere do Total'))).toEqual([]);
  });

  it('keeps the installment of a negative card row', () => {
    const grid = buildGrid([
      total,
      ['', 'Estorno Loja Z 1/3', 'Compras', '', '', '', '-R$ 30,00', '-R$ 30,00', '', ''],
      total,
      total,
    ]);

    const row = rowOf(parseMaxFinGrid(grid), 'Estorno Loja Z 1/3');

    expect(row).toMatchObject({ section: 'credit', type: 'INCOME', amount: 30 });
    expect(row.installment).toMatchObject({
      number: 1,
      total: 3,
      prepaid: 0,
      futureCount: 2,
      installmentId: 'maxfin:estorno-loja-z:3',
    });
  });
});

describe('parseMaxFinGrid – footer', () => {
  it('ignores everything after the third Total row', () => {
    const descriptions = [...fixture.rows, ...fixture.skipped].map((r) => r.description);

    expect(descriptions).not.toContain('Nubank');
    expect(descriptions).not.toContain('Mercado Pago');
    expect(descriptions).not.toContain('Saldo');
    expect(descriptions).not.toContain('Economia Prevista');
    expect(Math.max(...fixture.rows.map((r) => r.sourceLine))).toBeLessThan(34);
  });

  it('warns when fewer than three Total rows are found', () => {
    const grid = buildGrid([['', 'Mercado', 'Casa', '', '', '', 'R$ 10,00', 'R$ 10,00']]);
    const result = parseMaxFinGrid(grid);

    expect(result.warnings.some((w) => w.includes('Total'))).toBe(true);
  });
});

describe('parseMaxFinGrid – sheet totals', () => {
  it('warns when the accepted sum differs from the sheet Total', () => {
    expect(fixture.warnings.some((w) => w.startsWith('Contas fixas'))).toBe(true);
  });

  it('does not warn when the accepted (net) sum matches the sheet Total', () => {
    expect(fixture.warnings.some((w) => w.startsWith('Débito/pix'))).toBe(false);
    // The card block matches only because the refund counts against it.
    expect(fixture.warnings.some((w) => w.startsWith('Cartão'))).toBe(false);
  });
});

describe('parseMaxFinGrid – sourceRef', () => {
  it('formats sourceRef as maxfin:<AAAA-MM>:<section>:<line>', () => {
    expect(rowOf(fixture, 'Salário Empresa X').sourceRef).toBe('maxfin:2026-03:income:7');
    expect(rowOf(fixture, 'Aluguel').sourceRef).toBe('maxfin:2026-03:bills:11');
    expect(rowOf(fixture, 'Mercado').sourceRef).toBe('maxfin:2026-03:credit:16');
    expect(rowOf(fixture, 'Conta de luz').sourceRef).toBe('maxfin:2026-03:debit:30');
    expect(
      fixture.rows.every((r) =>
        /^maxfin:2026-03:(income|bills|credit|debit):\d+$/.test(r.sourceRef),
      ),
    ).toBe(true);
  });

  it('keeps sourceRef unique even for repeated descriptions', () => {
    const refs = fixture.rows.map((r) => r.sourceRef);
    expect(new Set(refs).size).toBe(refs.length);

    const uberRefs = fixture.rows.filter((r) => r.description === 'Uber').map((r) => r.sourceRef);
    expect(uberRefs).toEqual(['maxfin:2026-03:credit:25', 'maxfin:2026-03:credit:26']);
  });

  it('points sourceLine at the matching grid row', () => {
    for (const row of fixture.rows) {
      expect(fixtureGrid[row.sourceLine - 1]?.[1]?.trim()).toBe(row.description);
    }
    for (const row of fixture.skipped) {
      expect(fixtureGrid[row.sourceLine - 1]?.[1]?.trim()).toBe(row.description);
    }
  });
});

describe('parseMaxFinGrid – block delimiters', () => {
  const total = ['', 'Total', '', '', '', '', '"R$ 0,00"', '', '', ''];
  const money = (value: string) => `R$ ${value}`;

  it('does not mistake an expense whose description starts with "Total" for a Total row', () => {
    const grid = buildGrid([
      ['', 'Salário', 'Salário', money('1.000,00'), money('1.000,00'), '', '', '', '', ''],
      ['', '', '', '', '', '', '', '', '', ''],
      ['', 'Aluguel', 'Moradia', '', '', '', money('500,00'), money('500,00'), '', ''],
      ['', 'TotalPass', 'Saúde', '', '', '', money('99,00'), money('99,00'), '', ''],
      ['', 'Total Pass', 'Saúde', '', '', '', money('49,00'), money('49,00'), '', ''],
      total,
      ['', 'Mercado', 'Alimentação', '', '', '', money('100,00'), money('100,00'), '', ''],
      total,
      ['', 'Pix Padaria', '', '', '', '', money('10,00'), '', '', ''],
      total,
    ]);

    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'TotalPass').section).toBe('bills');
    expect(rowOf(result, 'Total Pass').section).toBe('bills');
    expect(rowOf(result, 'Mercado').section).toBe('credit');
    expect(rowOf(result, 'Pix Padaria').section).toBe('debit');
    expect(result.rows).toHaveLength(6);
    expect(result.warnings.some((w) => w.includes('linhas "Total"'))).toBe(false);
  });

  it('still recognises real Total rows: whole word, empty category, trailing spaces or a colon', () => {
    const grid = buildGrid([
      ['', 'Aluguel', 'Moradia', '', '', '', money('500,00'), money('500,00'), '', ''],
      ['', 'Total ', '', '', '', '', money('500,00'), money('500,00'), '', ''],
      ['', 'Mercado', 'Alimentação', '', '', '', money('100,00'), money('100,00'), '', ''],
      ['', 'TOTAL:', '', '', '', '', money('100,00'), '', '', ''],
      ['', 'Pix', '', '', '', '', money('10,00'), '', '', ''],
      ['', 'Total', '', '', '', '', money('10,00'), '', '', ''],
      ['', 'Saldos', '', '', '', '', money('999,00'), '', '', ''],
    ]);

    const result = parseMaxFinGrid(grid);

    expect(result.rows.map((r) => [r.description, r.section])).toEqual([
      ['Aluguel', 'bills'],
      ['Mercado', 'credit'],
      ['Pix', 'debit'],
    ]);
    expect(sectionOf(result, 'bills').sheetTotalPlanned).toBe(500);
  });

  it('keeps an uncategorised "Total Pass" as an expense and still closes a block on a Total row with a category cell', () => {
    const grid = buildGrid([
      ['', 'Aluguel', 'Moradia', '', '', '', money('500,00'), money('500,00'), '', ''],
      ['', 'Total Pass', '', '', '', '', money('49,00'), money('49,00'), '', ''],
      ['', 'Total', 'Soma', '', '', '', money('549,00'), '', '', ''],
      ['', 'Mercado', 'Alimentação', '', '', '', money('100,00'), money('100,00'), '', ''],
      total,
      ['', 'Pix', '', '', '', '', money('10,00'), '', '', ''],
      total,
    ]);

    const result = parseMaxFinGrid(grid);

    expect(result.rows.map((r) => [r.description, r.section])).toEqual([
      ['Aluguel', 'bills'],
      ['Total Pass', 'bills'],
      ['Mercado', 'credit'],
      ['Pix', 'debit'],
    ]);
  });

  it('does not treat a placeholder like "R$ -" as an income amount', () => {
    const grid = buildGrid([
      ['', 'Aluguel', 'Moradia', 'R$ -', '', '', money('500,00'), money('500,00'), '', ''],
      ['', 'Sem valor algum', 'Casa', 'R$ -', '', '', 'R$ -', '', '', ''],
    ]);

    const result = parseMaxFinGrid(grid);

    expect(rowOf(result, 'Aluguel').type).toBe('EXPENSE');
    expect(rowOf(result, 'Aluguel').amount).toBe(500);
    expect(result.skipped.map((r) => [r.description, r.reason])).toEqual([['Sem valor algum', 'sem valor']]);
  });
});

describe('parseMaxFinGrid – real tokenizer end to end', () => {
  it('produces the same sourceRefs from the real tokenizer as from the test splitter', () => {
    const { grid } = bufferToGrid(Buffer.from(fixtureText, 'utf8'));

    const viaTokenizer = parseMaxFinGrid(grid, { filename: FIXTURE_FILENAME });

    expect(viaTokenizer.rows.map((r) => r.sourceRef)).toEqual(fixture.rows.map((r) => r.sourceRef));
    expect(viaTokenizer.month).toEqual({ year: 2026, month: 3 });
    expect(viaTokenizer.rows).toHaveLength(18);
  });
});

describe('parseMaxFinGrid – text limits', () => {
  const money = (value: string) => `R$ ${value}`;

  it('cuts description, notes and category key to what the confirm endpoint accepts', () => {
    const grid = buildGrid([
      ['', 'D'.repeat(300), 'C'.repeat(250), '', '', '', money('10,00'), money('10,00'), '', 'N'.repeat(1200)],
    ]);

    const [row] = parseMaxFinGrid(grid).rows;

    expect(row?.description).toHaveLength(255);
    expect(row?.categoryKey).toHaveLength(200);
    expect(row?.notes).toHaveLength(1000);
  });

  it('leaves values within the limits untouched', () => {
    const grid = buildGrid([['', 'Mercado', 'Alimentação', '', '', '', money('10,00'), money('10,00'), '', 'nota curta']]);

    const [row] = parseMaxFinGrid(grid).rows;

    expect([row?.description, row?.categoryKey, row?.notes]).toEqual(['Mercado', 'Alimentação', 'nota curta']);
  });
});

describe('parseMaxFinGrid – long cells', () => {
  const money = (value: string) => `R$ ${value}`;
  const long = 'x'.repeat(30_000);

  it('never takes a long cell for the header, a Total row or the carry-over', () => {
    const grid: Grid = [
      ['Finanças Teste\nMês de março de 2026'],
      ['', `Descrição ${long}`],
      ['', 'Descrição'],
      ['', 'Mercado', 'Casa', '', '', '', money('10,00'), money('10,00')],
      ['', `Total ${long}`, '', '', '', '', money('20,00')],
      ['', `Mês anterior ${long}`, '', '', '', '', money('30,00')],
    ];

    const result = parseMaxFinGrid(grid);

    expect(findMaxFinHeaderIndex(grid)).toBe(2);
    expect(result.rows.map((row) => [row.sourceLine, row.section, row.amount])).toEqual([
      [4, 'bills', 10],
      [5, 'bills', 20],
      [6, 'bills', 30],
    ]);
    expect(result.rows[1]?.description).toHaveLength(255);
  });

  it('still reads a keyword surrounded by spaces', () => {
    const grid: Grid = [['Mês de março de 2026'], ['', `${' '.repeat(100)}Descrição${' '.repeat(100)}`]];

    expect(findMaxFinHeaderIndex(grid)).toBe(1);
  });

  it('does not look for the month in a title cell longer than 1,000 characters', () => {
    const grid: Grid = [[`${'x'.repeat(1_000)} Mês de março de 2026`], ['', 'Descrição'], ['', 'Mercado', 'Casa', '', '', '', money('10,00')]];

    expect(parseMaxFinGrid(grid).month).toBeNull();
    expect(parseMaxFinGrid([[`${'x'.repeat(900)} Mês de março de 2026`], ...grid.slice(1)]).month).toEqual({ year: 2026, month: 3 });
  });

  it('parses 2,000 rows of 30,000-character accented descriptions quickly', () => {
    const accented = 'Çã'.repeat(15_000);
    const grid: Grid = [
      ['Mês de março de 2026'],
      ['', 'Descrição'],
      ...Array.from({ length: 2_000 }, () => ['', accented, 'Casa', '', '', '', money('1,00'), money('1,00')]),
    ];
    const started = performance.now();

    const result = parseMaxFinGrid(grid);

    expect(result.rows).toHaveLength(2_000);
    // A few milliseconds when long cells are left alone; normalizing each of them took over a second.
    expect(performance.now() - started).toBeLessThan(500);
  });
});

describe('parseInstallment – long descriptions', () => {
  it('keeps baseDescription within 255 and the plan id within the 120 characters confirm accepts', () => {
    const long = parseInstallment(`${'a'.repeat(295)} 3/10`);
    const medium = parseInstallment(`${'b'.repeat(130)} 3/10`);

    for (const installment of [long, medium]) {
      expect(installment).not.toBeNull();
      expect(installment!.baseDescription.length).toBeLessThanOrEqual(255);
      expect(installment!.installmentId.length).toBeLessThanOrEqual(120);
      expect(installment!.installmentId).toMatch(/^maxfin:[a-z0-9-]*:10$/);
    }
  });

  it('gives the same plan id for the same long description in different months', () => {
    const text = 'c'.repeat(200);

    expect(parseInstallment(`${text} 3/10`)?.installmentId).toBe(parseInstallment(`${text} 4/10`)?.installmentId);
  });
});

describe('clampText', () => {
  it('does not split a surrogate pair at the cut', () => {
    const text = `${'a'.repeat(254)}\u{1F600}`; // 254 units + a 2-unit emoji = 256
    const cut = clampText(text, 255);

    expect(cut).toBe('a'.repeat(254));
    expect(cut.length).toBeLessThanOrEqual(255);
  });

  it('returns short text as is', () => {
    expect(clampText('abc', 5)).toBe('abc');
  });
});
