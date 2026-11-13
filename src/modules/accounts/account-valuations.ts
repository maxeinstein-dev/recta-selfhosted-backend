import { Prisma } from '../../generated/prisma/client.js';
import { z } from 'zod';
import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, NotFoundError } from '../../shared/errors/index.js';
import { AccountType } from '../../shared/enums/index.js';

/**
 * Market value of an investment account on a day, informed by the user (the statement figure). It is a record of its
 * own, never a transaction: a yield is not income, and a contribution stays a transfer to the account. The net worth
 * reads the latest value up to the end of a month (see dashboard/net-worth.ts). One value per account and day.
 */

const todayUtcDay = (): string => new Date().toISOString().slice(0, 10);

export const valuationBodySchema = z.object({
  date: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD')
    .refine((value) => {
      const [y, m, d] = value.split('-').map(Number) as [number, number, number];
      const parsed = new Date(Date.UTC(y, m - 1, d));
      return parsed.getUTCFullYear() === y && parsed.getUTCMonth() === m - 1 && parsed.getUTCDate() === d;
    }, 'date is not a valid calendar day')
    .refine((value) => value <= todayUtcDay(), 'date cannot be in the future'),
  // No coercion of null/false to 0: only a number or a plain numeric string is an amount.
  amount: z.preprocess(
    (v) => (typeof v === 'string' && /^\s*\d+(\.\d+)?\s*$/.test(v) ? Number(v) : v),
    z
      .number({ invalid_type_error: 'amount must be a number' })
      .finite()
      .min(0, 'amount cannot be negative')
      .refine((n) => n < 1e12, 'amount is out of range')
      .refine((n) => Math.abs(Math.round(n * 100) - n * 100) < 1e-6, 'amount must have at most two decimal places'),
  ),
});

export type ValuationBody = z.infer<typeof valuationBodySchema>;

export interface ValuationView {
  id: string;
  accountId: string;
  date: string;
  amount: number;
}

const view = (row: { id: string; accountId: string; date: Date; amount: { toNumber(): number } }): ValuationView => ({
  id: row.id,
  accountId: row.accountId,
  date: row.date.toISOString().slice(0, 10),
  amount: row.amount.toNumber(),
});

async function accountOf(accountId: string, householdId: string) {
  const account = await prisma.account.findFirst({ where: { id: accountId, householdId }, select: { id: true, type: true } });
  if (!account) throw new NotFoundError('Account');
  return account;
}

export async function listValuations(accountId: string, householdId: string): Promise<ValuationView[]> {
  await accountOf(accountId, householdId);
  const rows = await prisma.accountValuation.findMany({ where: { accountId }, orderBy: { date: 'desc' } });
  return rows.map(view);
}

export async function saveValuation(accountId: string, householdId: string, body: ValuationBody): Promise<ValuationView> {
  const account = await accountOf(accountId, householdId);
  if (account.type !== AccountType.INVESTMENT) {
    throw new BadRequestError('Only an investment account has a market value');
  }
  const date = new Date(`${body.date}T00:00:00.000Z`);
  const amount = new Prisma.Decimal(body.amount);
  const row = await prisma.accountValuation.upsert({
    where: { accountId_date: { accountId, date } },
    create: { accountId, date, amount },
    update: { amount },
  });
  return view(row);
}

export async function deleteValuation(accountId: string, householdId: string, valuationId: string): Promise<void> {
  const found = await prisma.accountValuation.findFirst({
    where: { id: valuationId, accountId, account: { householdId } },
    select: { id: true },
  });
  if (!found) throw new NotFoundError('Valuation');
  await prisma.accountValuation.delete({ where: { id: valuationId } });
}
