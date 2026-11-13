/**
 * Planned contributions of the savings goals (reserves and provisions). Pure part: no database, no clock. Whole cents.
 *
 * A goal is money MARKED inside an account, not a separate account. The two definitions the rest of the app must share
 * live here: what is "kept in an account" (`allocatedCentsByAccount`: the sum of `currentAmount` of the goals linked to
 * it) and what a goal plans to put aside in a month (`plannedCentsFor`). The cash flow and the goals screen both read them.
 */

export type GoalKind = 'RESERVE' | 'PROVISION';

export interface PlanGoal {
  id: string;
  accountId: string | null;
  name: string;
  kind: GoalKind;
  targetCents: number;
  /** What is kept now (it already includes every recorded contribution). */
  currentCents: number;
  /** Planned contribution of each month; null on a provision means "the rest, evenly up to the due month". */
  monthlyCents: number | null;
  /** 1..28 */
  contributionDay: number | null;
  /** 'YYYY-MM', provisions only. */
  dueMonth: string | null;
}

export interface PlannedContribution {
  goalId: string;
  goalName: string;
  accountId: string;
  /** 'YYYY-MM' */
  month: string;
  /** 'YYYY-MM-DD': the contribution day of the month. */
  date: string;
  amountCents: number;
}

const monthIndex = (month: string): number => Number(month.slice(0, 4)) * 12 + (Number(month.slice(5, 7)) - 1);

/** Calendar months from `from` to `to`, both ends included; 0 when `to` is before `from`. */
export function monthsBetween(from: string, to: string): number {
  const n = monthIndex(to) - monthIndex(from) + 1;
  return n > 0 ? n : 0;
}

export function addMonth(month: string, n: number): string {
  const i = monthIndex(month) + n;
  return `${String(Math.floor(i / 12)).padStart(4, '0')}-${String((i % 12) + 1).padStart(2, '0')}`;
}

/** 'YYYY-MM-DD' of the contribution day (1..28, so every month has it). */
export function contributionDate(month: string, day: number): string {
  return `${month}-${String(day).padStart(2, '0')}`;
}

/**
 * What the goal plans to keep in `month`, given how much is still missing to the target (`remainingCents`, which the
 * caller lowers as it walks the months). Never more than what is missing.
 * - RESERVE: the monthly contribution, or nothing when there is none.
 * - PROVISION: the monthly contribution when the user set one; otherwise what is missing divided by the months left up
 *   to the due month, rounded up (so the target is reached on time; the cap trims the last month). Nothing after the due
 *   month: the bill is past.
 */
export function plannedCentsFor(goal: PlanGoal, month: string, remainingCents: number): number {
  if (remainingCents <= 0) return 0;
  if (goal.kind === 'PROVISION') {
    if (!goal.dueMonth) return 0;
    const monthsLeft = monthsBetween(month, goal.dueMonth);
    if (monthsLeft === 0) return 0;
    const wanted = goal.monthlyCents ?? Math.ceil(remainingCents / monthsLeft);
    return Math.min(wanted, remainingCents);
  }
  if (goal.monthlyCents === null || goal.monthlyCents <= 0) return 0;
  return Math.min(goal.monthlyCents, remainingCents);
}

/**
 * The contributions still to be made from today's month to the month of `end`: one per month and goal, on the contribution
 * day. A month the goal already has a recorded contribution for (`doneMonths`, keys 'goalId:YYYY-MM') is done and not
 * listed. A goal needs an account (where the money is taken from) and a contribution day to plan anything. The running
 * "missing to the target" drops with each planned month, so the plan stops by itself when the target is reached.
 */
export function plannedContributions(
  goals: readonly PlanGoal[],
  opts: { today: string; end: string; doneMonths: ReadonlySet<string> },
): PlannedContribution[] {
  const first = opts.today.slice(0, 7);
  const last = opts.end.slice(0, 7);
  const out: PlannedContribution[] = [];
  for (const goal of goals) {
    if (!goal.accountId || goal.contributionDay === null) continue;
    let remaining = goal.targetCents - goal.currentCents;
    for (let month = first; month <= last; month = addMonth(month, 1)) {
      if (opts.doneMonths.has(`${goal.id}:${month}`)) continue;
      const amountCents = plannedCentsFor(goal, month, remaining);
      if (amountCents <= 0) continue;
      remaining -= amountCents;
      out.push({ goalId: goal.id, goalName: goal.name, accountId: goal.accountId, month, date: contributionDate(month, goal.contributionDay), amountCents });
    }
  }
  return out;
}

/** What is kept in each account: the sum of `currentCents` of its goals. Goals without an account hold nothing in any. */
export function allocatedCentsByAccount(goals: readonly Pick<PlanGoal, 'accountId' | 'currentCents'>[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const g of goals) {
    if (!g.accountId) continue;
    map.set(g.accountId, (map.get(g.accountId) ?? 0) + g.currentCents);
  }
  return map;
}
