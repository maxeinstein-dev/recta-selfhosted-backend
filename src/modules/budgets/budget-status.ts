/**
 * Status of a budget against its limit, and which budget alert is due. Amounts are compared in whole cents, so the
 * boundaries do not depend on binary floats: exactly at the limit is "reached" (all of the limit is used), above it
 * "exceeded", and from 80% on "warning". The alerts follow the same thresholds: 75% (warning), the exact limit
 * (reached) and above it (exceeded), each sent once per budget and month.
 */

export type BudgetStatus = 'ok' | 'warning' | 'reached' | 'exceeded';
export type BudgetAlertKind = 'warning' | 'reached' | 'exceeded';

/** Notification metadata of a budget alert already sent; older ones have no status, only a percentage. */
export interface SentBudgetAlert {
  status?: string;
  percentage?: number;
}

const toCents = (value: number): number => Math.round(value * 100);

export function budgetStatusOf(spent: number, limit: number): BudgetStatus {
  const limitCents = toCents(limit);
  if (limitCents <= 0) return 'ok';
  const spentCents = toCents(spent);
  if (spentCents > limitCents) return 'exceeded';
  if (spentCents === limitCents) return 'reached';
  if (spentCents * 100 >= limitCents * 80) return 'warning';
  return 'ok';
}

/** The status a sent alert stands for: the stored one, or for an older alert the status its percentage implies. */
function sentStatus(alert: SentBudgetAlert): BudgetAlertKind | null {
  if (alert.status === 'warning' || alert.status === 'reached' || alert.status === 'exceeded') return alert.status;
  const percentage = alert.percentage;
  if (typeof percentage !== 'number') return null;
  if (percentage > 100) return 'exceeded';
  if (percentage >= 100) return 'reached';
  if (percentage >= 75) return 'warning';
  return null;
}

/**
 * The alert due now for a budget, or null. `sent` are the alerts already sent for this budget in the month: each
 * kind is sent once, and "exceeded" still goes out after "reached" was sent.
 */
export function budgetAlertKind(spent: number, limit: number, sent: ReadonlyArray<SentBudgetAlert>): BudgetAlertKind | null {
  const limitCents = toCents(limit);
  if (limitCents <= 0) return null;
  const sentKinds = new Set(sent.map(sentStatus));
  const spentCents = toCents(spent);
  if (spentCents > limitCents) return sentKinds.has('exceeded') ? null : 'exceeded';
  if (spentCents === limitCents) return sentKinds.has('reached') || sentKinds.has('exceeded') ? null : 'reached';
  const fromSeventyFive = spentCents * 100 >= limitCents * 75;
  if (fromSeventyFive && !sentKinds.has('warning') && !sentKinds.has('reached') && !sentKinds.has('exceeded')) return 'warning';
  return null;
}

export interface BudgetAlertCopyInput {
  name: string;
  spending: number;
  limit: number;
  /** " (sua parte)" when the budget is measured by the own share, else empty. */
  ownNote: string;
}

export function budgetAlertCopy(kind: BudgetAlertKind, input: BudgetAlertCopyInput): { title: string; message: string } {
  const { name, spending, limit, ownNote } = input;
  if (kind === 'exceeded') {
    return {
      title: `Orçamento ${name} excedido!`,
      message: `Você excedeu o orçamento de ${name} em ${(spending - limit).toFixed(2)} este mês. O limite era ${limit.toFixed(2)} e você gastou ${spending.toFixed(2)}${ownNote}.`,
    };
  }
  if (kind === 'reached') {
    return {
      title: `Orçamento ${name} atingido`,
      message: `Você usou todo o limite do orçamento de ${name} este mês: ${limit.toFixed(2)}${ownNote}. Qualquer gasto a mais passa do limite.`,
    };
  }
  const percentage = limit > 0 ? (spending / limit) * 100 : 0;
  return {
    title: `Orçamento ${name} atingiu 75%`,
    message: `Você já gastou ${(Math.round(percentage * 100) / 100).toFixed(2)}% do orçamento de ${name} este mês${ownNote}. Restam ${(limit - spending).toFixed(2)} para o final do mês.`,
  };
}
