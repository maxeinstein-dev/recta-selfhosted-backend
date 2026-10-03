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
const SKIP_REASON_NEGATIVE = 'valor negativo';

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

function normalizeCell(text: string): string {
  return stripAccents(text.trim().toLowerCase());
}

function round2(value: number): number {
  return Math.round((value + Number.EPSILON) * 100) / 100;
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

/**
 * "FINANÇAS_MAX_2026.xlsx - OUT.csv" -> { year: 2026, month: 10 }. Needs a
 * standalone month token (abbreviation or full name) and a 4-digit year.
 */
export function detectMonthFromFilename(filename: string): MaxFinMonth | null {
  const normalized = stripAccents(filename.toLowerCase());
  const yearMatch = YEAR_REGEX.exec(normalized);
  if (!yearMatch) return null;
  const year = Number(yearMatch[1]);

  for (const token of normalized.match(/[a-z]+/g) ?? []) {
    const byAbbreviation = (MONTH_ABBREVIATIONS as readonly string[]).indexOf(token);
    if (byAbbreviation >= 0) return { year, month: byAbbreviation + 1 };
    const byName = monthFromName(token);
    if (byName > 0) return { year, month: byName };
  }
  return null;
}

function resolveMonth(
  grid: Grid,
  headerIndex: number,
  options: MaxFinParseOptions,
): Pick<MaxFinParseResult, 'month' | 'monthSource'> {
  if (options.monthOverride) {
    const { year, month } = options.monthOverride;
    return { month: { year, month }, monthSource: 'override' };
  }

  const limit = headerIndex >= 0 ? headerIndex : Math.min(grid.length, TITLE_SCAN_LIMIT);
  for (let index = 0; index < limit; index++) {
    for (const cell of grid[index] ?? []) {
      const month = detectMonthFromTitle(cell);
      if (month) return { month, monthSource: 'title' };
    }
  }

  if (options.filename) {
    const month = detectMonthFromFilename(options.filename);
    if (month) return { month, monthSource: 'filename' };
  }
  return { month: null, monthSource: 'none' };
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
    const sum = round2(sectionRows.reduce((acc, row) => acc + row.amount, 0));
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
function isTotalRow(normalizedDescription: string): boolean {
  return /^total\s*:?$/.test(normalizedDescription);
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

  const headerIndex = grid.findIndex((row) => normalizeCell(row[1] ?? '') === 'descricao');
  const { month, monthSource } = resolveMonth(grid, headerIndex, options);
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
    const normalizedDescription = normalizeCell(cells.description);

    if (isTotalRow(normalizedDescription)) {
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
    if (normalizedDescription === 'mes anterior') {
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
    const amount = hasRealized ? realized : planned;

    if (amount === null || amount === 0) {
      skipped.push({ sourceLine, description: cells.description, reason: SKIP_REASON_ZERO });
      continue;
    }
    if (amount < 0) {
      skipped.push({ sourceLine, description: cells.description, reason: SKIP_REASON_NEGATIVE });
      continue;
    }

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
    const rawNote = cells.note.length > 0 ? cells.note : null;
    const notes = [rawNote, ...generatedNotes].filter((note): note is string => Boolean(note));

    rows.push({
      sourceLine,
      section,
      type: isIncome ? 'INCOME' : 'EXPENSE',
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
