/**
 * Holiday calendar in three levels (national, state by UF, municipal by UF + city), versioned here like the tax
 * tables. Pure data plus the lookup: no database, no clock. Fixed holidays (month and day) and movable ones (days
 * from Easter Sunday), an `optional` mark for pontos facultativos (carnival, Corpus Christi) and the source of each.
 *
 * What counts as a day off for an employment (`HolidayConfig`):
 * - no UF informed: no calendar at all (`null`), the module keeps looking only at weekends, as before the calendar;
 * - UF informed: the national holidays, plus the state ones when the UF has a table, plus the municipal ones when the
 *   city has a table. Without a table for the UF or the city the lookup says so in `warnings`;
 * - a holiday marked `optional` counts only when the employment says optional days are days off (`optionalOff`);
 * - an entry marked `confirmed: false` (the date could not be confirmed in an official source) never counts as a
 *   day off; the monthly calculation shows it as a warning instead, so the user can check it.
 *
 * Sources (read in 11/2026). National: Lei 662/1949 as rewritten by Lei 10.607/2002 (01/01, 21/04, 01/05, 07/09,
 * 02/11, 15/11, 25/12), Lei 6.802/1980 (12/10), Lei 14.759/2023 (20/11, from 2024) and the federal calendar of 2026,
 * Portaria MGI 11.460/2025 (Paixão de Cristo as a national holiday; carnival Monday and Tuesday and Corpus Christi
 * as pontos facultativos). Sergipe and Aracaju: official acts of the Ministério Público Federal in Sergipe for 2023
 * (DMPF-e 13/2023, 19/01/2023) and the decree of the state executive for 2025 (Decreto 920/2025).
 */
import { easterSunday } from '../recurring-transactions/br-calendar.js';
import { addDays, formatDay } from './payroll-dates.js';

export type HolidayLevel = 'national' | 'state' | 'municipal';

export interface HolidayEntry {
  id: string;
  name: string;
  /** Fixed day of the year, or days from Easter Sunday (negative = before). */
  rule: { month: number; day: number } | { easterOffset: number };
  /** Ponto facultativo: counts as a day off only when the employment says so. */
  optional: boolean;
  /** First year the holiday exists (default: always). */
  fromYear?: number;
  /** False when the date could not be confirmed in an official source: listed, but never counted. */
  confirmed: boolean;
  source: { urls: string[]; note: string };
}

export interface HolidayTable {
  level: HolidayLevel;
  uf: string | null;
  /** Normalized city key (see `cityKey`); null above the municipal level. */
  city: string | null;
  label: string;
  entries: readonly HolidayEntry[];
}

const MGI_2026 = 'https://www.gov.br/gestao/pt-br/assuntos/noticias/2025/dezembro/confira-o-calendario-oficial-de-feriados-nacionais-e-pontos-facultativos-em-2026';
const PLANALTO_10607 = 'https://www.planalto.gov.br/ccivil_03/leis/2002/l10607.htm';
const MPF_SE_2023 = 'https://biblioteca.mpf.mp.br/repositorio/bitstreams/1e49512d-7528-44e8-bb6f-96128eb68d3c/download';
const SE_DECREE_2025 = 'https://www.legisweb.com.br/legislacao/?id=471712';

const fixed = (id: string, name: string, month: number, day: number, source: HolidayEntry['source'], extra: Partial<HolidayEntry> = {}): HolidayEntry => ({
  id,
  name,
  rule: { month, day },
  optional: false,
  confirmed: true,
  source,
  ...extra,
});

const national10607 = { urls: [PLANALTO_10607], note: 'Lei 10.607/2002 (nova redação da Lei 662/1949)' };
const federal2026 = { urls: [MGI_2026], note: 'Portaria MGI 11.460/2025 (calendário federal de 2026); a regra se repete nos outros anos' };

