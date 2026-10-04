/**
 * Reads the tabs of an .xlsx workbook into grids of text that the spreadsheet importers parse the same way as
 * Google Sheets' CSV export of each tab (shared/csv/grid.ts), so their `sourceRef` line numbers match either source.
 * Node built-ins only: zip.ts opens the archive and xml-scanner.ts reads each part forward, once, in linear time.
 *
 * Grid row i is sheet row i+1 and grid column j is sheet column j+1; gaps are empty cells, trailing empty rows and
 * cells are dropped. Cell rules:
 * - always the cached value (`<v>`): a formula is read through its last result, and one without a cached result is
 *   an empty cell, exactly like the CSV export;
 * - numbers in the money columns D..I become pt-BR money text with two decimals and no thousands separator
 *   ("1300,00", "-156,00"), half a cent rounding away from zero on the decimal the sheet shows; numbers elsewhere
 *   become plain text with a comma decimal mark ("3,5"), or dd/mm/yyyy when date-formatted (the CSV export shows
 *   the formatted text there, e.g. "R$ 3.883,14", which the importers do not read);
 * - shared and inline strings (rich-text runs joined, phonetic runs ignored), formula strings, ISO dates as
 *   dd/mm/yyyy, booleans as "TRUE"/"FALSE", errors as ""; XML entities and Excel `_xHHHH_` escapes are decoded and
 *   line breaks become "\n" (as the CSV tokenizer leaves them);
 * - in a merged range only the top-left cell keeps its value.
 *
 * Limits keep a hostile upload cheap: every count the reader collects is capped and checked as it grows, a cell
 * holds at most 50,000 characters (Google Sheets' limit) and the cells read from a workbook hold at most
 * maxCharacters.
 */
import type { Grid } from '../csv/grid.js';
import { AppError, BadRequestError } from '../errors/app-error.js';
import { damagedPart, decodeEntities, XmlScanner } from './xml-scanner.js';
import { notAWorkbook, openZip, unreadableWorkbook, type ZipArchive, type ZipLimits } from './zip.js';

export interface WorkbookLimits extends ZipLimits {
  /** More sheets than this rejects the workbook. */
  maxSheets: number;
  /** Rows read per sheet; values below them are ignored and mark the sheet as truncated. */
  maxRows: number;
  /** Columns read per sheet; values to their right are ignored and mark the sheet as truncated. */
  maxColumns: number;
  /** Characters of all the cells read from the workbook; more rejects it. */
  maxCharacters: number;
}

export const DEFAULT_WORKBOOK_LIMITS: Readonly<WorkbookLimits> = Object.freeze({
  maxUncompressedBytes: 50 * 1024 * 1024,
  maxEntries: 10_000,
  maxSheets: 60,
  maxRows: 2_000,
  maxColumns: 40,
  maxCharacters: 5_000_000,
});

export interface WorkbookSheet {
  name: string;
  /** Hidden (or very hidden) tab. It is read like any other. */
  hidden: boolean;
  /** The tab has values beyond maxRows or maxColumns, which were not read. */
  truncated: boolean;
  grid: Grid;
}

/** Longest text of one cell: Google Sheets' limit (the workbooks come from there; Excel's own is 32,767). */
export const MAX_CELL_TEXT = 50_000;
/** Caps on what the reader collects, well above what Excel itself allows (64k cell formats, ~250 number formats). */
const MAX_SHARED_STRINGS = 1_000_000;
const MAX_CELL_STYLES = 131_072;
const MAX_NUMBER_FORMATS = 4_096;
const MAX_RELATIONSHIPS = 10_000;
const MAX_MERGED_RANGES = 100_000;
/** Excel's limit for a number format code; longer codes are not dates. */
const MAX_FORMAT_CODE = 255;

