/**
 * Monthly payroll calculation (CLT): gross to net, net to gross, FGTS. Pure part: no database, no clock, no I/O.
 * Everything is whole cents; rates are basis points. The tables come from `payroll-tables.ts` (versioned by date).
 * Estimate for planning, not a payslip: see the method options for the 1-2 cent differences between payrolls.
 */
import {
  selectFgtsTable,
  selectInssTable,
  selectIrrfTable,
  type FgtsTable,
  type InssTable,
  type IrrfTable,
  type PayrollDay,
  type TableWarningCode,
} from './payroll-tables.js';

export type RoundingMode = 'truncate' | 'round';
/** 'deduction': rate x base minus the band's "parcela a deduzir". 'direct': sum of each band's slice x its rate. */
export type BracketMethod = 'deduction' | 'direct';

export interface PayrollMethod {
  bracket: BracketMethod;
  rounding: RoundingMode;
}

/** The default reproduces the payroll documents the spec was checked against. */
export const DEFAULT_PAYROLL_METHOD: PayrollMethod = { bracket: 'deduction', rounding: 'truncate' };

/** A fixed or one-off line of the payslip. Deductions only subtract from the net; the base flags matter for earnings. */
export interface PayrollItem {
  label: string;
  amountCents: number;
  kind: 'earning' | 'deduction';
  inInssBase: boolean;
  inIrrfBase: boolean;
  inFgtsBase: boolean;
}

export interface PayrollTableSet {
  inss?: readonly InssTable[];
  irrf?: readonly IrrfTable[];
  fgts?: readonly FgtsTable[];
}

export interface PayrollWarning {
  code: TableWarningCode;
  tax: 'inss' | 'irrf' | 'fgts';
  tableId: string;
}

export interface UsedTables {
  inss: string;
  irrf: string;
  fgts: string;
}

export interface MonthlyPayrollInput {
  /** Day that picks the tables ('YYYY-MM-DD'): normally the payment day. */
  date: PayrollDay;
  grossCents: number;
  dependents?: number;
  items?: readonly PayrollItem[];
  /** Days worked out of 30 (commercial month); absent means the full month. The gross is prorated by it. */
  workedDays?: number;
  method?: PayrollMethod;
  tables?: PayrollTableSet;
}

export interface MonthlyPayroll {
  tables: UsedTables;
  warnings: PayrollWarning[];
  method: PayrollMethod;
  /** Salary actually earned in the month (the gross after proration). */
  salaryCents: number;
  extraEarningsCents: number;
  fixedDeductionsCents: number;
  bases: {
    inssCents: number;
    /** Taxable income before INSS and deductions (also the input of the reducer). */
    irrfIncomeCents: number;
    /** What the progressive table is applied to. */
    irrfCents: number;
    fgtsCents: number;
  };
  inssCents: number;
  irrf: {
    deduction: 'legal' | 'simplified';
    deductionCents: number;
    taxBeforeReductionCents: number;
    reductionCents: number;
    taxCents: number;
  };
  irrfCents: number;
  fgtsCents: number;
  netCents: number;
}

function assertCents(name: string, v: number): void {
  if (!Number.isInteger(v)) throw new Error(`${name} must be whole cents.`);
}

/** x / 10000 for an integer numerator, with the chosen rounding (half up). */
function divBp(numerator: number, rounding: RoundingMode): number {
  return rounding === 'truncate' ? Math.floor(numerator / 10000) : Math.floor((numerator + 5000) / 10000);
}

/** cents x rate (bp), rounded. */
export function applyRate(cents: number, rateBp: number, rounding: RoundingMode): number {
  return divBp(cents * rateBp, rounding);
}

/** Progressive INSS over a base already limited by the ceiling. */
export function computeInss(baseCents: number, table: InssTable, method: PayrollMethod = DEFAULT_PAYROLL_METHOD): number {
  assertCents('base', baseCents);
  const base = Math.min(Math.max(baseCents, 0), table.ceilingCents);
  if (base === 0) return 0;
  if (method.bracket === 'deduction') {
    const band = table.bands.find((b) => base <= b.upToCents) ?? table.bands[table.bands.length - 1]!;
    return Math.max(0, applyRate(base, band.rateBp, method.rounding) - band.deductionCents);
  }
  let numerator = 0;
  let lower = 0;
  for (const b of table.bands) {
    if (base <= lower) break;
    numerator += (Math.min(base, b.upToCents) - lower) * b.rateBp;
    lower = b.upToCents;
  }
  return divBp(numerator, method.rounding);
}

