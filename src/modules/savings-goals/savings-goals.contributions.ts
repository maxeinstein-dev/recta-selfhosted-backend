import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/index.js';
import { plannedCentsFor, type PlanGoal } from './savings-goals.planning.js';

/** A goal row as the planning code needs it (Decimal fields as Prisma returns them). */
export interface GoalRow {
  id: string;
  accountId: string | null;
  name: string;
  kind: 'RESERVE' | 'PROVISION';
  targetAmount: { toNumber(): number };
  currentAmount: { toNumber(): number };
  monthlyContribution: { toNumber(): number } | null;
  contributionDay: number | null;
  dueMonth: string | null;
}

export const toCents = (n: number): number => Math.round(n * 100);
const fromCents = (c: number): Prisma.Decimal => new Prisma.Decimal(c).div(100);

export function planGoalOf(g: GoalRow): PlanGoal {
  return {
    id: g.id,
    accountId: g.accountId,
    name: g.name,
    kind: g.kind,
    targetCents: toCents(g.targetAmount.toNumber()),
    currentCents: toCents(g.currentAmount.toNumber()),
    monthlyCents: g.monthlyContribution ? toCents(g.monthlyContribution.toNumber()) : null,
    contributionDay: g.contributionDay,
    dueMonth: g.dueMonth,
  };
}

const dayOf = (d: Date): string => d.toISOString().slice(0, 10);

export interface ContributionView {
  id: string;
  goalId: string;
  amount: number;
  /** 'YYYY-MM-DD' */
  date: string;
  /** 'YYYY-MM' the contribution counts for */
  month: string;
  createdAt: Date;
}

const viewOf = (c: { id: string; goalId: string; amount: { toNumber(): number }; date: Date; month: string; createdAt: Date }): ContributionView => ({
  id: c.id,
  goalId: c.goalId,
  amount: c.amount.toNumber(),
  date: dayOf(c.date),
  month: c.month,
  createdAt: c.createdAt,
});

/**
 * Serialises everything that touches one goal's kept amount: the row lock is held until the transaction ends, so two
 * simultaneous contributions (a double tap, two devices) queue instead of both reading the same amount. Scoped to the
 * household: a goal of another household is not found.
 */
async function lockGoal(tx: Prisma.TransactionClient, goalId: string, householdId: string): Promise<GoalRow & { householdId: string }> {
  const locked = await tx.$queryRaw<Array<{ id: string }>>`SELECT id FROM savings_goals WHERE id = ${goalId}::uuid AND household_id = ${householdId}::uuid FOR UPDATE`;
  if (locked.length === 0) throw new NotFoundError('Savings goal');
  const goal = await tx.savingsGoal.findFirst({ where: { id: goalId, householdId } });
  if (!goal) throw new NotFoundError('Savings goal');
  return goal as unknown as GoalRow & { householdId: string };
}

export interface ContributeParams {
  goalId: string;
  householdId: string;
  /** Money units; defaults to the amount planned for the month. */
  amount?: number;
  /** 'YYYY-MM-DD'; defaults to today. Fixes the month the contribution counts for. */
  date?: string;
  /** Allow a second contribution in a month that already has one. */
  confirmDuplicate?: boolean;
  today?: Date;
}

/**
 * Registers a contribution to a goal: one row in `savings_goal_contributions` and `currentAmount` raised, in ONE
 * transaction under the goal's row lock. It creates no Transaction and touches no account balance: the account keeps
 * matching the statement, only its free balance (balance minus what the goals hold) drops.
 */
export async function contribute(params: ContributeParams) {
  const today = dayOf(params.today ?? new Date());
  const date = params.date ?? today;
  const month = date.slice(0, 7);
  if (Number.isNaN(Date.parse(`${date}T00:00:00Z`))) throw new BadRequestError('Invalid date');
  if (params.amount !== undefined && Math.abs(params.amount * 100 - Math.round(params.amount * 100)) > 1e-6) {
    throw new BadRequestError('Amount must have at most two decimal places');
  }

  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const goal = await lockGoal(tx, params.goalId, params.householdId);
    if (!goal.accountId) throw new BadRequestError('Link the goal to an account before putting money in it');

    const inMonth = await tx.savingsGoalContribution.findMany({ where: { goalId: goal.id, month }, select: { amount: true } });
    if (inMonth.length > 0 && !params.confirmDuplicate) {
      throw new ConflictError('This goal already has a contribution in this month; confirm to add another');
    }

    const plan = planGoalOf(goal);
    const remainingCents = plan.targetCents - plan.currentCents;
    const amountCents = params.amount !== undefined ? toCents(params.amount) : plannedCentsFor(plan, month, remainingCents);
    if (amountCents <= 0) throw new BadRequestError('Nothing planned for this month: inform the amount');
    if (amountCents > remainingCents) {
      throw new BadRequestError(`This amount would exceed the target. Maximum allowed: ${remainingCents / 100}`);
    }

    const amount = fromCents(amountCents);
    const created = await tx.savingsGoalContribution.create({
      data: { goalId: goal.id, householdId: params.householdId, amount, date: new Date(`${date}T00:00:00Z`), month },
    });
    const updated = await tx.savingsGoal.update({ where: { id: goal.id }, data: { currentAmount: { increment: amount } } });
    return {
      contribution: viewOf(created),
      goal: { id: goal.id, currentAmount: (updated.currentAmount as { toNumber(): number } | undefined)?.toNumber?.() ?? (plan.currentCents + amountCents) / 100 },
    };
  });
}

/** Undoes a contribution: deletes it and gives the amount back (never below zero), under the same goal lock. */
export async function undoContribution(params: { goalId: string; householdId: string; contributionId: string }) {
  return prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    const goal = await lockGoal(tx, params.goalId, params.householdId);
    const row = await tx.savingsGoalContribution.findFirst({
      where: { id: params.contributionId, goalId: params.goalId, householdId: params.householdId },
    });
    if (!row) throw new NotFoundError('Contribution');
    await tx.savingsGoalContribution.delete({ where: { id: row.id } });
    const nextCents = Math.max(0, toCents(goal.currentAmount.toNumber()) - toCents(row.amount.toNumber()));
    await tx.savingsGoal.update({ where: { id: goal.id }, data: { currentAmount: fromCents(nextCents) } });
    return { undone: viewOf(row), goal: { id: goal.id, currentAmount: nextCents / 100 } };
  });
}

export async function listContributions(params: { goalId: string; householdId: string; month?: string }): Promise<ContributionView[]> {
  const goal = await prisma.savingsGoal.findFirst({ where: { id: params.goalId, householdId: params.householdId }, select: { id: true } });
  if (!goal) throw new NotFoundError('Savings goal');
  const rows = await prisma.savingsGoalContribution.findMany({
    where: { goalId: params.goalId, householdId: params.householdId, ...(params.month && { month: params.month }) },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }],
  });
  return rows.map(viewOf);
}
