/**
 * Test-only builders for .xlsx fixtures: a tiny zip writer (so tests can craft archives no spreadsheet
 * application would write, such as lying sizes or ZIP64 markers) and a minimal workbook writer on top of it.
 * Not used at runtime.
 */
import { deflateRawSync } from 'node:zlib';

export interface ZipFileSpec {
  name: string;
  data: Buffer | string;
  /** 8 = deflated (default), 0 = stored. */
  method?: 0 | 8;
  /** Uncompressed size written to the headers instead of the real one (to fake lying or ZIP64 archives). */
  declaredSize?: number;
}

const CRC_TABLE = Array.from({ length: 256 }, (_, n) => {
  let c = n;
  for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
  return c >>> 0;
});

function crc32(data: Buffer): number {
  let crc = 0xffffffff;
  for (const byte of data) crc = (CRC_TABLE[(crc ^ byte) & 0xff] ?? 0) ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

/** A single-disk zip archive with UTF-8 names, no data descriptors and no ZIP64 records. */
export function buildZip(files: ZipFileSpec[]): Buffer {
  const parts: Buffer[] = [];
  const directory: Buffer[] = [];
  let offset = 0;

  for (const file of files) {
    const name = Buffer.from(file.name, 'utf8');
    const data = typeof file.data === 'string' ? Buffer.from(file.data, 'utf8') : file.data;
    const method = file.method ?? 8;
    const body = method === 8 ? deflateRawSync(data) : data;
    const size = file.declaredSize ?? data.length;
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0x0800, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(body.length, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.length, 26);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(20, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(0x0800, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(body.length, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.length, 28);
    central.writeUInt32LE(offset, 42);

    parts.push(local, name, body);
    directory.push(central, name);
    offset += local.length + name.length + body.length;
  }

  const centralDirectory = Buffer.concat(directory);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(files.length, 8);
  end.writeUInt16LE(files.length, 10);
  end.writeUInt32LE(centralDirectory.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralDirectory, end]);
}

export function escapeXml(text: string): string {
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** 1 -> "A", 28 -> "AB". */
export function columnName(column: number): string {
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

/** A cell value: text (shared string), number, boolean; null, undefined and '' leave the cell out. */
export type FixtureValue = string | number | boolean | null | undefined;

export interface FixtureSheet {
  name: string;
  state?: 'visible' | 'hidden' | 'veryHidden';
  /** Row i is sheet row i+1, cell j is column j+1. */
  rows?: FixtureValue[][];
  /** Merged ranges ("A1:J1"). */
  merges?: string[];
  /** Full worksheet XML, for cells the row helper cannot express (replaces rows and merges). */
  xml?: string;
}

export interface FixtureWorkbook {
  sheets: FixtureSheet[];
  /** xl/styles.xml; the default has cellXfs 0 = General, 1 = dd/mm/yyyy (164), 2 = money (165), 3 = builtin 14. */
  styles?: string;
  /** Extra shared strings appended after the ones the rows use (for raw sheets that reference them). */
  sharedStrings?: string[];
  /** Relationship targets as absolute part names ("/xl/worksheets/sheet1.xml"). */
  absoluteTargets?: boolean;
  /** Entries added to (or replacing) the generated ones, by name. */
  files?: ZipFileSpec[];
}

const MAIN_NS = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
const REL_NS = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
const PACKAGE_REL_NS = 'http://schemas.openxmlformats.org/package/2006/relationships';
const XML_HEADER = '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>\n';

export const DEFAULT_STYLES =
  `${XML_HEADER}<styleSheet xmlns="${MAIN_NS}">` +
  '<numFmts count="2"><numFmt numFmtId="164" formatCode="dd/mm/yyyy"/>' +
  '<numFmt numFmtId="165" formatCode="[$R$ -416]#,##0.00"/></numFmts>' +
  '<cellStyleXfs count="1"><xf numFmtId="0"/></cellStyleXfs>' +
  '<cellXfs count="4"><xf numFmtId="0" xfId="0"/><xf numFmtId="164" xfId="0" applyNumberFormat="1"/>' +
  '<xf numFmtId="165" xfId="0" applyNumberFormat="1"/><xf numFmtId="14" xfId="0" applyNumberFormat="1"/></cellXfs>' +
  '</styleSheet>';

/** Wraps sheetData content (and anything after it) in a worksheet element. */
export function worksheetXml(sheetData: string, after = ''): string {
  return `${XML_HEADER}<worksheet xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheetData>${sheetData}</sheetData>${after}</worksheet>`;
}

/** A minimal but complete .xlsx: content types, relationships, workbook, shared strings, styles and sheets. */
export function buildXlsx(workbook: FixtureWorkbook): Buffer {
  const sharedStrings: string[] = [];
  const sharedIndex = new Map<string, number>();
  const intern = (text: string): number => {
    let index = sharedIndex.get(text);
    if (index === undefined) {
      index = sharedStrings.length;
      sharedStrings.push(text);
      sharedIndex.set(text, index);
    }
    return index;
  };

  const sheetParts = workbook.sheets.map((sheet) => {
    if (sheet.xml !== undefined) return sheet.xml;
    const rows = (sheet.rows ?? [])
      .map((cells, rowIndex) => {
        const cellsXml = cells
          .map((value, columnIndex) => {
            if (value === null || value === undefined || value === '') return '';
            const reference = `${columnName(columnIndex + 1)}${rowIndex + 1}`;
            if (typeof value === 'number') return `<c r="${reference}"><v>${value}</v></c>`;
            if (typeof value === 'boolean') return `<c r="${reference}" t="b"><v>${value ? 1 : 0}</v></c>`;
            return `<c r="${reference}" t="s"><v>${intern(value)}</v></c>`;
          })
          .join('');
        return cellsXml ? `<row r="${rowIndex + 1}">${cellsXml}</row>` : '';
      })
      .join('');
    const merges = sheet.merges?.length
      ? `<mergeCells count="${sheet.merges.length}">${sheet.merges.map((ref) => `<mergeCell ref="${ref}"/>`).join('')}</mergeCells>`
      : '';
    return worksheetXml(rows, merges);
  });
  for (const text of workbook.sharedStrings ?? []) sharedStrings.push(text);

  const target = (path: string) => (workbook.absoluteTargets ? `/xl/${path}` : path);
  const sheetsXml = workbook.sheets
    .map(
      (sheet, index) =>
        `<sheet name="${escapeXml(sheet.name)}" sheetId="${index + 1}"${sheet.state ? ` state="${sheet.state}"` : ''} r:id="rId${index + 3}"/>`,
    )
    .join('');
  const workbookRelationships = workbook.sheets
    .map(
      (_, index) =>
        `<Relationship Id="rId${index + 3}" Type="${REL_NS}/worksheet" Target="${target(`worksheets/sheet${index + 1}.xml`)}"/>`,
    )
    .join('');

  const generated: ZipFileSpec[] = [
    {
      name: '[Content_Types].xml',
      data:
        `${XML_HEADER}<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">` +
        '<Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>' +
        '<Default Extension="xml" ContentType="application/xml"/></Types>',
    },
    {
      name: '_rels/.rels',
      data: `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}"><Relationship Id="rId1" Type="${REL_NS}/officeDocument" Target="xl/workbook.xml"/></Relationships>`,
    },
    {
      name: 'xl/workbook.xml',
      data: `${XML_HEADER}<workbook xmlns="${MAIN_NS}" xmlns:r="${REL_NS}"><sheets>${sheetsXml}</sheets></workbook>`,
    },
    {
      name: 'xl/_rels/workbook.xml.rels',
      data:
        `${XML_HEADER}<Relationships xmlns="${PACKAGE_REL_NS}">` +
        `<Relationship Id="rId1" Type="${REL_NS}/styles" Target="${target('styles.xml')}"/>` +
        `<Relationship Id="rId2" Type="${REL_NS}/sharedStrings" Target="${target('sharedStrings.xml')}"/>` +
        `${workbookRelationships}</Relationships>`,
    },
    {
      name: 'xl/sharedStrings.xml',
      data:
        `${XML_HEADER}<sst xmlns="${MAIN_NS}" count="${sharedStrings.length}" uniqueCount="${sharedStrings.length}">` +
        `${sharedStrings.map((text) => `<si><t xml:space="preserve">${escapeXml(text)}</t></si>`).join('')}</sst>`,
    },
    { name: 'xl/styles.xml', data: workbook.styles ?? DEFAULT_STYLES },
    ...sheetParts.map((xml, index) => ({ name: `xl/worksheets/sheet${index + 1}.xml`, data: xml })),
  ];

  const overrides = new Map((workbook.files ?? []).map((file) => [file.name, file]));
  const files = generated.map((file) => overrides.get(file.name) ?? file);
  for (const file of workbook.files ?? []) {
    if (!generated.some((generatedFile) => generatedFile.name === file.name)) files.push(file);
  }
  return buildZip(files);
}