/** 1-based sheet columns holding money in the MaxFin layout: D (Entrada - Previsto) to I (Saldo). */
const FIRST_MONEY_COLUMN = 4;
const LAST_MONEY_COLUMN = 9;
/** Days between Excel's day 0 (1899-12-30) and 1970-01-01, and the extra offset of the 1904 date system. */
const EXCEL_EPOCH_OFFSET_DAYS = 25569;
const DATE_1904_OFFSET_DAYS = 1462;
const MILLISECONDS_PER_DAY = 86_400_000;

const RELATIONSHIP_ATTRIBUTES = ['Id', 'Type', 'Target', 'TargetMode'] as const;
const SHEET_ATTRIBUTES = ['name', 'state', '*:id'] as const;
const CELL_ATTRIBUTES = ['r', 't', 's'] as const;
const R_ATTRIBUTE = ['r'] as const;
const REF_ATTRIBUTE = ['ref'] as const;
const NUMBER_FORMAT_ATTRIBUTES = ['numFmtId', 'formatCode'] as const;
const NUMBER_FORMAT_ID = ['numFmtId'] as const;
const DATE_1904_ATTRIBUTE = ['date1904'] as const;

function tooMany(what: string, limit: number): BadRequestError {
  return new BadRequestError(`The .xlsx file has too many ${what} (limit ${limit.toLocaleString('en-US')}).`);
}

// ---------------------------------------------------------------------------
// Text
// ---------------------------------------------------------------------------

const EXCEL_ESCAPE = /_x([0-9A-Fa-f]{4})_/g;

/** Entities, then Excel's `_xHHHH_` escapes (`_x005F_` escapes the underscore itself, so one pass is right). */
function unescapeText(raw: string): string {
  const decoded = decodeEntities(raw);
  if (!decoded.includes('_x')) return decoded;
  return decoded.replace(EXCEL_ESCAPE, (_, hex: string) => String.fromCharCode(Number.parseInt(hex, 16)));
}

/** CRLF and lone CR become "\n", as XML parsers and the CSV tokenizer leave them. */
function normalizeLineBreaks(text: string): string {
  return text.includes('\r') ? text.replace(/\r\n?/g, '\n') : text;
}

// ---------------------------------------------------------------------------
// Package structure
// ---------------------------------------------------------------------------

interface Relationship {
  type: string;
  /** Part name inside the zip, resolved against the source part's folder. */
  target: string;
}

interface SheetEntry {
  name: string;
  hidden: boolean;
  relationshipId: string | null;
}

function readXml(zip: ZipArchive, partName: string): string | null {
  return zip.read(partName)?.toString('utf8') ?? null;
}

function folderOf(partName: string): string {
  const slash = partName.lastIndexOf('/');
  return slash < 0 ? '' : partName.slice(0, slash);
}

/** `xl/workbook.xml` -> `xl/_rels/workbook.xml.rels`. */
function relationshipsPartOf(partName: string): string {
  const folder = folderOf(partName);
  const file = partName.slice(partName.lastIndexOf('/') + 1);
  return `${folder ? `${folder}/` : ''}_rels/${file}.rels`;
}

/** Targets are relative to the source folder ("worksheets/sheet1.xml") or absolute ("/xl/worksheets/sheet1.xml"). */
function resolvePartName(folder: string, target: string): string {
  const path = target.startsWith('/') ? target : `${folder}/${target}`;
  const segments: string[] = [];
  for (const segment of path.split('/')) {
    if (segment === '' || segment === '.') continue;
    if (segment === '..') segments.pop();
    else segments.push(segment);
  }
  return segments.join('/');
}

function parseRelationships(xml: string, part: string, folder: string): Map<string, Relationship> {
  const relationships = new Map<string, Relationship>();
  const scanner = new XmlScanner(xml, part);
  let count = 0;
  while (scanner.next()) {
    if (scanner.kind === 'close' || !scanner.is('Relationship')) continue;
    if (++count > MAX_RELATIONSHIPS) throw tooMany('relationships', MAX_RELATIONSHIPS);
    const [id, type, target, mode] = scanner.attributes(RELATIONSHIP_ATTRIBUTES);
    if (!id || !target || mode === 'External' || relationships.has(id)) continue;
    relationships.set(id, { type: type ?? '', target: resolvePartName(folder, target) });
  }
  return relationships;
}

