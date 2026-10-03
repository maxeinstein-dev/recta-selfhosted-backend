/**
 * Contratos compartilhados do importador de planilha mensal (formato "MaxFin").
 *
 * Formato: uma aba por mês com 10 colunas
 *   A flag ("ok" | "-" | vazio) · B Descrição · C Categoria ·
 *   D Entrada-Previsto · E Recebido · F À receber ·
 *   G Saída-Previsto · H Realizado · I Saldo · J nota livre
 * e 4 blocos: entradas (sem linha Total), contas fixas, cartão e débito/pix
 * (cada um dos três últimos termina numa linha "Total"). Depois do terceiro
 * "Total" vem o rodapé (totais gerais e saldos de conta), que é ignorado.
 *
 * Este arquivo é só tipos. Quem o consome: shared/csv/grid.ts (produz Grid),
 * parsers/maxfin.parser.ts (produz MaxFinParseResult), maxfin-import.helpers.ts
 * e maxfin-import.service.ts. Não adicionar lógica aqui.
 */

/** Grade de células já tokenizada (RFC 4180): linhas × colunas, strings cruas (sem trim). */
export type Grid = string[][];

export type MaxFinSectionKey = 'income' | 'bills' | 'credit' | 'debit';

/** The four blocks of a sheet, in reading order. Single source for parser, helpers and service. */
export const MAXFIN_SECTION_KEYS: readonly MaxFinSectionKey[] = ['income', 'bills', 'credit', 'debit'];

export const MAXFIN_SECTION_LABELS: Record<MaxFinSectionKey, string> = {
  income: 'Entradas',
  bills: 'Contas fixas',
  credit: 'Cartão',
  debit: 'Débito/pix',
};

/** Parcela reconhecida na descrição: "Curso B 5/12 +7" → number=5, total=12, prepaid=7. */
export interface MaxFinInstallment {
  /** N em "N/M". */
  number: number;
  /** M em "N/M". */
  total: number;
  /** K em "+K": parcelas ANTECIPADAS nesta fatura (0 quando ausente). A linha já traz o total líquido. */
  prepaid: number;
  /** Descrição sem o sufixo "N/M" e "+K", com espaços normalizados. */
  baseDescription: string;
  /** Agrupador estável entre meses: `maxfin:<slug(baseDescription)>:<total>`. */
  installmentId: string;
  /** Parcelas ainda por vir: total − (number + prepaid). 0 = plano quitado. */
  futureCount: number;
}

/** Marcação de compartilhamento reconhecida na coluna J. Só informativa na fase 1. */
export type ShareHint =
  | { kind: 'split'; person: string; percent: 50 }        // "*Dividir com X"
  | { kind: 'owed_to_me'; person: string; percent: 100 }  // "*X" (X paga tudo)
  | { kind: 'reimbursable'; person: null; percent: 100 }  // "*Reembolsar"
  | { kind: 'owed_by_me'; person: string };               // "Pagar a X"

export interface MaxFinRow {
  /** Índice 1-based da linha lógica na grade (após o tokenizador), para rastreio e sourceRef. */
  sourceLine: number;
  section: MaxFinSectionKey;
  type: 'INCOME' | 'EXPENSE';
  /** Coluna B, com trim. Mantém "N/M" e "+K" quando existirem. */
  description: string;
  /** Coluna C com trim; para renda com C vazia, a própria descrição; '' quando não há chave. */
  categoryKey: string;
  /** Valor positivo pela regra: Recebido/Realizado quando ≠ 0, senão Previsto. */
  amount: number;
  /** Previsto (D para renda, G para despesa), ou null. */
  planned: number | null;
  /** Recebido (E) ou Realizado (H), ou null. */
  realized: number | null;
  /** Regra do mês corrente: true quando há Recebido/Realizado; cartão é sempre true. (Mês fechado sobrescreve para true no service.) */
  paid: boolean;
  /** Dia 01 do mês da aba, meia-noite local. */
  date: Date;
  /** Coluna J (trim) ou null. */
  rawNote: string | null;
  /** rawNote + notas geradas ("previsto R$ x", "antecipou K parcelas (N+1..N+K)"), separadas por " · ". */
  notes: string | null;
  /** Coluna A ("ok", "-") ou null. */
  flag: string | null;
  installment: MaxFinInstallment | null;
  shareHint: ShareHint | null;
  /** `maxfin:<AAAA-MM>:<section>:<sourceLine>`. */
  sourceRef: string;
}

export interface MaxFinSkippedRow {
  sourceLine: number;
  description: string;
  reason: string;
}

export interface MaxFinSectionSummary {
  key: MaxFinSectionKey;
  label: string;
  count: number;
  /** Soma dos `amount` das linhas aceitas da seção. */
  sum: number;
  /** Previsto da linha "Total" da planilha (null para entradas, que não têm Total). */
  sheetTotalPlanned: number | null;
  /** Realizado da linha "Total" da planilha, ou null. */
  sheetTotalRealized: number | null;
}

export interface MaxFinMonth {
  year: number;
  /** 1 a 12. */
  month: number;
}

export interface MaxFinParseResult {
  month: MaxFinMonth | null;
  monthSource: 'title' | 'filename' | 'override' | 'none';
  rows: MaxFinRow[];
  skipped: MaxFinSkippedRow[];
  sections: MaxFinSectionSummary[];
  warnings: string[];
}

export interface MaxFinParseOptions {
  /** Nome do arquivo enviado, usado como fallback para detectar o mês ("FINANÇAS_MAX_2026.xlsx - OUT.csv"). */
  filename?: string;
  /** Mês informado pelo usuário quando a detecção falha. Tem precedência sobre título e nome do arquivo. */
  monthOverride?: MaxFinMonth;
}
