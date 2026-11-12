import { Prisma } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError, BadRequestError, ConflictError, AppError } from '../../shared/errors/index.js';
import { getCategoryColor, AccountType, TransactionType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { lockCustomCategory } from '../../shared/utils/categoryLock.js';
import { updateBalanceForNormalTransaction, recalculateCreditCardLimit } from '../../shared/services/balance.service.js';
import { expectedAmountFor, normalizeStrategy } from './expected-amount.js';
import { assertEarlyDiscountConsistent, assertForecastConsistent, earlyDiscountQuoteOf, forecastInputOf, forecastBatch, isIncomeCategory, loadConfirmedHistory, localTodayString, referenceMonthOf } from './recurring-forecast.js';
import { amountOnDay, earlyDiscountOf } from './early-discount.js';
import { addMonths, monthOfDate } from '../../shared/utils/competence.js';
import { addMonthsClamped, anchorDayOf, dayString, localDate, monthBoundsUtc } from './recurring-dates.js';
import { normalizeDescription } from './detect.js';
import { recurrenceNameKeys } from './recurring-aliases.js';
import { FOLLOW_LOOKAHEAD_DAYS, followLastAmountInTx, plusDays } from './recurring-follow.js';
import type {
  CreateRecurringTransactionInput,
  UpdateRecurringTransactionInput,
  ListRecurringTransactionsQuery,
  ExecuteRecurringTransactionInput,
} from './recurring-transactions.schema.js';

/**
 * Calculate next run date based on frequency
 */
export function calculateNextRunDate(
  currentDate: Date,
  frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY',
  /** Day of month the recurrence is anchored to (day of its startDate): a short month clamps, the next one returns to it. */
  anchorDay?: number
): Date {
  if (frequency === 'MONTHLY') {
    const day = dayString(currentDate);
    return localDate(addMonthsClamped(day, 1, Math.max(anchorDay ?? 0, Number(day.slice(8, 10)))));
  }
  const next = new Date(currentDate);

  switch (frequency) {
    case 'DAILY':
      next.setDate(next.getDate() + 1);
      break;
    case 'WEEKLY':
      next.setDate(next.getDate() + 7);
      break;
    case 'BIWEEKLY':
      next.setDate(next.getDate() + 14);
      break;
    case 'YEARLY':
      next.setFullYear(next.getFullYear() + 1);
      break;
  }

  return next;
}

/**
 * Date a due occurrence is created with. A monthly recurrence runs on its scheduled day (nextRunAt) even when the cron
 * is late, so a late run does not shift the day of every later month (Oct 5 executed on Oct 20 stays Oct 5, next Nov 5).
 * Other frequencies keep dating the occurrence on the day it is processed.
 */
export function occurrenceDateFor(
  frequency: 'DAILY' | 'WEEKLY' | 'BIWEEKLY' | 'MONTHLY' | 'YEARLY',
  nextRunAt: Date,
  today: Date
): Date {
  if (frequency !== 'MONTHLY') return today;
  const scheduled = localDate(dayString(nextRunAt));
  return scheduled <= today ? scheduled : today;
}

/** JSON-safe view of a stored recurrence: decimals as numbers. */
function plain<T extends { amount: { toNumber(): number }; dailyRate?: { toNumber(): number } | null; earlyDiscountValue?: { toNumber(): number } | null }>(r: T) {
  return {
    ...r,
    amount: r.amount.toNumber(),
    dailyRate: r.dailyRate ? r.dailyRate.toNumber() : null,
    earlyDiscountValue: r.earlyDiscountValue ? r.earlyDiscountValue.toNumber() : null,
  };
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Criar uma recorrência NÃO cria transações antecipadamente.
 * Recorrências são apenas REGRAS de geração futura.
 * 
 * Transações reais são criadas APENAS pelo cronjob no dia do vencimento.
 * Isso garante que:
 * - Limite de cartão NÃO é consumido antecipadamente
 * - Saldos NÃO são afetados até a data de vencimento
 * - Sistema financeiro permanece previsível e consistente
 * 
 * Create a new recurring transaction (rule only, no transactions created)
 */
export async function createRecurringTransaction(
  input: CreateRecurringTransactionInput
) {
  // householdId must be provided (resolved in routes via ensurePersonalHousehold)
  if (!input.householdId) {
    throw new BadRequestError('householdId is required');
  }
  const householdId = input.householdId;

  const {
    accountId,
    categoryName,
    amount,
    description,
    frequency,
    startDate,
    endDate,
    nextRunAt,
    isActive,
    followLastAmount,
    competenceOffsetMonths,
    forecastStrategy,
    forecastWindow,
    dailyRate,
    safetyBusinessDays,
    nonWorkingDays,
    optionalHolidays,
    aliases,
    earlyDiscountDay,
    earlyDiscountType,
    earlyDiscountValue,
  } = input;

  assertForecastConsistent({ forecastStrategy, dailyRate: dailyRate ?? null, frequency });
  assertEarlyDiscountConsistent({ amount, day: earlyDiscountDay ?? null, type: earlyDiscountType ?? null, value: earlyDiscountValue ?? null });

  // Verify account belongs to household
  const account = await prisma.account.findFirst({
    where: { id: accountId, householdId, isActive: true },
  });

  if (!account) {
    throw new NotFoundError('Account');
  }

  // Validate custom category exists and belongs to household
  if (isCustomCategoryName(categoryName)) {
    const customId = toCustomCategoryId(categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const recurring = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
  await lockCustomCategory(tx, householdId, categoryName);
  return tx.recurringTransaction.create({
    data: {
      householdId,
      accountId,
      categoryName,
      amount: new Prisma.Decimal(amount),
      description,
      frequency,
      startDate,
      endDate,
      nextRunAt,
      isActive,
      // Only the LAST strategy follows the last confirmed value; the others ignore (and do not store) the flag
      followLastAmount: forecastStrategy === 'LAST' ? followLastAmount : false,
      competenceOffsetMonths: competenceOffsetMonths ?? null,
      forecastStrategy,
      forecastWindow: forecastWindow ?? null,
      dailyRate: dailyRate != null ? new Prisma.Decimal(dailyRate) : null,
      safetyBusinessDays,
      nonWorkingDays,
      optionalHolidays,
      aliases,
      earlyDiscountDay: earlyDiscountDay ?? null,
      earlyDiscountType: earlyDiscountType ?? null,
      earlyDiscountValue: earlyDiscountValue != null ? new Prisma.Decimal(earlyDiscountValue) : null,
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi criada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  // Isso resolve o caso onde o usuário cria uma recorrência depois do horário do cronjob (01:00)
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log(
          `[RecurringTransaction] ✅ Processed immediately after creation: ${recurring.id} - ` +
          `Date: ${today.toISOString().split('T')[0]} - Paid: ${shouldCreateAsPaid}`
        );
      }
    } catch (error) {
      // Não falhar a criação da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error(
        `[RecurringTransaction] ⚠️  Error processing immediately after creation: ${recurring.id}`,
        error
      );
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return plain(recurring);
}

/**
 * Date (YYYY-MM-DD) of the most recent occurrence of each recurrence that still counts as "the current one" (not beyond
 * today + 31 days, the rule of followLastAmountInTx). A client editing an occurrence knows only a page of transactions,
 * so it compares the edited date with this: `date >= lastOccurrenceDate` means it is the latest one.
 */
async function lastOccurrenceDates(householdId: string, recurringIds: string[], now: Date = new Date()): Promise<Map<string, string>> {
  const map = new Map<string, string>();
  if (recurringIds.length === 0) return map;
  const limit = plusDays(now, FOLLOW_LOOKAHEAD_DAYS);
  const rows = await prisma.transaction.groupBy({
    by: ['recurringTransactionId'],
    where: { householdId, recurringTransactionId: { in: recurringIds }, date: { lte: new Date(`${limit}T00:00:00.000Z`) } },
    _max: { date: true },
  });
  for (const r of rows) if (r.recurringTransactionId && r._max.date) map.set(r.recurringTransactionId, dayString(r._max.date));
  return map;
}

/**
 * Get recurring transaction by ID
 */
export async function getRecurringTransaction(recurringId: string) {
  const recurring = await prisma.recurringTransaction.findUnique({
    where: { id: recurringId },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return plain(recurring);
}

/**
 * List recurring transactions for a household
 */
export async function listRecurringTransactions(
  query: ListRecurringTransactionsQuery
) {
  const { householdId, isActive } = query;

  const recurring = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      ...(isActive !== undefined && { isActive }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: [{ isActive: 'desc' }, { nextRunAt: 'asc' }],
  });

  const last = await lastOccurrenceDates(householdId as string, recurring.map((r) => r.id));
  // What each recurrence expects for its next occurrence (CONSERVATIVE reads the confirmed history)
  // (two queries for the whole list, not two per recurrence)
  const batch = await forecastBatch(prisma, recurring);
  const forecasts = recurring.map((r) => batch.expected(r, referenceMonthOf(r.nextRunAt, r.competenceOffsetMonths)));
  const today = localTodayString();
  // Convert Prisma.Decimal to number for JSON serialization
  return recurring.map((r, i) => {
    // The discount of the next occurrence while it can still be had (absent otherwise): `amount` stays the full amount
    const earlyDiscount = earlyDiscountQuoteOf(r, forecasts[i]!.amount, dayString(r.nextRunAt), today);
    return {
      ...plain(r),
      lastOccurrenceDate: last.get(r.id) ?? null,
      forecast: forecasts[i],
      ...(earlyDiscount && { earlyDiscount }),
    };
  });
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Atualizar uma recorrência NÃO cria transações antecipadamente.
 * Apenas atualiza a REGRA de recorrência.
 * 
 * Transações reais continuam sendo criadas apenas pelo cronjob no dia do vencimento.
 * 
 * Update recurring transaction (rule only, no transactions created)
 */
export async function updateRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: UpdateRecurringTransactionInput
) {
  const existing = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!existing) {
    throw new NotFoundError('Recurring transaction');
  }

  // Validate new account if provided
  if (input.accountId && input.accountId !== existing.accountId) {
    const account = await prisma.account.findFirst({
      where: { id: input.accountId, householdId, isActive: true },
    });
    if (!account) {
      throw new NotFoundError('Account');
    }
  }

  // Validate custom category exists when updating categoryName
  if (input.categoryName && isCustomCategoryName(input.categoryName)) {
    const customId = toCustomCategoryId(input.categoryName)!;
    const cat = await prisma.category.findFirst({ where: { id: customId, householdId } });
    if (!cat) throw new BadRequestError('Custom category not found or does not belong to this household');
  }

  const mergedStrategy = input.forecastStrategy ?? normalizeStrategy(existing.forecastStrategy);
  assertForecastConsistent({
    forecastStrategy: mergedStrategy,
    dailyRate: input.dailyRate !== undefined ? input.dailyRate : existing.dailyRate?.toNumber() ?? null,
    frequency: input.frequency ?? existing.frequency,
  });
  // Early-payment discount: the merge of what was sent with what is stored must be all-or-none and fit the amount
  assertEarlyDiscountConsistent({
    amount: input.amount ?? existing.amount.toNumber(),
    day: input.earlyDiscountDay !== undefined ? input.earlyDiscountDay : existing.earlyDiscountDay ?? null,
    type: input.earlyDiscountType !== undefined ? input.earlyDiscountType : existing.earlyDiscountType ?? null,
    value: input.earlyDiscountValue !== undefined ? input.earlyDiscountValue : existing.earlyDiscountValue?.toNumber() ?? null,
  });

  const recurring = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
  await lockCustomCategory(tx, householdId, input.categoryName);
  return tx.recurringTransaction.update({
    where: { id: recurringId },
    data: {
      ...(input.accountId && { accountId: input.accountId }),
      ...(input.categoryName && { categoryName: input.categoryName }),
      ...(input.amount !== undefined && { amount: new Prisma.Decimal(input.amount) }),
      ...(input.description !== undefined && { description: input.description }),
      ...(input.frequency && { frequency: input.frequency }),
      ...(input.startDate && { startDate: input.startDate }),
      ...(input.endDate !== undefined && { endDate: input.endDate }),
      ...(input.nextRunAt && { nextRunAt: input.nextRunAt }),
      ...(input.isActive !== undefined && { isActive: input.isActive }),
      // Only the LAST strategy follows the last confirmed value: leaving it clears the flag
      ...(mergedStrategy !== 'LAST'
        ? { followLastAmount: false }
        : input.followLastAmount !== undefined && { followLastAmount: input.followLastAmount }),
      ...(input.competenceOffsetMonths !== undefined && { competenceOffsetMonths: input.competenceOffsetMonths }),
      ...(input.forecastStrategy !== undefined && { forecastStrategy: input.forecastStrategy }),
      ...(input.forecastWindow !== undefined && { forecastWindow: input.forecastWindow }),
      ...(input.dailyRate !== undefined && { dailyRate: input.dailyRate === null ? null : new Prisma.Decimal(input.dailyRate) }),
      ...(input.safetyBusinessDays !== undefined && { safetyBusinessDays: input.safetyBusinessDays }),
      ...(input.nonWorkingDays !== undefined && { nonWorkingDays: input.nonWorkingDays }),
      ...(input.optionalHolidays !== undefined && { optionalHolidays: input.optionalHolidays }),
      ...(input.aliases !== undefined && { aliases: input.aliases }),
      ...(input.earlyDiscountDay !== undefined && { earlyDiscountDay: input.earlyDiscountDay }),
      ...(input.earlyDiscountType !== undefined && { earlyDiscountType: input.earlyDiscountType }),
      ...(input.earlyDiscountValue !== undefined && { earlyDiscountValue: input.earlyDiscountValue === null ? null : new Prisma.Decimal(input.earlyDiscountValue) }),
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
  });
  });

  // REGRA DE NEGÓCIO: Edge case de timing
  // Se a recorrência foi atualizada com nextRunAt = hoje (ou no passado) e startDate <= hoje,
  // processar imediatamente para não esperar até o próximo cronjob
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  
  const nextRunAtDate = new Date(recurring.nextRunAt);
  nextRunAtDate.setHours(0, 0, 0, 0);
  
  const startDateNormalized = new Date(recurring.startDate);
  startDateNormalized.setHours(0, 0, 0, 0);
  
  const shouldProcessImmediately = 
    recurring.isActive && 
    nextRunAtDate <= today && 
    startDateNormalized <= today;

  if (shouldProcessImmediately) {
    try {
      // Verificar se já existe transação para hoje (idempotência)
      const existingTransaction = await prisma.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          date: today,
        },
      });

      if (!existingTransaction) {
        // Processar imediatamente
        const isCreditCard = recurring.account.type === AccountType.CREDIT;
        const shouldCreateAsPaid = isCreditCard;

        await executeRecurringTransaction(recurring.id, householdId, {
          date: today,
          paid: shouldCreateAsPaid,
        });

        console.log(
          `[RecurringTransaction] ✅ Processed immediately after update: ${recurring.id} - ` +
          `Date: ${today.toISOString().split('T')[0]} - Paid: ${shouldCreateAsPaid}`
        );
      }
    } catch (error) {
      // Não falhar a atualização da recorrência se o processamento imediato falhar
      // Log do erro mas continua
      console.error(
        `[RecurringTransaction] ⚠️  Error processing immediately after update: ${recurring.id}`,
        error
      );
    }
  }

  // Convert Prisma.Decimal to number for JSON serialization
  return plain(recurring);
}

/**
 * Delete recurring transaction
 */
export async function deleteRecurringTransaction(
  recurringId: string,
  householdId: string
) {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  await prisma.recurringTransaction.delete({
    where: { id: recurringId },
  });

  return { deleted: true };
}

/**
 * REGRA DE NEGÓCIO CRÍTICA:
 * Esta função é chamada APENAS pelo cronjob no dia do vencimento.
 * 
 * Cria uma transação REAL:
 * - Para cartão de crédito: paid: true (consome limite imediatamente)
 * - Para conta bancária: paid: false (pendente para revisão)
 * 
 * Atualiza lastRunDate e nextRunAt.
 *
 * O cronjob é o chamador normal, mas a rota /execute e `payNextOccurrence` (pagar antes pelo app) também passam por aqui,
 * para a regra do valor, do mês de referência e do avanço da recorrência ser uma só. Com `payNow` a ocorrência é a de
 * `nextRunAt` (valor previsto pela regra do desconto tomando HOJE como referência), nasce PAGA na data informada e a
 * recorrência avança a partir da ocorrência agendada, não da data do pagamento.
 */
export async function executeRecurringTransaction(
  recurringId: string,
  householdId: string,
  input: ExecuteRecurringTransactionInput = {},
  payNow?: { amount?: number; accountId?: string }
) {
  const recurring = await prisma.recurringTransaction.findFirst({
    where: { id: recurringId, householdId, isActive: true },
    include: {
      account: true,
    },
  });

  if (!recurring) {
    throw new NotFoundError('Recurring transaction');
  }

  const transactionDate = input.date || recurring.nextRunAt;
  // The occurrence being generated: the scheduled one (nextRunAt) when paying ahead, else the one dated like the transaction
  const occurrenceDate = payNow ? recurring.nextRunAt : transactionDate;
  const isPaid = payNow ? true : input.paid ?? false; // Default: false (pendente)

  // Paying ahead can use another account than the recurrence's (it must belong to the household)
  const payAccount =
    payNow?.accountId && payNow.accountId !== recurring.accountId
      ? await prisma.account.findFirst({ where: { id: payNow.accountId, householdId, isActive: true } })
      : recurring.account;
  if (!payAccount) throw new NotFoundError('Account');

  const anchorDay = anchorDayOf(recurring.startDate);

  const isIncome = await isIncomeCategory(prisma, householdId, recurring.categoryName);

  // The amount of the occurrence comes from one function (the extension point for forecast strategies). Its history is
  // the recurrence's last confirmed occurrences, read only when the strategy uses it.
  const history = await loadConfirmedHistory(prisma, recurring, isIncome);
  const fullAmount = expectedAmountFor(
    forecastInputOf(recurring, isIncome),
    history,
    // The month the occurrence counts for (its reference month), not the month of its date
    referenceMonthOf(occurrenceDate, recurring.competenceOffsetMonths),
  );
  // Early-payment discount: an occurrence generated up to the limit day of its month is born with the discounted amount;
  // generated later (the job runs on the due date, after the limit) it is the full amount. The recurrence keeps the full one.
  const occurrenceAmount =
    payNow?.amount !== undefined
      ? payNow.amount
      : amountOnDay(fullAmount, earlyDiscountOf(recurring), dayString(occurrenceDate), localTodayString());

  function calculateBalanceChange(amount: number, isInc: boolean, accountType: string): number {
    const isCreditCard = accountType === AccountType.CREDIT;
    if (isCreditCard) return isInc ? -amount : amount;
    return isInc ? amount : -amount;
  }

  // Determine transaction type. isIncome/transactionType are computed OUTSIDE the transaction from the category read above:
  // that stays valid when a merge re-points the recurrence meanwhile because a merge requires the same type (INCOME/EXPENSE).
  const transactionType = isIncome ? TransactionType.INCOME : TransactionType.EXPENSE;

  // Create the actual transaction and update next run date
  const result = await prisma.$transaction(async (tx: Prisma.TransactionClient) => {
    // The category read above may have been merged since: lock the custom category the recurrence points at NOW (a merge
    // holds it FOR UPDATE and re-points the recurrence), re-reading until the locked name is the stored one.
    let categoryName = recurring.categoryName;
    for (let attempt = 0; ; attempt++) {
      const fresh = await tx.recurringTransaction.findFirst({ where: { id: recurringId, householdId }, select: { categoryName: true } });
      if (!fresh) throw new NotFoundError('Recurring transaction');
      categoryName = fresh.categoryName;
      try {
        await lockCustomCategory(tx, householdId, categoryName);
      } catch (error) {
        // Only "category gone" (400) is retried after a re-read; any other failure (deadlock, connection...) propagates.
        // (AppError subclasses reset their prototype, so instanceof BadRequestError is false: the status code is the test.)
        if (!(error instanceof AppError && error.statusCode === 400) || attempt >= 2) throw error;
        continue;
      }
      const again = await tx.recurringTransaction.findFirst({ where: { id: recurringId, householdId }, select: { categoryName: true } });
      if (again?.categoryName === categoryName || attempt >= 2) break;
    }
    // Idempotency guard: a monthly recurrence has at most one occurrence per month. When the month already holds a
    // transaction of this recurrence (generated earlier, or taken over by an imported sheet row), nothing is created
    // and the recurrence just moves on. The check runs under a per-recurrence lock, so two executions (cron, manual,
    // sheet confirm) cannot both see an empty month.
    if (payNow) {
      // Paying ahead: under the same per-recurrence lock the job takes, the recurrence must still be where this call read
      // it (another payment or the job may have advanced it meanwhile) and its months must be free of an occurrence.
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring:${recurring.id}`}))`;
      const current = await tx.recurringTransaction.findFirst({ where: { id: recurringId, householdId }, select: { nextRunAt: true } });
      if (!current || dayString(current.nextRunAt) !== dayString(recurring.nextRunAt)) {
        throw new ConflictError('This occurrence was already generated or paid');
      }
      if (recurring.frequency === 'MONTHLY') {
        // Only the month of the occurrence being paid matters, not the month of the payment date: an occurrence of the
        // month is one dated in it OR one that refers to it (paid ahead, dated in another month)
        if (await monthHasOccurrence(tx, householdId, recurring.id, dayString(occurrenceDate), referenceMonthOf(occurrenceDate, recurring.competenceOffsetMonths))) {
          throw new ConflictError('This month already has an occurrence of the recurrence');
        }
      }
    }
    if (recurring.frequency === 'MONTHLY' && !payNow) {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`recurring:${recurring.id}`}))`;
      const { start, end } = monthBoundsUtc(dayString(transactionDate));
      // An occurrence paid ahead (dated in an earlier month, referring to this one) counts as this month's too
      const existing = await tx.transaction.findFirst({
        where: {
          householdId,
          recurringTransactionId: recurring.id,
          OR: [{ date: { gte: start, lt: end } }, { competenceMonth: referenceMonthOf(transactionDate, recurring.competenceOffsetMonths) }],
        },
        include: { account: { select: { id: true, name: true, type: true } } },
      });
      if (existing) {
        const nextRunAt = calculateNextRunDate(transactionDate, recurring.frequency, anchorDay);
        await tx.recurringTransaction.update({
          where: { id: recurringId },
          data: { lastRunDate: transactionDate, nextRunAt },
        });
        return { transaction: existing, nextRunAt, skipped: true as boolean };
      }

      // The month holds no occurrence of this recurrence, but an import may already have brought the charge (sheet,
      // card statement, notification) without the link. Adopt the oldest such row instead of creating a duplicate:
      // same household and account, same type, inside the month, unlinked, imported (has a sourceRef; a hand-typed
      // row is never taken), and a normalized description equal to the recurrence name or one of its aliases. The
      // amount is not a criterion and the row is not changed apart from the link. The link is conditional (still
      // unlinked): a writer that does not take this lock cannot be adopted twice, and the next candidate is tried.
      const names = recurrenceNameKeys(recurring.description, recurring.aliases);
      if (names.size > 0) {
        const candidates = await tx.transaction.findMany({
          where: {
            householdId,
            accountId: recurring.accountId,
            type: transactionType,
            recurringTransactionId: null,
            sourceRef: { not: null },
            date: { gte: start, lt: end },
          },
          orderBy: [{ date: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
          select: { id: true, description: true },
        });
        for (const candidate of candidates) {
          if (!names.has(normalizeDescription(candidate.description))) continue;
          const linked = await tx.transaction.updateMany({
            where: { id: candidate.id, householdId, recurringTransactionId: null },
            data: { recurringTransactionId: recurring.id },
          });
          if (linked.count !== 1) continue;
          const adopted = await tx.transaction.findFirst({
            where: { id: candidate.id, householdId },
            include: { account: { select: { id: true, name: true, type: true } } },
          });
          const nextRunAt = calculateNextRunDate(transactionDate, recurring.frequency, anchorDay);
          await tx.recurringTransaction.update({
            where: { id: recurringId },
            data: { lastRunDate: transactionDate, nextRunAt },
          });
          return { transaction: adopted!, nextRunAt, skipped: true as boolean };
        }
      }
    }

    // Create transaction
    const transaction = await tx.transaction.create({
      data: {
        householdId,
        type: transactionType,
        accountId: payAccount.id,
        categoryName,
        amount: new Prisma.Decimal(occurrenceAmount),
        description: recurring.description || `Recurring: ${categoryName}`,
        date: transactionDate,
        notes: `${payNow ? 'Paid ahead from' : 'Auto-generated from'} recurring transaction: ${recurring.id} on ${new Date().toISOString()}`,
        paid: isPaid,
        recurringTransactionId: recurring.id,
        // Reference month of the occurrence (a voucher paid on 25 Sep that refers to October): date month + offset
        ...(recurring.competenceOffsetMonths != null && {
          competenceMonth: addMonths(monthOfDate(occurrenceDate), recurring.competenceOffsetMonths),
        }),
        // Paid ahead in another month than the occurrence's: it refers to the occurrence's month, not to the payment's
        ...(payNow && recurring.competenceOffsetMonths == null && monthOfDate(transactionDate) !== monthOfDate(occurrenceDate) && {
          competenceMonth: monthOfDate(occurrenceDate),
        }),
      },
      include: {
        account: {
          select: { id: true, name: true, type: true },
        },
      },
    });

    // REGRA DE NEGÓCIO: Atualizar saldo APENAS se paid: true
    // Para cartão de crédito: consome limite imediatamente
    // Para conta bancária: saldo só é atualizado quando confirmada
    if (isPaid && payAccount) {
      const amount = occurrenceAmount;
      const balanceChange = calculateBalanceChange(amount, isIncome, payAccount.type);
      
      // Use centralized balance update function to ensure consistency
      await updateBalanceForNormalTransaction(tx, payAccount.id, balanceChange);
      
      // Recalculate credit card limit if it's a credit card
      if (payAccount.type === AccountType.CREDIT) {
        await recalculateCreditCardLimit(tx, payAccount.id);
      }
    }

    // Paying ahead follows the last amount by the same rule as editing the occurrence (a discounted payment keeps the full amount)
    if (payNow) {
      await followLastAmountInTx(tx, { id: transaction.id, householdId, recurringTransactionId: recurring.id, date: transactionDate, amount: occurrenceAmount }, { amount: occurrenceAmount });
    }

    // Calculate and update next run date
    const nextRunAt = calculateNextRunDate(occurrenceDate, recurring.frequency, anchorDay);

    // Update lastRunDate and nextRunAt
    await tx.recurringTransaction.update({
      where: { id: recurringId },
      data: { 
        lastRunDate: transactionDate,
        nextRunAt,
      },
    });

    return {
      transaction,
      nextRunAt,
      skipped: false as boolean,
    };
  });

  return result;
}

/**
 * True when the month of `occurrenceDay` already holds an occurrence of the recurrence: one dated in the month, or one
 * that refers to it by its competence month (an occurrence paid ahead is dated in an earlier month).
 */
async function monthHasOccurrence(tx: Prisma.TransactionClient, householdId: string, recurringId: string, occurrenceDay: string, referenceMonth: string): Promise<boolean> {
  const { start, end } = monthBoundsUtc(occurrenceDay);
  const found = await tx.transaction.findFirst({
    where: { householdId, recurringTransactionId: recurringId, OR: [{ date: { gte: start, lt: end } }, { competenceMonth: referenceMonth }] },
    select: { id: true },
  });
  return found !== null;
}

/**
 * "Pagar antes pelo app": creates NOW the occurrence of `nextRunAt`, already paid, and advances the recurrence as the job
 * would, so the job does not generate another one for that month at the due date. The amount is the one the discount
 * rule gives for today (discounted up to the limit day of the occurrence's month, full after), unless `amount` is given;
 * the date defaults to today and the account to the recurrence's. Refuses an inactive or ended recurrence, and a month
 * that already holds an occurrence, or an occurrence more than 31 days after the payment date (409), creating nothing.
 */
export async function payNextOccurrence(
  recurringId: string,
  householdId: string,
  input: { amount?: number; date?: Date; accountId?: string } = {},
) {
  const recurring = await prisma.recurringTransaction.findFirst({ where: { id: recurringId, householdId } });
  if (!recurring) throw new NotFoundError('Recurring transaction');
  if (!recurring.isActive) throw new BadRequestError('The recurring transaction is inactive');
  if (recurring.endDate && dayString(recurring.endDate) < dayString(recurring.nextRunAt)) {
    throw new BadRequestError('The recurring transaction has ended: there is no occurrence left to pay');
  }
  // Guard against a double tap: the occurrence must be at most 31 days after the payment date (the one the user means
  // is the nearest; the following one, a month later, is refused)
  const paymentDate = input.date ?? localDate(localTodayString());
  if (dayString(recurring.nextRunAt) > plusDays(paymentDate, FOLLOW_LOOKAHEAD_DAYS)) {
    throw new ConflictError('The next occurrence is more than a month ahead of the payment date');
  }
  return executeRecurringTransaction(recurringId, householdId, { date: paymentDate }, { amount: input.amount, accountId: input.accountId });
}

/**
 * Get recurring transactions that are due (nextRunAt <= today)
 */
export async function getDueRecurringTransactions(householdId: string) {
  const today = new Date();
  today.setHours(0, 0, 0, 0);

  const due = await prisma.recurringTransaction.findMany({
    where: {
      householdId,
      isActive: true,
      nextRunAt: {
        lte: today,
      },
    },
    include: {
      account: {
        select: { id: true, name: true, type: true },
      },
    },
    orderBy: { nextRunAt: 'asc' },
  });

  return due;
}