function workbookPartName(zip: ZipArchive): string {
  const part = '_rels/.rels';
  const packageRelationships = readXml(zip, part);
  if (packageRelationships !== null) {
    for (const relationship of parseRelationships(packageRelationships, part, '').values()) {
      if (relationship.type.endsWith('/officeDocument')) return relationship.target;
    }
  }
  return 'xl/workbook.xml';
}

/** The `<sheet>` entries in document order (the tab order), stopping at the first one over the limit. */
function readWorkbookPart(xml: string, part: string, maxSheets: number): { entries: SheetEntry[]; date1904: boolean } {
  const scanner = new XmlScanner(xml, part);
  const entries: SheetEntry[] = [];
  let date1904 = false;
  let root = true;
  while (scanner.next()) {
    if (scanner.kind !== 'open' && scanner.kind !== 'empty') continue;
    if (root) {
      if (!scanner.is('workbook')) throw notAWorkbook('no workbook part');
      root = false;
    } else if (scanner.is('sheet')) {
      if (entries.length >= maxSheets) {
        throw new BadRequestError(`The workbook has more than ${maxSheets} sheets.`);
      }
      const [name, state, relationshipId] = scanner.attributes(SHEET_ATTRIBUTES);
      entries.push({
        name: name ?? '',
        hidden: state === 'hidden' || state === 'veryHidden',
        relationshipId: relationshipId ?? null,
      });
    } else if (scanner.is('workbookPr')) {
      // Excel 2013+ also writes <x15:workbookPr chartTrackingRefBase="1"/> in extLst, after the real element:
      // only an element that carries the attribute decides.
      const [value] = scanner.attributes(DATE_1904_ATTRIBUTE);
      if (value !== undefined) date1904 = value === '1' || value === 'true';
    }
  }
  if (root) throw notAWorkbook('no workbook part');
  return { entries, date1904 };
}

// ---------------------------------------------------------------------------
// Shared strings: item boundaries up front, text decoded only for the cells that use it
// ---------------------------------------------------------------------------

interface SharedStrings {
  /** Text of item `index` ("" when absent), or null when it is far longer than a cell can hold. */
  get(index: number): string | null;
}

/** Growable list of [start, end) offsets, 8 bytes per item. */
class OffsetPairs {
  private data = new Uint32Array(2048);
  length = 0;

  push(start: number, end: number): void {
    if (this.length * 2 + 2 > this.data.length) {
      const grown = new Uint32Array(this.data.length * 2);
      grown.set(this.data);
      this.data = grown;
    }
    this.data[this.length * 2] = start;
    this.data[this.length * 2 + 1] = end;
    this.length += 1;
  }

  start(index: number): number {
    return this.data[index * 2] ?? 0;
  }

  end(index: number): number {
    return this.data[index * 2 + 1] ?? 0;
  }
}

/**
 * Text of a string item (`<si>`) between start and end: its `<t>` texts, phonetic runs left out. Decoding stops
 * (null) once the text is past twice the cell limit; the cell limit itself is checked where cells are placed.
 */
function decodeStringItem(xml: string, part: string, start: number, end: number): string | null {
  const scanner = new XmlScanner(xml, part, start, end);
  let text = '';
  let inText = false;
  let phonetic = 0;
  while (scanner.next()) {
    const collecting = inText && phonetic === 0;
    if (collecting && scanner.textStart < scanner.start) text += unescapeText(scanner.text());
    if (scanner.kind === 'cdata') {
      if (collecting) text += scanner.cdata();
    } else if (scanner.is('t')) {
      if (scanner.kind === 'open') {
        if (inText) throw damagedPart(part);
        inText = true;
      } else if (scanner.kind === 'close') {
        if (!inText) throw damagedPart(part);
        inText = false;
      }
    } else if (scanner.is('rPh')) {
      if (scanner.kind === 'open') phonetic += 1;
      else if (scanner.kind === 'close') phonetic = Math.max(0, phonetic - 1);
    }
    // Line-break normalization can only halve the text: past twice the limit it can never fit.
    if (text.length > 2 * MAX_CELL_TEXT) return null;
  }
  if (inText) throw damagedPart(part);
  return normalizeLineBreaks(text);
}

