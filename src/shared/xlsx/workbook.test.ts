import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { inflateRawSync } from 'node:zlib';

import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';

import { bufferToGrid } from '../csv/grid.js';
import { parseMaxFinGrid, parseMoneyBR } from '../../modules/transactions/parsers/maxfin.parser.js';
import { buildXlsx, buildZip, worksheetXml, type FixtureSheet, type ZipFileSpec } from './__fixtures__/build-xlsx.js';
import { MAX_CELL_TEXT, readWorkbookSheets, type WorkbookSheet } from './workbook.js';

/** AppError resets its prototype, so a BadRequestError is recognised by its status, code and message. */
function badRequest(message: string | RegExp) {
  return expect.objectContaining({
    statusCode: 400,
    code: 'BAD_REQUEST',
    message: typeof message === 'string' ? expect.stringContaining(message) : expect.stringMatching(message),
  });
}

async function writeWithExcelJs(fill: (workbook: ExcelJS.Workbook) => void): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  fill(workbook);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

/** A formula cell as exceljs writes it; without `result` the cell has no cached value. */
function formula(text: string, result?: number | string): ExcelJS.CellFormulaValue {
  return (result === undefined ? { formula: text } : { formula: text, result }) as ExcelJS.CellFormulaValue;
}

async function onlySheet(buffer: Buffer): Promise<WorkbookSheet> {
  const sheets = await readWorkbookSheets(buffer);
  expect(sheets).toHaveLength(1);
  return sheets[0]!;
}

/** The grid of a single sheet whose sheetData is given as raw XML. */
async function gridOf(sheetData: string, extra: Partial<FixtureSheet> = {}): Promise<string[][]> {
  return (await onlySheet(buildXlsx({ sheets: [{ name: 'Teste', xml: worksheetXml(sheetData), ...extra }] }))).grid;
}

// ---------------------------------------------------------------------------
// Workbooks written by a spreadsheet library
// ---------------------------------------------------------------------------

describe('readWorkbookSheets on workbooks written by exceljs', () => {
  it('reads every tab in tab order, with its hidden flag', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      workbook.addWorksheet('JAN', { state: 'hidden' }).getCell('B2').value = 'janeiro';
      workbook.addWorksheet('FEV').getCell('B2').value = 'fevereiro';
      workbook.addWorksheet('Resumo', { state: 'veryHidden' }).getCell('A1').value = 'resumo';
    });

    const sheets = await readWorkbookSheets(buffer);

    expect(sheets.map(({ name, hidden, truncated }) => ({ name, hidden, truncated }))).toEqual([
      { name: 'JAN', hidden: true, truncated: false },
      { name: 'FEV', hidden: false, truncated: false },
      { name: 'Resumo', hidden: true, truncated: false },
    ]);
    expect(sheets[0]?.grid).toEqual([[], ['', 'janeiro']]);
  });

  it('writes numbers of the money columns D..I as pt-BR money with two decimals, half a cent away from zero', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('Valores');
      // A contiguous array starts at column A: D..I hold the numbers.
      sheet.getRow(1).values = ['Inteiro', 'x', 'y', 1300, -156, 12.9, 0, 1.005, 636.905];
      sheet.getRow(2).values = ['Arredonda', 'x', 'y', 2.675, -1.005, -0.004, 1234567.891, 0.125, 1e-7];
      for (const cell of ['D1', 'G1']) sheet.getCell(cell).numFmt = '[$R$ -416]#,##0.00';
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]?.slice(3)).toEqual(['1300,00', '-156,00', '12,90', '0,00', '1,01', '636,91']);
    expect(grid[1]?.slice(3)).toEqual(['2,68', '-1,01', '0,00', '1234567,89', '0,13', '0,00']);
  });

  it('writes numbers outside the money columns as plain text with a comma decimal mark', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      // A contiguous array starts at column A.
      workbook.addWorksheet('Valores').getRow(1).values = [2026, 3.5, -0.25, 1, 1, 1, 1, 1, 1, 7.75, 40];
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]?.slice(0, 3)).toEqual(['2026', '3,5', '-0,25']);
    expect(grid[0]?.slice(9)).toEqual(['7,75', '40']);
  });

  it('writes date cells as dd/mm/yyyy outside the money columns and as money inside them', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('Datas');
      sheet.getCell('A1').value = new Date(Date.UTC(2026, 2, 15));
      sheet.getCell('A1').numFmt = 'dd/mm/yyyy';
      sheet.getCell('C1').value = new Date(Date.UTC(2026, 9, 1, 23, 30));
      sheet.getCell('C1').numFmt = 'd-mmm-yy h:mm';
      sheet.getCell('G1').value = new Date(Date.UTC(2026, 0, 1));
      sheet.getCell('G1').numFmt = 'dd/mm/yyyy';
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]?.[0]).toBe('15/03/2026');
    expect(grid[0]?.[2]).toBe('01/10/2026');
    expect(grid[0]?.[6]).toBe('46023,00');
  });

  it('reads formulas through their cached result, zero included, and leaves a formula without one empty', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('Formulas');
      sheet.getCell('D1').value = formula('E1-F1', 0);
      sheet.getCell('E1').value = formula('E2+1', 1300);
      sheet.getCell('H1').value = { sharedFormula: 'E1', result: 0 } as ExcelJS.CellSharedFormulaValue;
      sheet.getCell('B1').value = formula('C1&"x"', 'Mercado');
      sheet.getCell('C1').value = formula('A1*2', 2.5);
      sheet.getCell('G1').value = formula('G2*2');
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]).toEqual(['', 'Mercado', '2,5', '0,00', '1300,00', '', '', '0,00']);
  });

  it('joins rich text runs and reads a hyperlink as its text', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('Texto');
      sheet.getCell('A1').value = {
        richText: [{ text: 'Finanças Teste\n', font: { bold: true } }, { text: 'Mês de março de 2026' }],
      };
      sheet.getCell('B2').value = { text: 'Loja Z', hyperlink: 'https://example.com/loja' };
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]?.[0]).toBe('Finanças Teste\nMês de março de 2026');
    expect(grid[1]?.[1]).toBe('Loja Z');
  });

  it('reads booleans as TRUE/FALSE and error values as empty cells', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      workbook.addWorksheet('Tipos').getRow(1).values = [true, false, { error: '#N/A' }, 'fim'];
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]).toEqual(['TRUE', 'FALSE', '', 'fim']);
  });

  it('keeps only the top-left value of a merged range, such as the title', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('Titulo');
      sheet.getCell('A1').value = 'Mês de março de 2026';
      sheet.mergeCells('A1:J1');
      sheet.getCell('B2').value = 'Descrição';
    });

    const { grid } = await onlySheet(buffer);

    expect(grid).toEqual([['Mês de março de 2026'], ['', 'Descrição']]);
  });

  it('keeps text exactly as written, surrounding spaces included', async () => {
    const buffer = await writeWithExcelJs((workbook) => {
      workbook.addWorksheet('Texto').getRow(1).values = ['', ' Entrada - Previsto ', 'x', 'R$ 1.000,00'];
    });

    const { grid } = await onlySheet(buffer);

    expect(grid[0]).toEqual(['', ' Entrada - Previsto ', 'x', 'R$ 1.000,00']);
  });
});