export const NATIONAL_HOLIDAYS: readonly HolidayEntry[] = [
  fixed('new-year', 'Confraternização Universal', 1, 1, national10607),
  fixed('tiradentes', 'Tiradentes', 4, 21, national10607),
  fixed('labour-day', 'Dia Mundial do Trabalho', 5, 1, national10607),
  fixed('independence', 'Independência do Brasil', 9, 7, national10607),
  fixed('our-lady-aparecida', 'Nossa Senhora Aparecida', 10, 12, {
    urls: ['https://www.planalto.gov.br/ccivil_03/leis/l6802.htm'],
    note: 'Lei 6.802/1980',
  }),
  fixed('all-souls', 'Finados', 11, 2, national10607),
  fixed('republic', 'Proclamação da República', 11, 15, national10607),
  fixed('black-awareness', 'Dia Nacional de Zumbi e da Consciência Negra', 11, 20, {
    urls: ['https://www.planalto.gov.br/ccivil_03/_ato2023-2026/2023/lei/l14759.htm'],
    note: 'Lei 14.759/2023, feriado nacional a partir de 2024',
  }, { fromYear: 2024 }),
  fixed('christmas', 'Natal', 12, 25, national10607),
  {
    id: 'good-friday',
    name: 'Paixão de Cristo (Sexta-feira Santa)',
    rule: { easterOffset: -2 },
    optional: false,
    confirmed: true,
    source: federal2026,
  },
  {
    id: 'carnival-monday',
    name: 'Carnaval (segunda-feira)',
    rule: { easterOffset: -48 },
    optional: true,
    confirmed: true,
    source: federal2026,
  },
  {
    id: 'carnival-tuesday',
    name: 'Carnaval (terça-feira)',
    rule: { easterOffset: -47 },
    optional: true,
    confirmed: true,
    source: federal2026,
  },
  {
    id: 'corpus-christi',
    name: 'Corpus Christi',
    rule: { easterOffset: 60 },
    optional: true,
    confirmed: true,
    source: {
      urls: [MGI_2026, MPF_SE_2023],
      note: 'Ponto facultativo no calendário federal de 2026 e no ato do MPF em Sergipe de 2023. Calendários de terceiros o listam como feriado em Aracaju; isso não foi confirmado em lei.',
    },
  },
];

/** State tables by UF. Only Sergipe has one for now; another UF gets the national holidays and a warning. */
export const STATE_HOLIDAY_TABLES: readonly HolidayTable[] = [
  {
    level: 'state',
    uf: 'SE',
    city: null,
    label: 'Sergipe',
    entries: [
      fixed('se-political-emancipation', 'Emancipação Política de Sergipe', 7, 8, {
        urls: [MPF_SE_2023, SE_DECREE_2025],
        note: 'Constituição do Estado de Sergipe, art. 269 (citado no ato do MPF em Sergipe de 2023); Decreto estadual 920/2025 também o lista como feriado estadual',
      }),
    ],
  },
];

/** Municipal tables by UF + city. Only Aracaju/SE for now. */
export const MUNICIPAL_HOLIDAY_TABLES: readonly HolidayTable[] = [
  {
    level: 'municipal',
    uf: 'SE',
    city: 'aracaju',
    label: 'Aracaju',
    entries: [
      fixed('aracaju-anniversary', 'Aniversário de Aracaju', 3, 17, {
        urls: [MPF_SE_2023],
        note: 'Lei Municipal 3.805/2009, segundo o ato do MPF em Sergipe de 2023 (o texto da lei não foi lido)',
      }),
      fixed('aracaju-sao-joao', 'São João', 6, 24, {
        urls: [MPF_SE_2023, 'https://www.econeteditora.com.br/icms_se/aracaju/leis/2020/lei_5310_2020.php'],
        note: 'Lei Municipal 3.805/2009, de 03/12/2009 (citada no ato do MPF em Sergipe de 2023 e na Lei Municipal 5.310/2020); o texto da lei não foi lido',
      }),
      fixed(
        'aracaju-our-lady-conception',
        'Nossa Senhora da Conceição',
        12,
        8,
        {
          urls: [MPF_SE_2023],
          note: 'NÃO CONFIRMADO: o ato oficial do MPF em Sergipe de 2023 trata 08/12 só como ponto facultativo (Dia da Justiça); calendários de terceiros o listam como feriado municipal sem citar lei vigente',
        },
        { confirmed: false },
      ),
    ],
  },
];

// Lookup ---------------------------------------------------------------------------------------------------------