function readSharedStrings(xml: string, part: string): SharedStrings {
  const items = new OffsetPairs();
  const scanner = new XmlScanner(xml, part);
  let itemStart = -1;
  while (scanner.next()) {
    if (!scanner.is('si')) continue;
    if (scanner.kind === 'open') {
      if (itemStart >= 0) throw damagedPart(part);
      itemStart = scanner.end;
      continue;
    }
    if (scanner.kind === 'close') {
      if (itemStart < 0) throw damagedPart(part);
      items.push(itemStart, scanner.start);
      itemStart = -1;
    } else {
      if (itemStart >= 0) throw damagedPart(part);
      items.push(0, 0);
    }
    if (items.length > MAX_SHARED_STRINGS) throw tooMany('shared strings', MAX_SHARED_STRINGS);
  }
  if (itemStart >= 0) throw damagedPart(part);

  const decoded = new Map<number, string | null>();
  return {
    get(index: number): string | null {
      if (!Number.isInteger(index) || index < 0 || index >= items.length) return '';
      let text = decoded.get(index);
      if (text === undefined) {
        const start = items.start(index);
        const end = items.end(index);
        text = start === end ? '' : decodeStringItem(xml, part, start, end);
        decoded.set(index, text);
      }
      return text;
    },
  };
}

// ---------------------------------------------------------------------------
// Styles: only to tell date-formatted numbers apart
// ---------------------------------------------------------------------------

/** Built-in number formats that Excel renders as dates or times. */
function isBuiltInDateFormat(id: number): boolean {
  return (id >= 14 && id <= 22) || (id >= 45 && id <= 47);
}

/** A format code is a date when, outside quoted text, [..] sections and escaped characters, it has d or y. */
function isDateFormatCode(code: string): boolean {
  for (let i = 0; i < code.length; i++) {
    const char = code[i];
    if (char === '"' || char === '[') {
      const close = code.indexOf(char === '"' ? '"' : ']', i + 1);
      if (close < 0) continue;
      i = close;
    } else if (char === '\\' || char === '_' || char === '*') {
      i += 1;
    } else if (char === 'd' || char === 'D' || char === 'y' || char === 'Y') {
      return true;
    }
  }
  return false;
}

/** For each cell style (`s` attribute = index into cellXfs), whether its number format is a date. */
function readDateStyles(xml: string, part: string): boolean[] {
  const customFormats = new Map<number, string>();
  const styleFormats: number[] = [];
  const scanner = new XmlScanner(xml, part);
  let numberFormats = 0;
  let inCellStyles = false;
  while (scanner.next()) {
    if (scanner.is('cellXfs')) {
      if (scanner.kind === 'open') {
        if (inCellStyles) throw damagedPart(part);
        inCellStyles = true;
      } else if (scanner.kind === 'close') {
        inCellStyles = false;
      }
    } else if (scanner.kind === 'close') {
      continue;
    } else if (scanner.is('numFmt')) {
      if (++numberFormats > MAX_NUMBER_FORMATS) throw tooMany('number formats', MAX_NUMBER_FORMATS);
      const [id, code] = scanner.attributes(NUMBER_FORMAT_ATTRIBUTES);
      const numberId = Number(id);
      if (Number.isInteger(numberId) && code !== undefined) customFormats.set(numberId, code);
    } else if (inCellStyles && scanner.is('xf')) {
      if (styleFormats.length >= MAX_CELL_STYLES) throw tooMany('cell styles', MAX_CELL_STYLES);
      const [id] = scanner.attributes(NUMBER_FORMAT_ID);
      styleFormats.push(Number(id ?? 0));
    }
  }
  if (inCellStyles) throw damagedPart(part);
  return styleFormats.map((id) => {
    const code = customFormats.get(id);
    if (code === undefined) return isBuiltInDateFormat(id);
    return code.length <= MAX_FORMAT_CODE && isDateFormatCode(code);
  });
}