// ---------------------------------------------------------------------------
// XML that other writers produce (Google Sheets, Excel)
// ---------------------------------------------------------------------------

describe('readWorkbookSheets on raw sheet XML', () => {
  it('keeps cached results equal to zero, plain and shared formulas alike', async () => {
    const grid = await gridOf(
      '<row r="1"><c r="D1" s="2"><f t="shared" ref="D1:D3" si="1">B1-C1</f><v>0</v></c>' +
        '<c r="H1"><f t="shared" si="1"/><v>0</v></c><c r="J1"><f>H1</f><v>0</v></c></row>',
    );

    expect(grid).toEqual([['', '', '', '0,00', '', '', '', '0,00', '', '0']]);
  });

  it('treats a cell without a cached value as empty, whatever its formula or style', async () => {
    const grid = await gridOf('<row r="1"><c r="B1" s="1"/><c r="D1"><f>1+1</f></c><c r="E1"><v></v></c></row>');

    expect(grid).toEqual([]);
  });

  it('reads inline strings, rich inline strings and formula strings', async () => {
    const grid = await gridOf(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><r><rPr><b/></rPr><t xml:space="preserve">Loja </t></r><r><t>Z 3/10</t></r></is></c>' +
        '<c r="C1" t="str"><f>B1&amp;""</f><v>Compras</v></c><c r="D1" t="inlineStr"><is/></c></row>',
    );

    expect(grid).toEqual([['ok', 'Loja Z 3/10', 'Compras']]);
  });

  it('ignores phonetic runs of a shared string', async () => {
    const sharedStrings =
      '<?xml version="1.0" encoding="UTF-8"?><sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<si><r><t>Aluguel</t></r><r><t xml:space="preserve"> Teste</t></r><rPh sb="0" eb="1"><t>ignorar</t></rPh>' +
      '<phoneticPr fontId="1"/></si><si><t>Simples</t><rPh sb="0" eb="1"><t>x</t></rPh></si><si/></sst>';
    const buffer = buildXlsx({
      sheets: [
        {
          name: 'Teste',
          xml: worksheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c><c r="B1" t="s"><v>1</v></c><c r="C1" t="s"><v>2</v></c><c r="D1" t="s"><v>9</v></c></row>'),
        },
      ],
      files: [{ name: 'xl/sharedStrings.xml', data: sharedStrings }],
    });

    expect((await onlySheet(buffer)).grid).toEqual([['Aluguel Teste', 'Simples']]);
  });

  it('reads booleans, errors and ISO dates by cell type', async () => {
    const grid = await gridOf(
      '<row r="1"><c r="A1" t="b"><v>1</v></c><c r="B1" t="b"><v>0</v></c><c r="C1" t="e"><v>#REF!</v></c>' +
        '<c r="J1" t="d"><v>2026-03-15T00:00:00Z</v></c></row>',
    );

    expect(grid).toEqual([['TRUE', 'FALSE', '', '', '', '', '', '', '', '15/03/2026']]);
  });

  it('decodes XML entities and Excel _xHHHH_ escapes, and turns line breaks into "\\n"', async () => {
    const grid = await gridOf(
      '<row r="1"><c r="A1" t="inlineStr"><is><t>A &amp; B &lt;C&gt; &quot;D&quot; &apos;E&apos; &#233; &#x1F600;</t></is></c>' +
        '<c r="B1" t="inlineStr"><is><t>linha 1_x000D_\nlinha 2_x000D_linha 3</t></is></c>' +
        '<c r="C1" t="inlineStr"><is><t>_x005F_x000D_ literal</t></is></c></row>',
    );

    expect(grid).toEqual([['A & B <C> "D" \'E\' é \u{1F600}', 'linha 1\nlinha 2\nlinha 3', '_x000D_ literal']]);
  });

  it('places a cell without r in the next column and a row without r in the next row', async () => {
    const grid = await gridOf(
      '<row><c t="inlineStr"><is><t>a</t></is></c><c t="inlineStr"><is><t>b</t></is></c></row>' +
        '<row r="3"><c r="C3" t="inlineStr"><is><t>c</t></is></c><c t="inlineStr"><is><t>d</t></is></c></row>' +
        '<row><c><v>1</v></c></row>',
    );

    expect(grid).toEqual([['a', 'b'], [], ['', '', 'c', 'd'], ['1']]);
  });

  it('blanks every cell of a merged range except the top-left one, even when the file stores values there', async () => {
    const merged = await onlySheet(
      buildXlsx({
        sheets: [
          {
            name: 'Teste',
            xml: worksheetXml(
              '<row r="1"><c r="A1" t="inlineStr"><is><t>Título</t></is></c><c r="B1" t="inlineStr"><is><t>sobra</t></is></c></row>' +
                '<row r="2"><c r="B2"><v>1</v></c><c r="C2"><v>2</v></c><c r="D2"><v>3</v></c></row>' +
                '<row r="3"><c r="B3"><v>4</v></c><c r="C3"><v>5</v></c><c r="D3"><v>6</v></c></row>',
              '<mergeCells count="2"><mergeCell ref="A1:J1"/><mergeCell ref="C2:D3"/></mergeCells>',
            ),
          },
        ],
      }),
    );

    expect(merged.grid).toEqual([['Título'], ['', '1', '2'], ['', '4']]);
  });

  it('follows the <sheets> order of the workbook, not the order of the sheet parts', async () => {
    const workbookXml =
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>' +
      '<sheet name="SEGUNDA" sheetId="2" r:id="rId4"/><sheet name="PRIMEIRA" sheetId="1" state="hidden" r:id="rId3"/></sheets></workbook>';
    const buffer = buildXlsx({
      sheets: [
        { name: 'ignored', rows: [['parte 1']] },
        { name: 'ignored', rows: [['parte 2']] },
      ],
      files: [{ name: 'xl/workbook.xml', data: workbookXml }],
    });

    const sheets = await readWorkbookSheets(buffer);

    expect(sheets.map((sheet) => [sheet.name, sheet.hidden, sheet.grid[0]?.[0]])).toEqual([
      ['SEGUNDA', false, 'parte 2'],
      ['PRIMEIRA', true, 'parte 1'],
    ]);
  });

  it('resolves absolute relationship targets', async () => {
    const buffer = buildXlsx({ sheets: [{ name: 'OUT', rows: [['ok', 'Mercado', 'Casa', 10]] }], absoluteTargets: true });

    expect((await onlySheet(buffer)).grid).toEqual([['ok', 'Mercado', 'Casa', '10,00']]);
  });

  it('detects date formats from the style of the cell: built-in, custom, and not money or quoted text', async () => {
    const styles =
      '<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<numFmts count="3"><numFmt numFmtId="164" formatCode="[$-416]mmmm\\ yyyy"/><numFmt numFmtId="165" formatCode="[$R$ -416]#,##0.00"/>' +
      '<numFmt numFmtId="166" formatCode="0 &quot;dias&quot;"/></numFmts>' +
      '<cellXfs count="5"><xf numFmtId="0"/><xf numFmtId="14"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="166"/></cellXfs></styleSheet>';
    const grid = (
      await onlySheet(
        buildXlsx({
          sheets: [
            {
              name: 'Teste',
              xml: worksheetXml(
                '<row r="1"><c r="A1" s="1"><v>46096</v></c><c r="B1" s="2"><v>46023</v></c><c r="C1" s="3"><v>1300</v></c>' +
                  '<c r="J1" s="4"><v>30</v></c><c r="K1" s="0"><v>46096</v></c></row>',
              ),
            },
          ],
          styles,
        }),
      )
    ).grid;

    expect(grid).toEqual([['15/03/2026', '01/01/2026', '1300', '', '', '', '', '', '', '30', '46096']]);
  });

  it('honours the 1904 date system', async () => {
    const workbookXml =
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets>' +
      '<sheet name="Datas" sheetId="1" r:id="rId3"/></sheets></workbook>';
    const buffer = buildXlsx({
      sheets: [{ name: 'Datas', xml: worksheetXml('<row r="1"><c r="A1" s="1"><v>0</v></c></row>') }],
      files: [{ name: 'xl/workbook.xml', data: workbookXml }],
    });

    expect((await onlySheet(buffer)).grid).toEqual([['01/01/1904']]);
  });

  it('accepts namespace prefixes on the elements', async () => {
    const sheet =
      '<?xml version="1.0" encoding="UTF-8"?><x:worksheet xmlns:x="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
      '<x:sheetData><x:row r="1"><x:c r="A1" t="inlineStr"><x:is><x:t>ok</x:t></x:is></x:c><x:c r="D1"><x:v>5</x:v></x:c></x:row>' +
      '</x:sheetData><x:mergeCells><x:mergeCell ref="A1:C1"/></x:mergeCells></x:worksheet>';

    expect((await onlySheet(buildXlsx({ sheets: [{ name: 'Teste', xml: sheet }] }))).grid).toEqual([
      ['ok', '', '', '5,00'],
    ]);
  });
});

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

