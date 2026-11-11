/**
 * Versioned payroll tables (INSS, IRRF, FGTS). Pure data plus the lookup by date: no database, no clock.
 * Money is whole cents; rates are basis points (1% = 100) so every product stays an exact integer.
 *
 * A table is valid from `validFrom` until the next table of the same kind starts. The last table of a kind may carry
 * `validUntil` (the INSS table is republished every year): a date past it uses that last table and the lookup says so,
 * so the caller can warn that the result is a projection with an old table.
 *
 * Provenance: each table lists its official source and what could NOT be confirmed in an official text.
 */

export type PayrollDay = string; // 'YYYY-MM-DD'

export interface TableSource {
  urls: string[];
  /** Figures that were not read in an official text. Empty when everything was confirmed. */
  unconfirmed: string[];
}

export interface InssBand {
  /** Upper limit of the band (inclusive), in cents of salary-of-contribution. */
  upToCents: number;
  rateBp: number;
  /** "Parcela a deduzir" of the band, for the "rate times base minus deduction" form. */
  deductionCents: number;
}

export interface InssTable {
  id: string;
  validFrom: PayrollDay;
  /** Last day the table is known to apply; null when it has no known end. */
  validUntil: PayrollDay | null;
  /** The last band's upper limit. */
  ceilingCents: number;
  bands: readonly InssBand[];
  source: TableSource;
}

export interface IrrfBand {
  /** Upper limit of the band (inclusive); null for the open top band. */
  upToCents: number | null;
  rateBp: number;
  deductionCents: number;
}

/** Lei 15.270/2025 reducer: a fixed amount up to `fullUpToCents`, then linear down to zero at `endsAtCents`. */
export interface IrrfReducer {
  fullUpToCents: number;
  /** Reduction (cap) up to `fullUpToCents`. */
  maxCents: number;
  /** Between the two limits: reduction = interceptCents - coefficientMicro / 1_000_000 * taxable income. */
  interceptCents: number;
  coefficientMicro: number;
  endsAtCents: number;
}

export interface IrrfTable {
  id: string;
  validFrom: PayrollDay;
  validUntil: PayrollDay | null;
  bands: readonly IrrfBand[];
  dependentDeductionCents: number;
  simplifiedDeductionCents: number;
  reducer: IrrfReducer | null;
  source: TableSource;
}

export interface FgtsTable {
  id: string;
  validFrom: PayrollDay;
  validUntil: PayrollDay | null;
  rateBp: number;
  source: TableSource;
}

export type TableWarningCode = 'projection_old_table' | 'before_first_table';

export interface TableLookup<T> {
  table: T;
  /** Set when the date has no table of its own. */
  warning: TableWarningCode | null;
}

const INSS_URLS_2026 = [
  'https://www.gov.br/previdencia/pt-br/noticias/2026/janeiro/beneficios-com-valor-acima-do-salario-minimo-sao-reajustados-em-3-9',
  'https://www.gov.br/inss/pt-br/assuntos/com-reajuste-de-3-9-teto-do-inss-chega-a-r-8-475-55-em-2026',
];
const INSS_URLS_2025 = ['https://www.gov.br/inss/pt-br/noticias/confira-como-ficaram-as-aliquotas-de-contribuicao-ao-inss'];
const IRRF_URL_2026 = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/2026';
const IRRF_URL_2025 = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/2025';
const IRRF_URL_LEI_15270 = 'https://www.gov.br/receitafederal/pt-br/assuntos/meu-imposto-de-renda/tabelas/exemplos-de-aplicacao-da-lei-15-270-2025';

/**
 * The official INSS publications list bands and rates only. The "parcela a deduzir" values below are DERIVED, not
 * published: each one is the previous deduction plus (previous upper limit x rate difference), rounded to the cent at
 * every step. The 12% band's 111.41 (2026) is the figure the payroll used in the reference documents; the 14% band's
 * 198.50 (2026) and 190.41 (2025) follow the same chain and are NOT confirmed (the exact, unrounded value is one cent lower).
 */
const INSS_DEDUCTION_NOTE =
  'Parcelas a deduzir derivadas da progressão das faixas (a portaria publica só faixas e alíquotas); a da faixa de 14% não foi confirmada, pode diferir em 1 centavo.';

