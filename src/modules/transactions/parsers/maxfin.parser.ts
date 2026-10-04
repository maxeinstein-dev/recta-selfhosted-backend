/**
 * Parser for the "MaxFin" monthly spreadsheet (one tab per month, exported as
 * CSV and already tokenized into a Grid). Pure functions only: no I/O, no
 * database. See maxfin.types.ts for the layout and the output contract.
 */
import { MAXFIN_SECTION_KEYS, MAXFIN_SECTION_LABELS } from './maxfin.types.js';
import type {
  Grid,
  MaxFinInstallment,
  MaxFinMonth,
  MaxFinParseOptions,
  MaxFinParseResult,
  MaxFinRow,
  MaxFinSectionKey,
  MaxFinSectionSummary,
  MaxFinSkippedRow,
  ShareHint,
} from './maxfin.types.js';

/** Expense blocks in sheet order: the first, second and third "Total" row close them. */
const EXPENSE_SECTIONS: readonly MaxFinSectionKey[] = MAXFIN_SECTION_KEYS.filter((key) => key !== 'income');
const EXPECTED_TOTAL_ROWS = 3;
/** Rows scanned for the title when the header row is missing. */
const TITLE_SCAN_LIMIT = 10;
/**
 * Longest cell that can still be a keyword ("Descrição", "Total", "Mês anterior") or a title: longer cells are never
 * normalized, so a long text repeated down a column (a workbook cell holds up to 50,000 characters) stays cheap.
 */
const MAX_KEYWORD_CELL = 64;
const MAX_TITLE_CELL = 1_000;
/** Tolerance when comparing the accepted sum with the sheet "Total". */
const SUM_TOLERANCE = 0.05;
/** Longest values the confirm endpoint accepts; longer cells are cut here so one long row cannot reject the whole batch. */
const MAX_DESCRIPTION_LENGTH = 255;
const MAX_NOTES_LENGTH = 1000;
const MAX_CATEGORY_KEY_LENGTH = 200;
/** `maxfin:<slug>:<total>` must stay within the 120 characters confirm accepts for an installment id. */
const MAX_PLAN_SLUG_LENGTH = 100;