// ---------------------------------------------------------------------------
// Cell values
// ---------------------------------------------------------------------------

interface SheetContext {
  sharedStrings: SharedStrings;
  dateStyles: readonly boolean[];
  date1904: boolean;
}

function twoDigits(value: number): string {
  return String(value).padStart(2, '0');
}

/**
 * Integer cents of a non-negative amount, rounding half a cent up. The decimal point is shifted on the
 * shortest decimal text of the number ("636.905" -> 63690.5), not on its binary value (636.905 * 100 is
 * 63690.49999999999), so the result is the one Google shows for the cached value.
 */
function toCents(amount: number): number {
  // Excel stores formula results with 17 significant digits (10.004999999999999) and shows 15 (10.005).
  const shown = Number(amount.toPrecision(15));
  const shifted = Number(`${shown}e2`);
  return Math.round(Number.isFinite(shifted) ? shifted : amount * 100);
}

/** 1300 -> "1300,00"; -156 -> "-156,00"; 12.9 -> "12,90"; -0.004 -> "0,00". */
function moneyText(value: number): string {
  const cents = toCents(Math.abs(value));
  const sign = value < 0 && cents > 0 ? '-' : '';
  return `${sign}${Math.floor(cents / 100)},${twoDigits(cents % 100)}`;
}

/** 3.5 -> "3,5"; 2026 -> "2026". */
function plainNumberText(value: number): string {
  return String(value).replace('.', ',');
}

/** Excel serial day -> dd/mm/yyyy (UTC), or null when out of range. */
function serialDateText(serial: number, date1904: boolean): string | null {
  const days = serial + (date1904 ? DATE_1904_OFFSET_DAYS : 0) - EXCEL_EPOCH_OFFSET_DAYS;
  const date = new Date(Math.round(days * MILLISECONDS_PER_DAY));
  if (Number.isNaN(date.getTime())) return null;
  return `${twoDigits(date.getUTCDate())}/${twoDigits(date.getUTCMonth() + 1)}/${String(date.getUTCFullYear()).padStart(4, '0')}`;
}

/** "2026-03-15T00:00:00Z" -> "15/03/2026" (the date part as written, no time zone shift). */
function isoDateText(text: string): string {
  const match = /^(\d{4})-(\d{2})-(\d{2})/.exec(text.trim());
  return match ? `${match[3]}/${match[2]}/${match[1]}` : text;
}

function numberText(text: string, column: number, dateStyled: boolean, date1904: boolean): string {
  const trimmed = text.trim();
  if (trimmed === '') return '';
  const value = Number(trimmed);
  if (!Number.isFinite(value)) return text;
  if (column >= FIRST_MONEY_COLUMN && column <= LAST_MONEY_COLUMN) return moneyText(value);
  if (dateStyled) return serialDateText(value, date1904) ?? plainNumberText(value);
  return plainNumberText(value);
}

interface CellState {
  row: number;
  column: number;
  type: string;
  style: number;
  /** Text of `<v>` (entities decoded), null when the cell has none. */
  value: string | null;
  /** Text of `<is>`, null when the cell has none. */
  inline: string | null;
}

/** Text of one cell, "" when it has no value, null when it is longer than a cell can hold. */
function cellText(cell: CellState, context: SheetContext): string | null {
  if (cell.type === 'inlineStr' && cell.inline !== null) return cell.inline;
  const raw = cell.value;
  if (raw === null) return '';

  switch (cell.type) {
    case 's': {
      const trimmed = raw.trim();
      return trimmed === '' ? '' : context.sharedStrings.get(Number(trimmed));
    }
    case 'str':
    case 'inlineStr':
      return normalizeLineBreaks(raw);
    case 'b': {
      const trimmed = raw.trim().toLowerCase();
      if (trimmed === '') return '';
      return trimmed === '1' || trimmed === 'true' ? 'TRUE' : 'FALSE';
    }
    case 'e':
      return '';
    case 'd':
      return isoDateText(raw);
    default:
      return numberText(raw, cell.column, context.dateStyles[cell.style] === true, context.date1904);
  }
}

