/**
 * FGTS birthday withdrawal (saque-aniversário): the yearly amount is a share of the balance plus a fixed additional
 * amount, by balance band. Pure data plus the lookup: no database, no clock. Whole cents; rates in basis points.
 *
 * Source: the table "na forma do anexo da Lei 8.036/90" as published by the FGTS operator on the official page
 * https://www.fgts.gov.br/Paginas/trabalhador/saque-aniversario.aspx (read in 11/2026; the modality itself was created
 * by Lei 13.932/2019). The figures were read from that page, not from the Diário Oficial text of the annex.
 */

export interface BirthdayBand {
  /** Upper limit of the band (inclusive), in cents; null for the open top band. */
  upToCents: number | null;
  rateBp: number;
  additionalCents: number;
}

export interface BirthdayTable {
  id: string;
  validFrom: string;
  bands: readonly BirthdayBand[];
  source: { urls: string[]; unconfirmed: string[] };
}

export const FGTS_BIRTHDAY_TABLES: readonly BirthdayTable[] = [
  {
    id: 'fgts-birthday-2020',
    validFrom: '2020-01-01',
    bands: [
      { upToCents: 50_000, rateBp: 5000, additionalCents: 0 },
      { upToCents: 100_000, rateBp: 4000, additionalCents: 5_000 },
      { upToCents: 500_000, rateBp: 3000, additionalCents: 15_000 },
      { upToCents: 1_000_000, rateBp: 2000, additionalCents: 65_000 },
      { upToCents: 1_500_000, rateBp: 1500, additionalCents: 115_000 },
      { upToCents: 2_000_000, rateBp: 1000, additionalCents: 190_000 },
      { upToCents: null, rateBp: 500, additionalCents: 290_000 },
    ],
    source: {
      urls: ['https://www.fgts.gov.br/Paginas/trabalhador/saque-aniversario.aspx'],
      unconfirmed: ['Annex of Lei 8.036/90 not read in the Diário Oficial; figures read from the FGTS operator page.'],
    },
  },
];

export function selectBirthdayTable(day: string, tables: readonly BirthdayTable[] = FGTS_BIRTHDAY_TABLES): BirthdayTable {
  const sorted = [...tables].sort((a, b) => a.validFrom.localeCompare(b.validFrom));
  let current = sorted[0]!;
  for (const t of sorted) if (t.validFrom <= day) current = t;
  return current;
}

/** Amount of the yearly withdrawal for a balance (cents): the band's share of the balance plus its additional amount. */
export function birthdayWithdrawalCents(balanceCents: number, table: BirthdayTable): number {
  if (!Number.isInteger(balanceCents)) throw new Error('balance must be whole cents.');
  if (balanceCents <= 0) return 0;
  const band = table.bands.find((b) => b.upToCents === null || balanceCents <= b.upToCents)!;
  return Math.floor((balanceCents * band.rateBp) / 10000) + band.additionalCents;
}