/** Cuts to `max` UTF-16 units without leaving half of a surrogate pair at the end. */
export function clampText(value: string, max: number): string {
  if (value.length <= max) return value;
  const cut = value.slice(0, max);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/** Accent-free Portuguese month names, index = month - 1. */
const MONTH_NAMES = [
  'janeiro',
  'fevereiro',
  'marco',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;
const MONTH_ABBREVIATIONS = [
  'jan',
  'fev',
  'mar',
  'abr',
  'mai',
  'jun',
  'jul',
  'ago',
  'set',
  'out',
  'nov',
  'dez',
] as const;

const MONTH_NAME_GROUP = `(${MONTH_NAMES.join('|')})`;
/** "mês de outubro de 2026" (text is lowercased and accent-stripped before matching). */
const TITLE_STRICT_REGEX = new RegExp(`mes\\s+de\\s+${MONTH_NAME_GROUP}\\s+de\\s+(\\d{4})`);
/** Lenient fallback: "outubro de 2026", "outubro/2026", "outubro 2026". */
const TITLE_LENIENT_REGEX = new RegExp(
  `(?<![a-z])${MONTH_NAME_GROUP}(?![a-z])\\s*(?:de\\s+|[/-]\\s*)?(\\d{4})(?!\\d)`,
);
const YEAR_REGEX = /(?<!\d)(\d{4})(?!\d)/;

/** "N/M", "N/M +K", "N/M + K"; digit guards keep "123/4567" from matching. */
const INSTALLMENT_REGEX = /(?<!\d)(\d{1,2})\s*\/\s*(\d{1,2})(?:\s*\+\s*(\d{1,2}))?(?!\d)/;

const SPLIT_REGEX = /^\*\s*dividir\s+com\s+(.+)$/i;
const REIMBURSABLE_REGEX = /^\*\s*reembolsar$/i;
const OWED_TO_ME_REGEX = /^\*\s*(.+)$/i;
const OWED_BY_ME_REGEX = /^pagar\s+[aà]\s+(.+)$/i;

const SKIP_REASON_CARRY_OVER = 'Mês anterior';
const SKIP_REASON_NO_VALUE = 'sem valor';
const SKIP_REASON_ZERO = 'valor zero';
/** Generated notes of a row whose value is negative in the sheet (its type is flipped). */
const NOTE_NEGATIVE_AS_CREDIT = 'valor negativo na planilha: lançado como crédito';
const NOTE_NEGATIVE_AS_DEBIT = 'valor negativo na planilha: lançado como débito';

interface SheetTotals {
  planned: number | null;
  realized: number | null;
}

/** Trimmed cells of one grid row, by meaning (F "À receber" and I "Saldo" are not used). */
interface RowCells {
  flag: string;
  description: string;
  category: string;
  incomePlanned: string;
  incomeRealized: string;
  expensePlanned: string;
  expenseRealized: string;
  note: string;
}

interface InstallmentMatch {
  installment: MaxFinInstallment | null;
  /** True when an "N/M" fragment exists but fails validation. */
  invalid: boolean;
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/[̀-ͯ]/g, '');
}

/** Normalized cell when it is short enough to be a keyword, otherwise null (it is none). */
function keywordOf(text: string): string | null {
  const trimmed = text.trim();
  return trimmed.length <= MAX_KEYWORD_CELL ? normalizeCell(trimmed) : null;
}

function normalizeCell(text: string): string {
  return stripAccents(text.trim().toLowerCase());
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

/** Type of the rows of a block when the sheet value is positive. */
function blockTypeOf(section: MaxFinSectionKey): MaxFinRow['type'] {
  return section === 'income' ? 'INCOME' : 'EXPENSE';
}

function oppositeType(type: MaxFinRow['type']): MaxFinRow['type'] {
  return type === 'INCOME' ? 'EXPENSE' : 'INCOME';
}

/** 5000 -> "R$ 5.000,00"; -156 -> "-R$ 156,00". */
function formatMoneyBR(value: number): string {
  const [integer = '0', decimals = '00'] = Math.abs(value).toFixed(2).split('.');
  const grouped = integer.replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  return `${value < 0 ? '-' : ''}R$ ${grouped},${decimals}`;
}

function readCells(row: string[]): RowCells {
  const at = (index: number): string => (row[index] ?? '').trim();
  return {
    flag: at(0),
    description: at(1),
    category: at(2),
    incomePlanned: at(3),
    incomeRealized: at(4),
    expensePlanned: at(6),
    expenseRealized: at(7),
    note: at(9),
  };
}

export function slugify(text: string): string {
  return stripAccents(text.toLowerCase())
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
}

/**
 * Parses "R$ 1.300,00", "-R$ 156,00", "R$ 0,00" and, defensively, "1.234,56",
 * "1234,56" and "1234.56". Empty or non-numeric cells yield null.
 */
export function parseMoneyBR(raw: string): number | null {
  let value = raw.replace(/[\s  ]/g, '');
  if (value.length === 0) return null;

  let negative = false;
  if (value.startsWith('(') && value.endsWith(')')) {
    negative = true;
    value = value.slice(1, -1);
  }
  value = value.replace(/R\$/gi, '');
  if (value.startsWith('-')) {
    negative = !negative;
    value = value.slice(1);
  } else if (value.startsWith('+')) {
    value = value.slice(1);
  }
  if (!/^\d[\d.,]*$/.test(value)) return null;

  let normalized: string;
  if (value.includes(',')) {
    // Brazilian format: '.' groups thousands, ',' is the decimal mark.
    normalized = value.replace(/\./g, '').replace(',', '.');
  } else if (/^\d{1,3}(\.\d{3})+$/.test(value)) {
    // Dots only, in groups of three: thousands grouping ("1.300").
    normalized = value.replace(/\./g, '');
  } else {
    normalized = value;
  }

  const parsed = Number(normalized);
  if (!Number.isFinite(parsed)) return null;
  return negative ? -parsed : parsed;
}

function matchInstallment(description: string): InstallmentMatch {
  const match = INSTALLMENT_REGEX.exec(description);
  if (!match) return { installment: null, invalid: false };

  const number = Number(match[1]);
  const total = Number(match[2]);
  const prepaid = match[3] === undefined ? 0 : Number(match[3]);
  if (number < 1 || number > total || number + prepaid > total) {
    return { installment: null, invalid: true };
  }

  const baseDescription = clampText(
    (description.slice(0, match.index) + ' ' + description.slice(match.index + match[0].length))
      .replace(/\s+/g, ' ')
      .trim(),
    MAX_DESCRIPTION_LENGTH,
  );

  return {
    installment: {
      number,
      total,
      prepaid,
      baseDescription,
      installmentId: `maxfin:${slugify(baseDescription).slice(0, MAX_PLAN_SLUG_LENGTH)}:${total}`,
      futureCount: total - (number + prepaid),
    },
    invalid: false,
  };
}

/** "Curso B 5/12 +7" -> { number: 5, total: 12, prepaid: 7, ... }; null when absent or invalid. */
export function parseInstallment(description: string): MaxFinInstallment | null {
  return matchInstallment(description).installment;
}

export function parseShareHint(note: string | null | undefined): ShareHint | null {
  const value = (note ?? '').trim();
  if (value.length === 0) return null;

  let match: RegExpExecArray | null;
  if ((match = SPLIT_REGEX.exec(value))) {
    return { kind: 'split', person: (match[1] ?? '').trim(), percent: 50 };
  }
  if (REIMBURSABLE_REGEX.test(value)) {
    return { kind: 'reimbursable', person: null, percent: 100 };
  }
  if ((match = OWED_TO_ME_REGEX.exec(value))) {
    return { kind: 'owed_to_me', person: (match[1] ?? '').trim(), percent: 100 };
  }
  if ((match = OWED_BY_ME_REGEX.exec(value))) {
    return { kind: 'owed_by_me', person: (match[1] ?? '').trim() };
  }
  return null;
}

function monthFromName(name: string): number {
  return (MONTH_NAMES as readonly string[]).indexOf(name) + 1;
}

/** "Finanças X\nMês de outubro de 2026" -> { year: 2026, month: 10 }, accent/case-insensitive. */
export function detectMonthFromTitle(text: string): MaxFinMonth | null {
  const normalized = stripAccents(text.toLowerCase());
  const match = TITLE_STRICT_REGEX.exec(normalized) ?? TITLE_LENIENT_REGEX.exec(normalized);
  if (!match) return null;
  return { year: Number(match[2]), month: monthFromName(match[1] ?? '') };
}

/** First standalone month token (abbreviation or full name), accent/case-insensitive: "OUT" -> 10. */
function monthTokenOf(name: string): number | null {
  for (const token of stripAccents(name.toLowerCase()).match(/[a-z]+/g) ?? []) {
    const byAbbreviation = (MONTH_ABBREVIATIONS as readonly string[]).indexOf(token);
    if (byAbbreviation >= 0) return byAbbreviation + 1;
    const byName = monthFromName(token);
    if (byName > 0) return byName;
  }
  return null;
}

/** First standalone 4-digit number of a name: "FINANÇAS_2026.xlsx" -> 2026. */
export function detectYearFromName(name: string): number | null {
  const match = YEAR_REGEX.exec(name);
  return match ? Number(match[1]) : null;
}

/**
 * "FINANÇAS_2026.xlsx - OUT.csv" -> { year: 2026, month: 10 }. Needs a
 * standalone month token (abbreviation or full name) and a 4-digit year.
 */
export function detectMonthFromFilename(filename: string): MaxFinMonth | null {
  const year = detectYearFromName(filename);
  if (year === null) return null;
  const month = monthTokenOf(filename);
  return month === null ? null : { year, month };
}

/**
 * Splits a file named like Google Sheets' download of one tab, "<workbook> - <tab>.csv", at the last " - "
 * ("FINANÇAS_2026.xlsx - OUT.csv" -> "FINANÇAS_2026.xlsx" and "OUT"). Null for any other name. No regex: the
 * name comes from the upload (part headers reach 80 KB) and a backtracking pattern was quadratic on it.
 */
function splitCsvDownloadName(filename: string): { workbook: string; tab: string } | null {
  if (filename.length < 4 || filename.slice(-4).toLowerCase() !== '.csv') return null;
  const body = filename.slice(0, -4);
  const cut = body.lastIndexOf(' - ');
  if (cut < 0) return null;
  const tab = body.slice(cut + 3).trim();
  return tab ? { workbook: body.slice(0, cut), tab } : null;
}

/** Tab name of a "<workbook> - <tab>.csv" download ("FINANÇAS_2026.xlsx - OUT.csv" -> "OUT"), null otherwise. */
export function sheetNameFromCsvFilename(filename: string): string | null {
  return splitCsvDownloadName(filename)?.tab ?? null;
}

/** Accented month names for messages, index = month - 1. */
const MONTH_LABELS = [
  'janeiro',
  'fevereiro',
  'março',
  'abril',
  'maio',
  'junho',
  'julho',
  'agosto',
  'setembro',
  'outubro',
  'novembro',
  'dezembro',
] as const;

export function monthLabel({ year, month }: MaxFinMonth): string {
  return `${MONTH_LABELS[month - 1] ?? month}/${year}`;
}

const YEAR_FROM_TAB_NAME = 'ano do nome da aba';
const YEAR_FROM_FILE_NAME = 'ano do nome do arquivo';
const YEAR_FROM_TITLE = 'ano do título';
const YEAR_AFTER_TITLE = 'ano seguinte ao do título: a aba é uma cópia feita depois dele';
const YEAR_FROM_OTHER_TABS = 'ano das outras abas';

/**
 * Year of a month read from the tab name, and why. When the title names the same month: the tab name's year,
 * else the title's. When the title names another month (a tab copied from another one): the tab name's year,
 * else the file name's (for a "<workbook> - <tab>.csv" download, its workbook part), else the title's, moved to
 * the next year when the tab month is earlier (a copy is made after its source: DEZ copied to JAN). Without a
 * title month: the tab name's year, else the file name's, else `fallbackYear`.
 */
function sheetYear(
  options: MaxFinParseOptions,
  sheetName: string,
  sheetMonth: number,
  titleMonth: MaxFinMonth | null,
): { year: number; reason: string } | null {
  const nameYear = detectYearFromName(sheetName);
  if (nameYear !== null) return { year: nameYear, reason: YEAR_FROM_TAB_NAME };
  if (titleMonth && titleMonth.month === sheetMonth) return { year: titleMonth.year, reason: YEAR_FROM_TITLE };
  const fileYear =
    options.fileYear ??
    (options.filename ? detectYearFromName(splitCsvDownloadName(options.filename)?.workbook ?? options.filename) : null);
  if (fileYear !== null) return { year: fileYear, reason: YEAR_FROM_FILE_NAME };
  if (titleMonth) {
    return sheetMonth < titleMonth.month
      ? { year: titleMonth.year + 1, reason: YEAR_AFTER_TITLE }
      : { year: titleMonth.year, reason: YEAR_FROM_TITLE };
  }
  return options.fallbackYear === undefined ? null : { year: options.fallbackYear, reason: YEAR_FROM_OTHER_TABS };
}

function findTitleMonth(grid: Grid, headerIndex: number): MaxFinMonth | null {
  const limit = headerIndex >= 0 ? headerIndex : Math.min(grid.length, TITLE_SCAN_LIMIT);
  for (let index = 0; index < limit; index++) {
    for (const cell of grid[index] ?? []) {
      if (cell.length > MAX_TITLE_CELL) continue;
      const month = detectMonthFromTitle(cell);
      if (month) return month;
    }
  }
  return null;
}

/**
 * Order: monthOverride > month token of the tab name > title > file name. The tab name only gives the month;
 * sheetYear picks its year. A title that names another month (a tab copied from another one) loses to the tab
 * name, with a warning that says which year was used and why.
 */
function resolveMonth(
  grid: Grid,
  headerIndex: number,
  options: MaxFinParseOptions,
): Pick<MaxFinParseResult, 'month' | 'monthSource'> & { warning: string | null } {
  if (options.monthOverride) {
    const { year, month } = options.monthOverride;
    return { month: { year, month }, monthSource: 'override', warning: null };
  }

  const titleMonth = findTitleMonth(grid, headerIndex);
  const sheetMonthNumber = options.sheetName === undefined ? null : monthTokenOf(options.sheetName);
  if (options.sheetName !== undefined && sheetMonthNumber !== null) {
    const choice = sheetYear(options, options.sheetName, sheetMonthNumber, titleMonth);
    if (choice) {
      const sheetMonth: MaxFinMonth = { year: choice.year, month: sheetMonthNumber };
      if (titleMonth && titleMonth.year === choice.year && titleMonth.month === sheetMonthNumber) {
        return { month: titleMonth, monthSource: 'title', warning: null };
      }
      const warning = titleMonth
        ? `O título da aba diz ${monthLabel(titleMonth)}, mas a aba se chama "${options.sheetName}": usei ${monthLabel(sheetMonth)} (${choice.reason}).`
        : null;
      return { month: sheetMonth, monthSource: 'sheet', warning };
    }
  }

  if (titleMonth) return { month: titleMonth, monthSource: 'title', warning: null };

  if (options.filename) {
    const month = detectMonthFromFilename(options.filename);
    if (month) return { month, monthSource: 'filename', warning: null };
  }
  return { month: null, monthSource: 'none', warning: null };
}

function describePrepaid({ number, prepaid }: MaxFinInstallment): string {
  const first = number + 1;
  if (prepaid === 1) return `antecipou 1 parcela (${first})`;
  return `antecipou ${prepaid} parcelas (${first}..${number + prepaid})`;
}

function buildSections(
  rows: MaxFinRow[],
  sheetTotals: Record<MaxFinSectionKey, SheetTotals>,
  warnings: string[],
): MaxFinSectionSummary[] {
  return MAXFIN_SECTION_KEYS.map((key) => {
    const sectionRows = rows.filter((row) => row.section === key);
    // Net of the block, like the sheet Total: rows of the opposite type (negative values) count against it.
    const blockType = blockTypeOf(key);
    const sum = round2(sectionRows.reduce((acc, row) => acc + (row.type === blockType ? row.amount : -row.amount), 0));
    const { planned, realized } = sheetTotals[key];
    const label = MAXFIN_SECTION_LABELS[key];

    if (key !== 'income' && planned !== null && Math.abs(sum - planned) > SUM_TOLERANCE) {
      warnings.push(
        `${label}: soma das linhas aceitas (${formatMoneyBR(sum)}) difere do Total previsto da planilha (${formatMoneyBR(planned)}).`,
      );
    }

    return {
      key,
      label,
      count: sectionRows.length,
      sum,
      sheetTotalPlanned: planned,
      sheetTotalRealized: realized,
    };
  });
}

/**
 * A "Total" row closes a block. The whole cell is the word (optionally followed by ":"), so an expense called
 * "TotalPass" or "Total Pass" is a row, not a block delimiter, whatever its category cell holds.
 */
function isTotalRow(keyword: string | null): boolean {
  return keyword !== null && /^total\s*:?$/.test(keyword);
}

/** Index of the header row (column B reads "Descrição", whatever the case, accents and spaces), or -1. */
export function findMaxFinHeaderIndex(grid: Grid): number {
  return grid.findIndex((row) => keywordOf(row[1] ?? '') === 'descricao');
}

export function parseMaxFinGrid(
  grid: Grid,
  options: MaxFinParseOptions = {},
): MaxFinParseResult {
  const warnings: string[] = [];
  const rows: MaxFinRow[] = [];
  const skipped: MaxFinSkippedRow[] = [];
  const sheetTotals: Record<MaxFinSectionKey, SheetTotals> = {
    income: { planned: null, realized: null },
    bills: { planned: null, realized: null },
    credit: { planned: null, realized: null },
    debit: { planned: null, realized: null },
  };

  const headerIndex = findMaxFinHeaderIndex(grid);
  const { month, monthSource, warning } = resolveMonth(grid, headerIndex, options);
  if (warning) warnings.push(warning);
  if (!month) {
    warnings.push('Não foi possível identificar o mês da planilha; informe o mês manualmente.');
  }
  if (headerIndex < 0) {
    warnings.push('Linha de cabeçalho (coluna "Descrição") não encontrada; nenhuma linha importada.');
    return { month, monthSource, rows, skipped, sections: buildSections(rows, sheetTotals, warnings), warnings };
  }

  const monthKey = month ? `${month.year}-${String(month.month).padStart(2, '0')}` : 'unknown';
  // Without a month the rows are still produced (the service asks the user
  // for it and re-dates them); 1970-01-01 is only a placeholder.
  const rowDate = (): Date => (month ? new Date(month.year, month.month - 1, 1) : new Date(1970, 0, 1));

  let totalsSeen = 0;
  for (let index = headerIndex + 1; index < grid.length; index++) {
    const sourceLine = index + 1;
    const cells = readCells(grid[index] ?? []);
    const keyword = keywordOf(cells.description);

    if (isTotalRow(keyword)) {
      const totalSection = EXPENSE_SECTIONS[totalsSeen];
      if (totalSection) {
        sheetTotals[totalSection] = {
          planned: parseMoneyBR(cells.expensePlanned),
          realized: parseMoneyBR(cells.expenseRealized),
        };
      }
      totalsSeen += 1;
      // Everything after the third "Total" is the footer (grand totals, account balances).
      if (totalsSeen >= EXPECTED_TOTAL_ROWS) break;
      continue;
    }

    if (cells.description.length === 0) continue;
    if (keyword === 'mes anterior') {
      skipped.push({ sourceLine, description: cells.description, reason: SKIP_REASON_CARRY_OVER });
      continue;
    }

    // A cell counts only when it holds an amount: placeholders such as "R$ -" do not make a row income or expense.
    const isIncome = parseMoneyBR(cells.incomePlanned) !== null || parseMoneyBR(cells.incomeRealized) !== null;
    const isExpense = parseMoneyBR(cells.expensePlanned) !== null || parseMoneyBR(cells.expenseRealized) !== null;
    if (!isIncome && !isExpense) {
      skipped.push({ sourceLine, description: cells.description, reason: SKIP_REASON_NO_VALUE });
      continue;
    }
    if (isIncome && isExpense) {
      warnings.push(
        `Linha ${sourceLine} ("${cells.description}") tem valores de entrada e saída; tratada como entrada.`,
      );
    }

    const section: MaxFinSectionKey = isIncome
      ? 'income'
      : (EXPENSE_SECTIONS[totalsSeen] ?? 'debit');
    const planned = parseMoneyBR(isIncome ? cells.incomePlanned : cells.expensePlanned);
    const realized = parseMoneyBR(isIncome ? cells.incomeRealized : cells.expenseRealized);
    const hasRealized = realized !== null && realized !== 0;
    const value = hasRealized ? realized : planned;

    if (value === null || value === 0) {
      skipped.push({ sourceLine, description: cells.description, reason: SKIP_REASON_ZERO });
      continue;
    }
    // A negative value stays in its block (so on the same account) with the opposite type: a refund or
    // reversal in an expense block is a credit, a negative entry in the income block is a debit.
    const negative = value < 0;
    const blockType = blockTypeOf(section);
    const type = negative ? oppositeType(blockType) : blockType;
    const amount = Math.abs(value);

    const { installment, invalid } = matchInstallment(cells.description);
    if (invalid) {
      warnings.push(`Linha ${sourceLine} ("${cells.description}"): parcela inválida ignorada.`);
    }

    const generatedNotes: string[] = [];
    if (hasRealized && planned !== null && realized !== planned) {
      generatedNotes.push(`previsto ${formatMoneyBR(planned)}`);
    }
    if (installment && installment.prepaid > 0) {
      generatedNotes.push(describePrepaid(installment));
    }
    if (negative) {
      generatedNotes.push(type === 'INCOME' ? NOTE_NEGATIVE_AS_CREDIT : NOTE_NEGATIVE_AS_DEBIT);
    }
    const rawNote = cells.note.length > 0 ? cells.note : null;
    const notes = [rawNote, ...generatedNotes].filter((note): note is string => Boolean(note));

    rows.push({
      sourceLine,
      section,
      type,
      description: clampText(cells.description, MAX_DESCRIPTION_LENGTH),
      categoryKey: clampText(
        cells.category.length > 0 ? cells.category : isIncome ? cells.description : '',
        MAX_CATEGORY_KEY_LENGTH,
      ),
      amount,
      planned,
      realized,
      paid: section === 'credit' ? true : hasRealized,
      date: rowDate(),
      rawNote,
      notes: notes.length > 0 ? clampText(notes.join(' · '), MAX_NOTES_LENGTH) : null,
      flag: cells.flag.length > 0 ? cells.flag : null,
      installment,
      shareHint: parseShareHint(rawNote),
      sourceRef: `maxfin:${monthKey}:${section}:${sourceLine}`,
    });
  }

  if (totalsSeen < EXPECTED_TOTAL_ROWS) {
    warnings.push(
      `Encontradas ${totalsSeen} linhas "Total" (esperadas ${EXPECTED_TOTAL_ROWS}); confira se os blocos e o rodapé foram reconhecidos.`,
    );
  }

  return { month, monthSource, rows, skipped, sections: buildSections(rows, sheetTotals, warnings), warnings };
}