// ---------------------------------------------------------------------------
// Sheets
// ---------------------------------------------------------------------------

/** 1 -> "A", 28 -> "AB". */
function columnName(column: number): string {
  let name = '';
  for (let n = column; n > 0; n = Math.floor((n - 1) / 26)) name = String.fromCharCode(65 + ((n - 1) % 26)) + name;
  return name;
}

function columnNumber(letters: string): number {
  let column = 0;
  for (const letter of letters.toUpperCase()) column = column * 26 + (letter.charCodeAt(0) - 64);
  return column;
}

/** Column of a cell reference ("AB12" -> 28), or null when it has none. */
function columnOfReference(reference: string | undefined): number | null {
  const match = /^\$?([A-Za-z]{1,3})/.exec(reference?.trim() ?? '');
  return match ? columnNumber(match[1] ?? '') : null;
}

function parseCellReference(text: string | undefined): { row: number; column: number } | null {
  const match = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(text?.trim() ?? '');
  if (!match) return null;
  const row = Number(match[2]);
  return row >= 1 ? { row, column: columnNumber(match[1] ?? '') } : null;
}

interface MergedRange {
  top: number;
  left: number;
  bottom: number;
  right: number;
}

function parseMergedRange(ref: string | undefined): MergedRange | null {
  const [first, second] = (ref ?? '').split(':');
  const start = parseCellReference(first);
  const end = parseCellReference(second ?? first);
  if (!start || !end) return null;
  return {
    top: Math.min(start.row, end.row),
    left: Math.min(start.column, end.column),
    bottom: Math.max(start.row, end.row),
    right: Math.max(start.column, end.column),
  };
}

/** Characters left for the cells of the workbook, shared by its sheets. */
interface TextBudget {
  remaining: number;
}

function cellTooLong(sheetName: string, cell: CellState): BadRequestError {
  return new BadRequestError(
    `Cell ${columnName(cell.column)}${cell.row} of sheet "${sheetName}" has more than ${MAX_CELL_TEXT.toLocaleString('en-US')} characters.`,
  );
}

function tooMuchText(limit: number): BadRequestError {
  return new BadRequestError(
    `The workbook has more text than the importer reads (limit ${limit.toLocaleString('en-US')} characters); remove the tabs it does not need.`,
  );
}

/**
 * Blanks every cell of a merged range but its top-left one. Ranges of a valid sheet never overlap, so together they
 * cover at most maxRows x maxColumns cells of the read area; more than that means overlapping ranges.
 */
function blankMergedCells(rows: Array<Array<string | undefined> | undefined>, merges: MergedRange[], part: string, limits: WorkbookLimits): void {
  let budget = limits.maxRows * limits.maxColumns;
  for (const { top, left, bottom, right } of merges) {
    const lastRow = Math.min(bottom, limits.maxRows);
    const lastColumn = Math.min(right, limits.maxColumns);
    for (let row = top; row <= lastRow; row++) {
      const cells = rows[row - 1];
      for (let column = left; column <= lastColumn; column++) {
        if (row === top && column === left) continue;
        budget -= 1;
        if (budget < 0) throw damagedPart(part);
        if (cells && column - 1 < cells.length) cells[column - 1] = undefined;
      }
    }
  }
}