export const INSS_TABLES: readonly InssTable[] = [
  {
    id: 'inss-2025',
    validFrom: '2025-01-01',
    validUntil: '2025-12-31',
    ceilingCents: 815741,
    bands: [
      { upToCents: 151800, rateBp: 750, deductionCents: 0 },
      { upToCents: 279388, rateBp: 900, deductionCents: 2277 },
      { upToCents: 419083, rateBp: 1200, deductionCents: 10659 },
      { upToCents: 815741, rateBp: 1400, deductionCents: 19041 },
    ],
    source: {
      urls: INSS_URLS_2025,
      unconfirmed: [
        'Faixas lidas em aviso do gov.br/inss (Portaria Interministerial MPS/MF nº 6/2025), não no texto do Diário Oficial.',
        INSS_DEDUCTION_NOTE,
      ],
    },
  },
  {
    id: 'inss-2026',
    validFrom: '2026-01-01',
    validUntil: '2026-12-31',
    ceilingCents: 847555,
    bands: [
      { upToCents: 162100, rateBp: 750, deductionCents: 0 },
      { upToCents: 290284, rateBp: 900, deductionCents: 2432 },
      { upToCents: 435427, rateBp: 1200, deductionCents: 11141 },
      { upToCents: 847555, rateBp: 1400, deductionCents: 19850 },
    ],
    source: {
      urls: INSS_URLS_2026,
      unconfirmed: [
        'Faixas, alíquotas e teto lidos em notícias oficiais do gov.br sobre a Portaria Interministerial MPS/MF nº 13/2026; o PDF da portaria não pôde ser aberto.',
        INSS_DEDUCTION_NOTE,
      ],
    },
  },
];

const IRRF_BANDS_2025_MAY = [
  { upToCents: 242880, rateBp: 0, deductionCents: 0 },
  { upToCents: 282665, rateBp: 750, deductionCents: 18216 },
  { upToCents: 375105, rateBp: 1500, deductionCents: 39416 },
  { upToCents: 466468, rateBp: 2250, deductionCents: 67549 },
  { upToCents: null, rateBp: 2750, deductionCents: 90873 },
] as const satisfies readonly IrrfBand[];

export const IRRF_TABLES: readonly IrrfTable[] = [
  {
    id: 'irrf-2025-01',
    validFrom: '2025-01-01',
    validUntil: null,
    bands: [
      { upToCents: 225920, rateBp: 0, deductionCents: 0 },
      { upToCents: 282665, rateBp: 750, deductionCents: 16944 },
      { upToCents: 375105, rateBp: 1500, deductionCents: 38144 },
      { upToCents: 466468, rateBp: 2250, deductionCents: 66277 },
      { upToCents: null, rateBp: 2750, deductionCents: 89600 },
    ],
    dependentDeductionCents: 18959,
    simplifiedDeductionCents: 56480,
    reducer: null,
    source: { urls: [IRRF_URL_2025], unconfirmed: [] },
  },
  {
    id: 'irrf-2025-05',
    validFrom: '2025-05-01',
    validUntil: null,
    bands: IRRF_BANDS_2025_MAY,
    dependentDeductionCents: 18959,
    simplifiedDeductionCents: 60720,
    reducer: null,
    source: { urls: [IRRF_URL_2025], unconfirmed: [] },
  },
  {
    id: 'irrf-2026-01',
    validFrom: '2026-01-01',
    validUntil: null,
    bands: IRRF_BANDS_2025_MAY,
    dependentDeductionCents: 18959,
    simplifiedDeductionCents: 60720,
    reducer: {
      fullUpToCents: 500000,
      maxCents: 31289,
      interceptCents: 97862,
      coefficientMicro: 133145,
      endsAtCents: 735000,
    },
    source: {
      urls: [IRRF_URL_2026, IRRF_URL_LEI_15270],
      unconfirmed: [
        'A Receita não define arredondamento nem para o redutor nem para o imposto; o redutor é arredondado ao centavo mais próximo aqui.',
        'O redutor usa o rendimento tributável bruto (antes de INSS e desconto), como nos exemplos da Receita.',
      ],
    },
  },
];

export const FGTS_TABLES: readonly FgtsTable[] = [
  {
    id: 'fgts-8',
    validFrom: '1990-05-11',
    validUntil: null,
    rateBp: 800,
    source: {
      urls: [],
      unconfirmed: ['Alíquota de 8% do trabalhador CLT (Lei 8.036/1990) não foi reconferida numa página oficial nesta etapa.'],
    },
  },
];

interface Versioned {
  validFrom: PayrollDay;
  validUntil: PayrollDay | null;
}

/** Picks the table in force on `day` ('YYYY-MM-DD'). Tables need not be sorted. */
export function pickTable<T extends Versioned>(tables: readonly T[], day: PayrollDay): TableLookup<T> {
  if (tables.length === 0) throw new Error('No payroll table registered.');
  const sorted = [...tables].sort((a, b) => (a.validFrom < b.validFrom ? -1 : a.validFrom > b.validFrom ? 1 : 0));
  const first = sorted[0]!;
  if (day < first.validFrom) return { table: first, warning: 'before_first_table' };
  let current = first;
  for (const t of sorted) {
    if (t.validFrom <= day) current = t;
    else break;
  }
  const isLast = current === sorted[sorted.length - 1];
  if (isLast && current.validUntil !== null && day > current.validUntil) {
    return { table: current, warning: 'projection_old_table' };
  }
  return { table: current, warning: null };
}

export const selectInssTable = (day: PayrollDay, tables: readonly InssTable[] = INSS_TABLES) => pickTable(tables, day);
export const selectIrrfTable = (day: PayrollDay, tables: readonly IrrfTable[] = IRRF_TABLES) => pickTable(tables, day);
export const selectFgtsTable = (day: PayrollDay, tables: readonly FgtsTable[] = FGTS_TABLES) => pickTable(tables, day);
