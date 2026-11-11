/**
 * Own share of an expense: what is really the user's part of a transaction that other people took part in.
 *
 *   own share = |amount| - (sum of the shares THEY_OWE_ME of that transaction), never below zero.
 *
 * Same subtraction the people module already shows as `myPart` (see `buildResponse` in shares.service.ts), with a floor
 * at zero. Shares in the other direction (I_OWE_THEM) do not change it: they are money the user owes for something
 * another person paid, not a slice of the user's own expense. Settlements never enter: they move money between the
 * user and a person, they do not change what a purchase cost. Only EXPENSE transactions have an own share; the callers
 * leave income, transfers, card payments and adjustments as they are. Whole cents.
 */
import type { Prisma } from '../../generated/prisma/client.js';
import { storedToCents } from './money.js';

export function ownAmountCents(amountCents: number, theirCents: number): number {
  return Math.max(0, Math.abs(amountCents) - Math.max(0, theirCents));
}

/** What the people owe the user on one expense transaction, with the data a budget needs to place it. */
export interface TheirShare {
  transactionId: string;
  /** Sum of the THEY_OWE_ME shares of the transaction. */
  theirCents: number;
  /** |amount| of the transaction. */
  amountCents: number;
  categoryName: string | null;
}

/** Cents of the amount the own share takes off the expense (the part that belongs to others, at most the whole). */
export function deductionCents(share: Pick<TheirShare, 'theirCents' | 'amountCents'>): number {
  return share.amountCents - ownAmountCents(share.amountCents, share.theirCents);
}

/**
 * The THEY_OWE_ME shares of the household's EXPENSE transactions matching `transactionWhere`, summed per transaction.
 * One query over the shares only (not over every transaction); a transaction of another household never matches.
 */
export async function loadTheirShares(
  db: Pick<Prisma.TransactionClient, 'transactionShare'>,
  householdId: string,
  transactionWhere: Prisma.TransactionWhereInput = {},
): Promise<Map<string, TheirShare>> {
  const rows = await db.transactionShare.findMany({
    where: {
      householdId,
      direction: 'THEY_OWE_ME',
      transaction: { AND: [{ householdId, type: 'EXPENSE' }, transactionWhere] },
    },
    select: { transactionId: true, amount: true, transaction: { select: { amount: true, categoryName: true } } },
  });
  const out = new Map<string, TheirShare>();
  for (const row of rows) {
    const current = out.get(row.transactionId);
    const theirCents = storedToCents(row.amount);
    if (current) current.theirCents += theirCents;
    else out.set(row.transactionId, { transactionId: row.transactionId, theirCents, amountCents: Math.abs(storedToCents(row.transaction.amount)), categoryName: row.transaction.categoryName });
  }
  return out;
}