function readSheetGrid(
  xml: string,
  part: string,
  sheetName: string,
  context: SheetContext,
  limits: WorkbookLimits,
  budget: TextBudget,
): { grid: Grid; truncated: boolean } {
  const rows: Array<Array<string | undefined> | undefined> = [];
  const merges: MergedRange[] = [];
  let mergeCount = 0;
  let truncated = false;

  const scanner = new XmlScanner(xml, part);
  let inSheetData = false;
  let sheetDataSeen = false;
  let rowNumber = 0;
  let column = 0;
  let cell: CellState | null = null;
  let inValue = false;
  let inInline = false;
  let inText = false;
  let phonetic = 0;
  let collected = '';

  const placeCell = (current: CellState): void => {
    const outside = current.row > limits.maxRows || current.column > limits.maxColumns;
    if (outside && truncated) return;
    const text = cellText(current, context);
    if (text === null || text.length > MAX_CELL_TEXT) throw cellTooLong(sheetName, current);
    if (text === '') return;
    if (outside) {
      truncated = true;
      return;
    }
    budget.remaining -= text.length;
    if (budget.remaining < 0) throw tooMuchText(limits.maxCharacters);
    (rows[current.row - 1] ??= [])[current.column - 1] = text;
  };

  while (scanner.next()) {
    // Text before this token belongs to the value or inline text being read.
    const collecting = inValue || (inInline && inText && phonetic === 0);
    if (collecting) {
      if (scanner.textStart < scanner.start) collected += unescapeText(scanner.text());
      if (scanner.kind === 'cdata') collected += scanner.cdata();
      if (collected.length > 2 * MAX_CELL_TEXT && cell) throw cellTooLong(sheetName, cell);
    }
    const kind = scanner.kind;
    if (kind === 'cdata' || kind === 'other') continue;

    if (scanner.is('sheetData')) {
      if (kind === 'open') {
        if (sheetDataSeen) throw damagedPart(part);
        inSheetData = true;
        sheetDataSeen = true;
      } else if (kind === 'close') {
        if (!inSheetData || cell) throw damagedPart(part);
        inSheetData = false;
      }
      continue;
    }

    if (inSheetData) {
      if (scanner.is('row')) {
        if (kind === 'close') continue;
        if (cell) throw damagedPart(part);
        // A row without `r` is the next row.
        const declared = Number(scanner.attributes(R_ATTRIBUTE)[0]);
        rowNumber = Number.isInteger(declared) && declared > 0 ? declared : rowNumber + 1;
        column = 0;
        continue;
      }
      if (scanner.is('c')) {
        if (kind === 'close') {
          if (!cell || inValue || inInline) throw damagedPart(part);
          placeCell(cell);
          cell = null;
          continue;
        }
        if (cell) throw damagedPart(part);
        // A cell without `r` takes the next column of its row.
        if (kind === 'empty') {
          column = columnOfReference(scanner.attributes(R_ATTRIBUTE)[0]) ?? column + 1;
          continue;
        }
        const [reference, type, style] = scanner.attributes(CELL_ATTRIBUTES);
        column = columnOfReference(reference) ?? column + 1;
        cell = { row: Math.max(rowNumber, 1), column, type: type ?? 'n', style: Number(style ?? 0), value: null, inline: null };
        continue;
      }
      if (!cell) continue;
      if (scanner.is('v')) {
        if (kind === 'open') {
          if (inValue || inInline) throw damagedPart(part);
          inValue = true;
          collected = '';
        } else if (kind === 'close') {
          if (!inValue) throw damagedPart(part);
          inValue = false;
          cell.value = collected;
          collected = '';
        } else {
          cell.value = '';
        }
      } else if (scanner.is('is')) {
        if (kind === 'open') {
          if (inInline || inValue) throw damagedPart(part);
          inInline = true;
          collected = '';
        } else if (kind === 'close') {
          if (!inInline || inText) throw damagedPart(part);
          inInline = false;
          phonetic = 0;
          cell.inline = normalizeLineBreaks(collected);
          collected = '';
        } else {
          cell.inline = '';
        }
      } else if (inInline && scanner.is('t')) {
        if (kind === 'open') {
          if (inText) throw damagedPart(part);
          inText = true;
        } else if (kind === 'close') {
          if (!inText) throw damagedPart(part);
          inText = false;
        }
      } else if (inInline && scanner.is('rPh')) {
        if (kind === 'open') phonetic += 1;
        else if (kind === 'close') phonetic = Math.max(0, phonetic - 1);
      }
      continue;
    }

    if (kind !== 'close' && scanner.is('mergeCell')) {
      if (++mergeCount > MAX_MERGED_RANGES) throw tooMany('merged ranges in one sheet', MAX_MERGED_RANGES);
      const range = parseMergedRange(scanner.attributes(REF_ATTRIBUTE)[0]);
      if (range && range.top <= limits.maxRows && range.left <= limits.maxColumns) merges.push(range);
    }
  }
  if (inSheetData || cell) throw damagedPart(part);

  blankMergedCells(rows, merges, part, limits);
  const grid: Grid = [];
  for (const cells of rows) {
    let last = -1;
    if (cells) for (let index = 0; index < cells.length; index++) if (cells[index]) last = index;
    const row: string[] = [];
    for (let index = 0; index <= last; index++) row.push(cells?.[index] ?? '');
    grid.push(row);
  }
  while (grid.length > 0 && grid[grid.length - 1]!.length === 0) grid.pop();
  return { grid, truncated };
}