describe('readWorkbookSheets limits on rows and columns', () => {
  it('reads at most maxRows rows and maxColumns columns, and says the sheet was truncated', async () => {
    const buffer = buildXlsx({
      sheets: [
        {
          name: 'Grande',
          rows: [
            ['a1', 'b1', 'c1', 1, 2],
            ['a2'],
            ['a3'],
            ['a4'],
          ],
        },
      ],
    });

    const [sheet] = await readWorkbookSheets(buffer, { maxRows: 3, maxColumns: 4 });

    expect(sheet?.grid).toEqual([['a1', 'b1', 'c1', '1,00'], ['a2'], ['a3']]);
    expect(sheet?.truncated).toBe(true);
  });

  it('does not count styled cells without a value, so long formatted sheets are not truncated', async () => {
    let rows = '<row r="1"><c r="A1" t="inlineStr"><is><t>ok</t></is></c></row>';
    for (let row = 2; row <= 950; row++) rows += `<row r="${row}" s="3" customFormat="1"><c r="A${row}" s="25"/><c r="AZ${row}" s="25"/></row>`;
    rows += '<row r="951"><c r="ZZ951" t="s"><v>99</v></c></row>';

    const [sheet] = await readWorkbookSheets(buildXlsx({ sheets: [{ name: 'Formatada', xml: worksheetXml(rows) }] }), {
      maxRows: 100,
      maxColumns: 10,
    });

    expect(sheet).toMatchObject({ grid: [['ok']], truncated: false });
  });

  it('counts a value beyond the columns limit as truncation', async () => {
    const [sheet] = await readWorkbookSheets(
      buildXlsx({ sheets: [{ name: 'Larga', xml: worksheetXml('<row r="1"><c r="A1"><v>1</v></c><c r="AO1"><v>2</v></c></row>') }] }),
    );

    expect(sheet).toMatchObject({ grid: [['1']], truncated: true });
  });
});