/** Progressive IRRF before the reducer, over the base after deductions. */
export function computeProgressiveIrrf(
  baseCents: number,
  table: IrrfTable,
  method: PayrollMethod = DEFAULT_PAYROLL_METHOD,
): number {
  assertCents('base', baseCents);
  if (baseCents <= 0) return 0;
  if (method.bracket === 'deduction') {
    const band = table.bands.find((b) => b.upToCents === null || baseCents <= b.upToCents)!;
    return Math.max(0, applyRate(baseCents, band.rateBp, method.rounding) - band.deductionCents);
  }
  let numerator = 0;
  let lower = 0;
  for (const b of table.bands) {
    if (baseCents <= lower) break;
    const upper = b.upToCents === null ? baseCents : Math.min(baseCents, b.upToCents);
    numerator += (upper - lower) * b.rateBp;
    if (b.upToCents === null) break;
    lower = b.upToCents;
  }
  return divBp(numerator, method.rounding);
}

/** Lei 15.270/2025 reduction for a taxable income (before INSS and deductions); 0 when the table has no reducer. */
export function irrfReduction(incomeCents: number, table: IrrfTable): number {
  const r = table.reducer;
  if (!r || incomeCents <= 0) return 0;
  if (incomeCents <= r.fullUpToCents) return r.maxCents;
  if (incomeCents >= r.endsAtCents) return 0;
  // Always nearest cent, whatever the payroll rounding: the law gives the formula, not a rounding rule.
  const value = r.interceptCents - Math.round((r.coefficientMicro * incomeCents) / 1_000_000);
  return Math.max(0, value);
}

export interface IrrfResult {
  deduction: 'legal' | 'simplified';
  deductionCents: number;
  baseCents: number;
  taxBeforeReductionCents: number;
  reductionCents: number;
  taxCents: number;
}

/** IRRF of an income: picks the more advantageous deduction, applies the table and subtracts the reducer. */
export function computeIrrf(
  incomeCents: number,
  inssCents: number,
  dependents: number,
  table: IrrfTable,
  method: PayrollMethod = DEFAULT_PAYROLL_METHOD,
): IrrfResult {
  if (!Number.isInteger(dependents) || dependents < 0) throw new Error('dependents must be a non-negative integer.');
  const legal = inssCents + dependents * table.dependentDeductionCents;
  const simplified = table.simplifiedDeductionCents;
  const useSimplified = simplified > legal;
  const deductionCents = useSimplified ? simplified : legal;
  const baseCents = Math.max(0, incomeCents - deductionCents);
  const taxBeforeReductionCents = computeProgressiveIrrf(baseCents, table, method);
  const reductionCents = Math.min(taxBeforeReductionCents, irrfReduction(incomeCents, table));
  return {
    deduction: useSimplified ? 'simplified' : 'legal',
    deductionCents,
    baseCents,
    taxBeforeReductionCents,
    reductionCents,
    taxCents: taxBeforeReductionCents - reductionCents,
  };
}

export function computeFgts(baseCents: number, table: FgtsTable, method: PayrollMethod = DEFAULT_PAYROLL_METHOD): number {
  assertCents('base', baseCents);
  return applyRate(Math.max(0, baseCents), table.rateBp, method.rounding);
}

export interface ResolvedTables {
  inss: InssTable;
  irrf: IrrfTable;
  fgts: FgtsTable;
  used: UsedTables;
  warnings: PayrollWarning[];
}

export function resolveTables(date: PayrollDay, set: PayrollTableSet = {}): ResolvedTables {
  const inss = selectInssTable(date, set.inss);
  const irrf = selectIrrfTable(date, set.irrf);
  const fgts = selectFgtsTable(date, set.fgts);
  const warnings: PayrollWarning[] = [];
  if (inss.warning) warnings.push({ code: inss.warning, tax: 'inss', tableId: inss.table.id });
  if (irrf.warning) warnings.push({ code: irrf.warning, tax: 'irrf', tableId: irrf.table.id });
  if (fgts.warning) warnings.push({ code: fgts.warning, tax: 'fgts', tableId: fgts.table.id });
  return {
    inss: inss.table,
    irrf: irrf.table,
    fgts: fgts.table,
    used: { inss: inss.table.id, irrf: irrf.table.id, fgts: fgts.table.id },
    warnings,
  };
}

/** Salary for `workedDays` of a 30-day commercial month. */
export function prorateSalary(grossCents: number, workedDays: number, rounding: RoundingMode): number {
  if (!Number.isInteger(workedDays) || workedDays < 0 || workedDays > 30) throw new Error('workedDays must be 0..30.');
  const exact = grossCents * workedDays;
  return rounding === 'truncate' ? Math.floor(exact / 30) : Math.round(exact / 30);
}