function readSheets(zip: ZipArchive, limits: WorkbookLimits): WorkbookSheet[] {
  const workbookPart = workbookPartName(zip);
  const workbookXml = readXml(zip, workbookPart);
  if (workbookXml === null) throw notAWorkbook('no workbook part');
  const { entries, date1904 } = readWorkbookPart(workbookXml, workbookPart, limits.maxSheets);

  const folder = folderOf(workbookPart);
  const relationshipsPart = relationshipsPartOf(workbookPart);
  const relationships = parseRelationships(readXml(zip, relationshipsPart) ?? '', relationshipsPart, folder);
  const partOfType = (typeSuffix: string, fallback: string): string =>
    [...relationships.values()].find((relationship) => relationship.type.endsWith(typeSuffix))?.target ??
    resolvePartName(folder, fallback);

  const sharedStringsPart = partOfType('/sharedStrings', 'sharedStrings.xml');
  const stylesPart = partOfType('/styles', 'styles.xml');
  const context: SheetContext = {
    sharedStrings: readSharedStrings(readXml(zip, sharedStringsPart) ?? '', sharedStringsPart),
    dateStyles: readDateStyles(readXml(zip, stylesPart) ?? '', stylesPart),
    date1904,
  };

  const budget: TextBudget = { remaining: limits.maxCharacters };
  return entries.map((entry) => {
    const target = entry.relationshipId ? relationships.get(entry.relationshipId)?.target : undefined;
    const xml = target ? readXml(zip, target) : null;
    if (target === undefined || xml === null) throw unreadableWorkbook();
    return { name: entry.name, hidden: entry.hidden, ...readSheetGrid(xml, target, entry.name, context, limits, budget) };
  });
}

function resolveLimits(overrides: Partial<WorkbookLimits>): WorkbookLimits {
  const limits: WorkbookLimits = { ...DEFAULT_WORKBOOK_LIMITS };
  for (const key of Object.keys(limits) as Array<keyof WorkbookLimits>) {
    const value = overrides[key];
    if (value !== undefined) limits[key] = value;
  }
  return limits;
}

/**
 * Every tab of the workbook, in tab order, as a grid of text (see the module comment for the rules).
 * Nothing is evaluated: the cached values are what the workbook shows.
 * @throws BadRequestError when the buffer is not an .xlsx workbook, is damaged, or breaks a limit.
 */
export async function readWorkbookSheets(
  buffer: Buffer,
  limits: Partial<WorkbookLimits> = {},
): Promise<WorkbookSheet[]> {
  const effective = resolveLimits(limits);
  const zip = openZip(buffer, effective);
  try {
    return readSheets(zip, effective);
  } catch (error) {
    if (error instanceof AppError) throw error;
    throw unreadableWorkbook();
  }
}