describe('readWorkbookSheets guards', () => {
  it('rejects a buffer that is not a zip archive', async () => {
    await expect(readWorkbookSheets(Buffer.from('a;b\n1;2\n'))).rejects.toEqual(badRequest('not an .xlsx workbook'));
    await expect(readWorkbookSheets(Buffer.alloc(0))).rejects.toEqual(badRequest('not an .xlsx workbook'));
  });

  it('rejects a damaged archive', async () => {
    const valid = buildXlsx({ sheets: [{ name: 'OUT', rows: [['a']] }] });

    await expect(readWorkbookSheets(valid.subarray(0, valid.length - 30))).rejects.toEqual(
      badRequest('Could not read the .xlsx file'),
    );
  });

  it('rejects a zip archive that is not a workbook', async () => {
    const document = buildZip([{ name: 'word/document.xml', data: '<w:document/>' }]);

    await expect(readWorkbookSheets(document)).rejects.toEqual(badRequest('not an .xlsx workbook'));
  });

  it('rejects a sheet the workbook lists but the archive lacks', async () => {
    const buffer = buildXlsx({ sheets: [{ name: 'OUT', rows: [['a']] }] });
    const withoutSheet = buildZip(
      unzipEntries(buffer).filter((entry) => entry.name !== 'xl/worksheets/sheet1.xml'),
    );

    await expect(readWorkbookSheets(withoutSheet)).rejects.toEqual(badRequest('Could not read the .xlsx file'));
  });

  it('rejects an archive whose declared uncompressed size is above the limit, before inflating anything', async () => {
    const buffer = buildXlsx({ sheets: [{ name: 'OUT', rows: [['a'.repeat(5000)]] }] });

    await expect(readWorkbookSheets(buffer, { maxUncompressedBytes: 4000 })).rejects.toEqual(
      badRequest('too large once uncompressed'),
    );
  });

  it('stops inflating an entry that grows past the budget although its header declares a small size', async () => {
    const bomb = worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${'x'.repeat(400_000)}</t></is></c></row>`);
    const buffer = buildXlsx({
      sheets: [{ name: 'OUT', rows: [['a']] }],
      files: [{ name: 'xl/worksheets/sheet1.xml', data: bomb, declaredSize: 100 }],
    });

    await expect(readWorkbookSheets(buffer, { maxUncompressedBytes: 100_000 })).rejects.toEqual(
      badRequest('too large once uncompressed'),
    );
  });

  it('treats ZIP64 size markers as too large', async () => {
    const buffer = buildXlsx({
      sheets: [{ name: 'OUT', rows: [['a']] }],
      files: [{ name: 'xl/worksheets/sheet1.xml', data: worksheetXml(''), declaredSize: 0xffffffff }],
    });

    await expect(readWorkbookSheets(buffer)).rejects.toEqual(badRequest(/too large once uncompressed.*ZIP64/));
  });

  it('rejects an archive with more entries than allowed', async () => {
    const buffer = buildXlsx({ sheets: [{ name: 'OUT', rows: [['a']] }] });

    await expect(readWorkbookSheets(buffer, { maxEntries: 5 })).rejects.toEqual(badRequest('too many entries'));
  });

  it('rejects a workbook with more sheets than allowed', async () => {
    const sheets = ['JAN', 'FEV', 'MAR'].map((name) => ({ name, rows: [['a']] }));

    await expect(readWorkbookSheets(buildXlsx({ sheets }), { maxSheets: 2 })).rejects.toEqual(
      badRequest('The workbook has more than 2 sheets.'),
    );
  });
});

// ---------------------------------------------------------------------------
// Hostile parts: every read is linear and every collection is capped
// ---------------------------------------------------------------------------

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const SST_HEAD = `<?xml version="1.0" encoding="UTF-8"?><sst xmlns="${MAIN_NS}">`;
const STYLES_HEAD = `<?xml version="1.0" encoding="UTF-8"?><styleSheet xmlns="${MAIN_NS}">`;
const WORKBOOK_HEAD =
  `<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="${MAIN_NS}" ` +
  'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets>';

/** One valid tab, with one part replaced by the given content. */
function withPart(name: string, data: string): Buffer {
  return buildXlsx({ sheets: [{ name: 'OUT', rows: [['', 'Descrição']] }], files: [{ name, data }] });
}

/** One tab whose worksheet part is exactly this XML. */
function withSheetXml(xml: string): Buffer {
  return buildXlsx({ sheets: [{ name: 'OUT', xml }] });
}

/** Reads the workbook and reports how long it took and how it ended. */
async function timedRead(buffer: Buffer): Promise<{ ms: number; outcome: unknown }> {
  const started = performance.now();
  const outcome = await readWorkbookSheets(buffer).catch((error: unknown) => error);
  return { ms: performance.now() - started, outcome };
}

function damaged(part: string) {
  return badRequest(`Could not read the .xlsx file (damaged XML in ${part}).`);
}

describe('readWorkbookSheets on hostile parts (each took seconds before the forward-only scanner)', () => {
  it.each<[string, () => Buffer, string]>([
    ['200k unclosed <si> in the shared strings', () => withPart('xl/sharedStrings.xml', SST_HEAD + '<si>'.repeat(200_000)), 'xl/sharedStrings.xml'],
    ['an item made of 200k "<t " without ">"', () => withPart('xl/sharedStrings.xml', `${SST_HEAD}<si>${'<t '.repeat(200_000)}</si></sst>`), 'xl/sharedStrings.xml'],
    ['a cell made of 200k "<v " without ">"', () => withSheetXml(worksheetXml(`<row r="1"><c r="A1">${'<v '.repeat(200_000)}</c></row>`)), 'xl/worksheets/sheet1.xml'],
    ['a cell with 200k unclosed <is>', () => withSheetXml(worksheetXml(`<row r="1"><c r="A1" t="inlineStr">${'<is>'.repeat(200_000)}</c></row>`)), 'xl/worksheets/sheet1.xml'],
    ['100k unclosed <cellXfs>', () => withPart('xl/styles.xml', STYLES_HEAD + '<cellXfs>'.repeat(100_000)), 'xl/styles.xml'],
    ['100k "<sheetData " without ">"', () => withSheetXml('<worksheet>' + '<sheetData '.repeat(100_000)), 'xl/worksheets/sheet1.xml'],
    ['a sheetData that never closes', () => withSheetXml(worksheetXml('').replace('</sheetData>', '<row r="1"><c r="A1"><v>1')), 'xl/worksheets/sheet1.xml'],
  ])('rejects %s as damaged, in well under a second', async (_label, build, part) => {
    const { ms, outcome } = await timedRead(build());

    expect(outcome).toEqual(damaged(part));
    expect(ms).toBeLessThan(1000);
  });

  it('reads a 30k-character number format without scanning it more than once, and rejects a longer one', async () => {
    const styles = (code: string) =>
      `${STYLES_HEAD}<numFmts count="1"><numFmt numFmtId="164" formatCode="${code}"/></numFmts><cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>`;

    const long = await timedRead(withPart('xl/styles.xml', styles('['.repeat(30_000))));
    const tooLong = await timedRead(withPart('xl/styles.xml', styles('['.repeat(40_000))));

    expect(long.outcome).toEqual([expect.objectContaining({ name: 'OUT' })]);
    expect(long.ms).toBeLessThan(1000);
    expect(tooLong.outcome).toEqual(damaged('xl/styles.xml'));
  });

  it('does not take a number format longer than 255 characters for a date', async () => {
    const styles =
      `${STYLES_HEAD}<numFmts count="1"><numFmt numFmtId="164" formatCode="${'0'.repeat(300)}dd/mm/yyyy"/></numFmts>` +
      '<cellXfs count="1"><xf numFmtId="164"/></cellXfs></styleSheet>';
    const buffer = buildXlsx({
      sheets: [{ name: 'OUT', xml: worksheetXml('<row r="1"><c r="A1" s="0"><v>46096</v></c></row>') }],
      styles,
    });

    expect((await onlySheet(buffer)).grid).toEqual([['46096']]);
  });

  it.each<[string, () => Buffer, string]>([
    ['1,000,001 shared strings', () => withPart('xl/sharedStrings.xml', `${SST_HEAD}${'<si/>'.repeat(1_000_001)}</sst>`), 'too many shared strings (limit 1,000,000)'],
    ['131,073 cell styles', () => withPart('xl/styles.xml', `${STYLES_HEAD}<cellXfs>${'<xf/>'.repeat(131_073)}</cellXfs></styleSheet>`), 'too many cell styles (limit 131,072)'],
    ['4,097 number formats', () => withPart('xl/styles.xml', `${STYLES_HEAD}<numFmts>${'<numFmt numFmtId="200" formatCode="0"/>'.repeat(4_097)}</numFmts></styleSheet>`), 'too many number formats (limit 4,096)'],
    ['10,001 relationships', () => withPart('xl/_rels/workbook.xml.rels', `<Relationships>${'<Relationship Id="r" Target="a"/>'.repeat(10_001)}</Relationships>`), 'too many relationships (limit 10,000)'],
    ['100,001 merged ranges in a sheet', () => withSheetXml(worksheetXml('<row r="1"><c r="A1"><v>1</v></c></row>', `<mergeCells>${'<mergeCell ref="A3000:B3001"/>'.repeat(100_001)}</mergeCells>`)), 'too many merged ranges in one sheet (limit 100,000)'],
    ['a workbook listing 200k sheets', () => withPart('xl/workbook.xml', `${WORKBOOK_HEAD}${'<sheet/>'.repeat(200_000)}</sheets></workbook>`), 'The workbook has more than 60 sheets.'],
  ])('stops at the cap of %s with a 400, fast', async (_label, build, message) => {
    const { ms, outcome } = await timedRead(build());

    expect(outcome).toEqual(badRequest(message));
    expect(ms).toBeLessThan(1000);
  });

  it.each<[string, string, string]>([
    ['a shared string item that never closes', 'xl/sharedStrings.xml', `${SST_HEAD}<si><t>a</t>`],
    ['a nested shared string item', 'xl/sharedStrings.xml', `${SST_HEAD}<si><si/></si></sst>`],
    ['a cellXfs that never closes', 'xl/styles.xml', `${STYLES_HEAD}<cellXfs><xf/>`],
    ['a sheet part with a DOCTYPE', 'xl/worksheets/sheet1.xml', '<!DOCTYPE worksheet [<!ENTITY a "b">]><worksheet/>'],
  ])('rejects %s', async (_label, part, data) => {
    await expect(readWorkbookSheets(withPart(part, data))).rejects.toEqual(damaged(part));
  });

  it.each<[string, string]>([
    ['a cell inside a cell', '<row r="1"><c r="A1"><c r="B1"/></c></row>'],
    ['a value that never closes', '<row r="1"><c r="A1"><v>1</c></row>'],
    ['an inline text that never closes', '<row r="1"><c r="A1" t="inlineStr"><is><t>a</is></c></row>'],
  ])('rejects %s in a sheet', async (_label, rows) => {
    await expect(readWorkbookSheets(withSheetXml(worksheetXml(rows)))).rejects.toEqual(damaged('xl/worksheets/sheet1.xml'));
  });

  it('decodes only the shared strings a cell uses', async () => {
    const sharedStrings = `${SST_HEAD}<si><t>usado</t></si><si><t>${'x'.repeat(MAX_CELL_TEXT + 1)}</t></si></sst>`;
    const buffer = buildXlsx({
      sheets: [{ name: 'OUT', xml: worksheetXml('<row r="1"><c r="A1" t="s"><v>0</v></c></row>') }],
      files: [{ name: 'xl/sharedStrings.xml', data: sharedStrings }],
    });

    expect((await onlySheet(buffer)).grid).toEqual([['usado']]);
  });
});

describe('readWorkbookSheets text limits', () => {
  /** `count` rows, each with one cell in column B holding shared string 0. */
  function columnB(count: number): string {
    return Array.from({ length: count }, (_, index) => `<row r="${index + 1}"><c r="B${index + 1}" t="s"><v>0</v></c></row>`).join('');
  }

  function sheetWithSharedString(text: string, cells: string): Buffer {
    return buildXlsx({
      sheets: [{ name: 'OUT', xml: worksheetXml(cells) }],
      files: [{ name: 'xl/sharedStrings.xml', data: `${SST_HEAD}<si><t>${text}</t></si></sst>` }],
    });
  }

  it('reads a cell of exactly 50,000 characters (the Google Sheets limit) and rejects a longer one, naming it', async () => {
    const cell = '<row r="3"><c r="B3" t="s"><v>0</v></c></row>';

    expect((await onlySheet(sheetWithSharedString('a'.repeat(MAX_CELL_TEXT), cell))).grid[2]?.[1]).toHaveLength(MAX_CELL_TEXT);
    await expect(readWorkbookSheets(sheetWithSharedString('a'.repeat(MAX_CELL_TEXT + 1), cell))).rejects.toEqual(
      badRequest('Cell B3 of sheet "OUT" has more than 50,000 characters.'),
    );
  });

  it('applies the same limit to inline strings and formula strings', async () => {
    const long = 'b'.repeat(MAX_CELL_TEXT + 1);

    await expect(
      readWorkbookSheets(withSheetXml(worksheetXml(`<row r="1"><c r="A1" t="inlineStr"><is><t>${long}</t></is></c></row>`))),
    ).rejects.toEqual(badRequest('Cell A1 of sheet "OUT" has more than'));
    await expect(
      readWorkbookSheets(withSheetXml(worksheetXml(`<row r="2"><c r="C2" t="str"><f>x</f><v>${long}</v></c></row>`))),
    ).rejects.toEqual(badRequest('Cell C2 of sheet "OUT" has more than'));
  });

  it('answers fast when one 1 MB string fills a whole column', async () => {
    const { ms, outcome } = await timedRead(sheetWithSharedString('x'.repeat(1024 * 1024), columnB(2000)));

    expect(outcome).toEqual(badRequest('Cell B1 of sheet "OUT" has more than 50,000 characters.'));
    expect(ms).toBeLessThan(1000);
  });

  it('stops when the cells read hold more characters than the workbook budget', async () => {
    const { ms, outcome } = await timedRead(sheetWithSharedString('y'.repeat(30_000), columnB(2000)));

    expect(outcome).toEqual(badRequest('more text than the importer reads (limit 5,000,000 characters)'));
    expect(ms).toBeLessThan(1000);
    // Four cells of three characters: 12 fit a budget of 12, not one of 11.
    await expect(readWorkbookSheets(sheetWithSharedString('abc', columnB(4)), { maxCharacters: 11 })).rejects.toEqual(
      badRequest('limit 11 characters'),
    );
    expect((await readWorkbookSheets(sheetWithSharedString('abc', columnB(4)), { maxCharacters: 12 }))[0]?.grid).toHaveLength(4);
  });

  it('charges every sheet of the workbook to the same budget', async () => {
    const sheet = { name: 'S', rows: [['abcd'], ['efgh']] };

    await expect(readWorkbookSheets(buildXlsx({ sheets: [sheet, { ...sheet, name: 'T' }] }), { maxCharacters: 15 })).rejects.toEqual(
      badRequest('limit 15 characters'),
    );
    expect(await readWorkbookSheets(buildXlsx({ sheets: [sheet, { ...sheet, name: 'T' }] }), { maxCharacters: 16 })).toHaveLength(2);
  });
});

describe('readWorkbookSheets under a 256 MB heap', () => {
  // A child process with a small heap: before the caps, these archives (a few dozen KB) needed 1.5-1.9 GB.
  const childCode = `
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    const { readWorkbookSheets } = await import(process.env.WORKBOOK_MODULE);
    try {
      const sheets = await readWorkbookSheets(Buffer.concat(chunks));
      console.log(JSON.stringify({ sheets: sheets.length }));
    } catch (error) {
      console.log(JSON.stringify({ statusCode: error.statusCode, message: error.message }));
    }`;

  function readInSmallHeap(buffer: Buffer): { status: number | null; result: unknown } {
    const child = spawnSync(
      process.execPath,
      ['--max-old-space-size=256', '--import', 'tsx', '--input-type=module', '-e', childCode],
      {
        cwd: fileURLToPath(new URL('../../../', import.meta.url)),
        input: buffer,
        env: { ...process.env, WORKBOOK_MODULE: new URL('./workbook.ts', import.meta.url).href },
        encoding: 'utf8',
        timeout: 60_000,
      },
    );
    const lastLine = child.stdout.trim().split('\n').pop() ?? '';
    return { status: child.status, result: lastLine ? JSON.parse(lastLine) : child.stderr.slice(-500) };
  }

  it.each<[string, () => Buffer, string]>([
    ['5M empty shared strings', () => withPart('xl/sharedStrings.xml', `${SST_HEAD}${'<si/>'.repeat(5_000_000)}</sst>`), 'too many shared strings'],
    ['5M sheet entries', () => withPart('xl/workbook.xml', `${WORKBOOK_HEAD}${'<sheet/>'.repeat(5_000_000)}</sheets></workbook>`), 'more than 60 sheets'],
  ])('answers 400 to %s instead of running out of memory', (_label, build, message) => {
    const { status, result } = readInSmallHeap(build());

    expect(status).toBe(0);
    expect(result).toEqual({ statusCode: 400, message: expect.stringContaining(message) });
  }, 60_000);
});

/** Entries of an archive built by buildZip (stored names, inflated data). */
function unzipEntries(buffer: Buffer): ZipFileSpec[] {
  const end = buffer.length - 22;
  const count = buffer.readUInt16LE(end + 10);
  let pointer = buffer.readUInt32LE(end + 16);
  const entries: ZipFileSpec[] = [];
  for (let index = 0; index < count; index++) {
    const compressedSize = buffer.readUInt32LE(pointer + 20);
    const nameLength = buffer.readUInt16LE(pointer + 28);
    const offset = buffer.readUInt32LE(pointer + 42);
    const name = buffer.toString('utf8', pointer + 46, pointer + 46 + nameLength);
    const dataStart = offset + 30 + buffer.readUInt16LE(offset + 26) + buffer.readUInt16LE(offset + 28);
    entries.push({ name, data: inflateRawSync(buffer.subarray(dataStart, dataStart + compressedSize)) });
    pointer += 46 + nameLength + buffer.readUInt16LE(pointer + 30) + buffer.readUInt16LE(pointer + 32);
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Equivalence with the CSV export of the same tab
// ---------------------------------------------------------------------------

describe('a MaxFin tab read from .xlsx gives what its CSV export gives', () => {
  const csv = readFileSync(new URL('../../modules/transactions/parsers/__fixtures__/maxfin-sample.csv', import.meta.url));
  const csvGrid = bufferToGrid(csv).grid;

  /** The same tab as a spreadsheet holds it: money as numbers with a currency format, the title merged and rich. */
  async function sampleWorkbook(): Promise<Buffer> {
    return writeWithExcelJs((workbook) => {
      const sheet = workbook.addWorksheet('MAR');
      csvGrid.forEach((cells, rowIndex) => {
        cells.forEach((text, columnIndex) => {
          if (text === '') return;
          const cell = sheet.getCell(rowIndex + 1, columnIndex + 1);
          const money = columnIndex >= 3 && columnIndex <= 8 ? parseMoneyBR(text) : null;
          if (money !== null) {
            cell.value = money;
            cell.numFmt = '[$R$ -416]#,##0.00';
          } else if (rowIndex === 0 && columnIndex === 0) {
            const [first = '', second = ''] = text.split('\n');
            cell.value = { richText: [{ text: `${first}\n`, font: { bold: true } }, { text: second }] };
          } else {
            cell.value = text;
          }
        });
      });
      sheet.mergeCells('A1:J1');
    });
  }

  it('has the same cells: identical text outside the money columns, the same amounts inside them', async () => {
    const { grid } = await onlySheet(await sampleWorkbook());

    expect(grid).toHaveLength(csvGrid.length);
    for (let row = 0; row < csvGrid.length; row++) {
      for (let column = 0; column < 10; column++) {
        const fromCsv = csvGrid[row]?.[column] ?? '';
        const fromXlsx = grid[row]?.[column] ?? '';
        const where = `${String.fromCharCode(65 + column)}${row + 1}`;
        if (column >= 3 && column <= 8) {
          expect(parseMoneyBR(fromXlsx), where).toBe(parseMoneyBR(fromCsv));
          if (parseMoneyBR(fromCsv) === null) expect(fromXlsx, where).toBe(fromCsv);
        } else {
          expect(fromXlsx, where).toBe(fromCsv);
        }
      }
    }
  });

  it('parses into the same rows, skipped rows, sections and month as the CSV', async () => {
    const { grid } = await onlySheet(await sampleWorkbook());
    const pick = (result: ReturnType<typeof parseMaxFinGrid>) => ({
      month: result.month,
      monthSource: result.monthSource,
      rows: result.rows.map((row) => ({
        sourceRef: row.sourceRef,
        section: row.section,
        type: row.type,
        description: row.description,
        categoryKey: row.categoryKey,
        amount: row.amount,
        paid: row.paid,
        installment: row.installment,
        notes: row.notes,
        flag: row.flag,
        shareHint: row.shareHint,
      })),
      skipped: result.skipped,
      sections: result.sections,
      warnings: result.warnings,
    });

    const fromXlsx = pick(parseMaxFinGrid(grid));
    const fromCsv = pick(parseMaxFinGrid(csvGrid));

    expect(fromXlsx.rows.length).toBeGreaterThan(10);
    expect(fromXlsx).toEqual(fromCsv);
  });
});

describe('readWorkbookSheets on details of Excel-written workbooks', () => {
  it('keeps the 1904 date system when an x15:workbookPr extension follows the real element', async () => {
    const workbookXml =
      '<?xml version="1.0" encoding="UTF-8"?><workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" ' +
      'xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><workbookPr date1904="1"/><sheets>' +
      '<sheet name="Datas" sheetId="1" r:id="rId3"/></sheets><extLst><ext uri="{140A7094-0E35-4892-8432-C4D2E57EDEB5}" ' +
      'xmlns:x15="http://schemas.microsoft.com/office/spreadsheetml/2010/11/main"><x15:workbookPr chartTrackingRefBase="1"/></ext></extLst></workbook>';
    const buffer = buildXlsx({
      sheets: [{ name: 'Datas', xml: worksheetXml('<row r="1"><c r="A1" s="1"><v>0</v></c></row>') }],
      files: [{ name: 'xl/workbook.xml', data: workbookXml }],
    });
    expect((await readWorkbookSheets(buffer))[0]?.grid).toEqual([['01/01/1904']]);
  });

  it('rounds money as shown with 15 significant digits (Excel stores 17)', async () => {
    const buffer = buildXlsx({
      sheets: [{ name: 'Valores', xml: worksheetXml('<row r="1"><c r="D1"><v>10.004999999999999</v></c><c r="E1"><v>636.905</v></c><c r="F1"><v>0.30000000000000004</v></c></row>') }],
    });
    expect((await readWorkbookSheets(buffer))[0]?.grid[0]?.slice(3)).toEqual(['10,01', '636,91', '0,30']);
  });
});