function sumItems(items: readonly PayrollItem[], pick: (i: PayrollItem) => boolean): number {
  return items.filter(pick).reduce((s, i) => s + i.amountCents, 0);
}

/** Gross to net of one month, with the full composition. */
export function computeMonthlyPayroll(input: MonthlyPayrollInput): MonthlyPayroll {
  assertCents('grossCents', input.grossCents);
  if (input.grossCents < 0) throw new Error('grossCents must not be negative.');
  const items = input.items ?? [];
  for (const i of items) {
    assertCents(`item ${i.label}`, i.amountCents);
    if (i.amountCents < 0) throw new Error(`item ${i.label}: use kind "deduction" instead of a negative amount.`);
  }
  const method = input.method ?? DEFAULT_PAYROLL_METHOD;
  const tables = resolveTables(input.date, input.tables);

  const salaryCents =
    input.workedDays === undefined ? input.grossCents : prorateSalary(input.grossCents, input.workedDays, method.rounding);
  const earnings = items.filter((i) => i.kind === 'earning');
  const extraEarningsCents = earnings.reduce((s, i) => s + i.amountCents, 0);
  const fixedDeductionsCents = sumItems(items, (i) => i.kind === 'deduction');

  const inssBaseCents = Math.min(salaryCents + sumItems(earnings, (i) => i.inInssBase), tables.inss.ceilingCents);
  const inssCents = computeInss(inssBaseCents, tables.inss, method);

  const irrfIncomeCents = salaryCents + sumItems(earnings, (i) => i.inIrrfBase);
  const irrf = computeIrrf(irrfIncomeCents, inssCents, input.dependents ?? 0, tables.irrf, method);

  const fgtsBaseCents = salaryCents + sumItems(earnings, (i) => i.inFgtsBase);
  const fgtsCents = computeFgts(fgtsBaseCents, tables.fgts, method);

  return {
    tables: tables.used,
    warnings: tables.warnings,
    method,
    salaryCents,
    extraEarningsCents,
    fixedDeductionsCents,
    bases: { inssCents: inssBaseCents, irrfIncomeCents, irrfCents: irrf.baseCents, fgtsCents: fgtsBaseCents },
    inssCents,
    irrf: {
      deduction: irrf.deduction,
      deductionCents: irrf.deductionCents,
      taxBeforeReductionCents: irrf.taxBeforeReductionCents,
      reductionCents: irrf.reductionCents,
      taxCents: irrf.taxCents,
    },
    irrfCents: irrf.taxCents,
    fgtsCents,
    netCents: salaryCents + extraEarningsCents - inssCents - irrf.taxCents - fixedDeductionsCents,
  };
}

export interface GrossForNetInput extends Omit<MonthlyPayrollInput, 'grossCents'> {
  targetNetCents: number;
}

export interface GrossForNetResult {
  /** The smallest gross whose net reaches the target. */
  grossCents: number;
  payroll: MonthlyPayroll;
  /** net - target: 0 when the target is reachable to the cent, otherwise the (small) overshoot. */
  differenceCents: number;
}

const MAX_GROSS_CENTS = 100_000_000_000; // 1 billion

/**
 * Net to gross by bisection over the direct calculation (the net never decreases when the gross grows). Returns the
 * smallest gross with net >= target, so two neighbouring grosses with the same net give the lower one. Throws when the
 * target is out of reach.
 */
export function findGrossForNet(input: GrossForNetInput): GrossForNetResult {
  assertCents('targetNetCents', input.targetNetCents);
  const netAt = (g: number) => computeMonthlyPayroll({ ...input, grossCents: g }).netCents;
  if (netAt(0) >= input.targetNetCents) {
    const payroll = computeMonthlyPayroll({ ...input, grossCents: 0 });
    return { grossCents: 0, payroll, differenceCents: payroll.netCents - input.targetNetCents };
  }
  let hi = Math.max(100, input.targetNetCents);
  while (netAt(hi) < input.targetNetCents) {
    hi *= 2;
    if (hi > MAX_GROSS_CENTS) throw new Error('Target net is out of reach.');
  }
  let lo = 0; // netAt(lo) < target, netAt(hi) >= target
  while (hi - lo > 1) {
    const mid = Math.floor((lo + hi) / 2);
    if (netAt(mid) >= input.targetNetCents) hi = mid;
    else lo = mid;
  }
  const payroll = computeMonthlyPayroll({ ...input, grossCents: hi });
  return { grossCents: hi, payroll, differenceCents: payroll.netCents - input.targetNetCents };
}