export interface HolidayConfig {
  /** Two-letter UF, e.g. 'SE'. Without it there is no calendar. */
  uf?: string | null;
  city?: string | null;
  /** Pontos facultativos count as days off. */
  optionalOff?: boolean;
}

export type HolidayWarningCode = 'no_state_table' | 'no_city_table';

export interface HolidayWarning {
  code: HolidayWarningCode;
  message: string;
}

export interface ResolvedHoliday {
  date: string;
  id: string;
  name: string;
  level: HolidayLevel;
  optional: boolean;
  confirmed: boolean;
  source: HolidayEntry['source'];
}

/** Lower case, no accents, single spaces: 'Aracaju', ' aracaju ' and 'ARACAJÚ' are the same city. */
export function cityKey(city: string): string {
  return city
    .normalize('NFD')
    .replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();
}

export function normalizeUf(uf: string | null | undefined): string | null {
  const v = uf?.trim().toUpperCase();
  return v ? v : null;
}

/** The tables that apply to a config, and the warnings for the levels that have none. Null when there is no calendar. */
export function tablesFor(config: HolidayConfig | null | undefined): { tables: HolidayTable[]; warnings: HolidayWarning[] } | null {
  const uf = normalizeUf(config?.uf);
  if (!uf) return null;
  const tables: HolidayTable[] = [{ level: 'national', uf: null, city: null, label: 'Brasil', entries: NATIONAL_HOLIDAYS }];
  const warnings: HolidayWarning[] = [];
  const state = STATE_HOLIDAY_TABLES.find((t) => t.uf === uf);
  if (state) tables.push(state);
  else warnings.push({ code: 'no_state_table', message: `Sem tabela de feriados estaduais para ${uf}: valem só os nacionais` });
  const cityName = config?.city?.trim();
  if (cityName) {
    const key = cityKey(cityName);
    const city = MUNICIPAL_HOLIDAY_TABLES.find((t) => t.uf === uf && t.city === key);
    if (city) tables.push(city);
    else warnings.push({ code: 'no_city_table', message: `Sem tabela de feriados municipais para ${cityName}/${uf}: não entram os municipais` });
  }
  return { tables, warnings };
}

function dateOf(entry: HolidayEntry, year: number): string | null {
  if (entry.fromYear !== undefined && year < entry.fromYear) return null;
  if ('easterOffset' in entry.rule) return addDays(easterSunday(year), entry.rule.easterOffset);
  return formatDay(year, entry.rule.month, entry.rule.day);
}

/** Every holiday of the year the config knows about (optional and unconfirmed ones included, marked), sorted by date. */
export function holidaysOfYear(config: HolidayConfig | null | undefined, year: number): ResolvedHoliday[] {
  const found = tablesFor(config);
  if (!found) return [];
  const out: ResolvedHoliday[] = [];
  for (const table of found.tables) {
    for (const entry of table.entries) {
      const date = dateOf(entry, year);
      if (date) out.push({ date, id: entry.id, name: entry.name, level: table.level, optional: entry.optional, confirmed: entry.confirmed, source: entry.source });
    }
  }
  return out.sort((a, b) => a.date.localeCompare(b.date) || a.id.localeCompare(b.id));
}

/** True when the holiday counts as a day off for the config. */
export function countsAsOff(holiday: Pick<ResolvedHoliday, 'optional' | 'confirmed'>, config: HolidayConfig | null | undefined): boolean {
  return holiday.confirmed && (!holiday.optional || config?.optionalOff === true);
}

/** Days off of a year ('YYYY-MM-DD'), for the business-day helpers. Empty without a calendar. */
export function offDaysOfYear(config: HolidayConfig | null | undefined, year: number): Set<string> {
  return new Set(holidaysOfYear(config, year).filter((h) => countsAsOff(h, config)).map((h) => h.date));
}

/** A predicate over 'YYYY-MM-DD' that caches each year it meets. Without a calendar it is always false. */
export function offDayChecker(config: HolidayConfig | null | undefined): (day: string) => boolean {
  if (!tablesFor(config)) return () => false;
  const cache = new Map<number, Set<string>>();
  return (day) => {
    const year = Number(day.slice(0, 4));
    let set = cache.get(year);
    if (!set) {
      set = offDaysOfYear(config, year);
      cache.set(year, set);
    }
    return set.has(day);
  };
}
