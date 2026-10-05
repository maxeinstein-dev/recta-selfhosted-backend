import { prisma } from '../../shared/db/prisma.js';
import { BadRequestError, ConflictError, NotFoundError } from '../../shared/errors/app-error.js';
import { CategoryName, CategoryType, TransactionType, getCategoriesByType } from '../../shared/enums/index.js';
import { isCustomCategoryName, toCustomCategoryId } from '../../shared/utils/categoryHelpers.js';
import { parseLocalDateString, storedDateString } from '../transactions/maxfin-import.helpers.js';
import { createTransaction, deleteTransaction } from '../transactions/transactions.service.js';
import { conflictOnUnique, decimalFromCents } from './people.common.js';
import type { CreateSettlementInput } from './people.schema.js';
import type { SettlementDirection, SettlementDto } from './people.types.js';
import { findPersonOrThrow } from './people.service.js';
import { fromCents, storedToCents, toCents } from './money.js';

interface SettlementRow {
  id: string;
  personId: string;
  direction: SettlementDirection;
  amount: { toNumber(): number };
  date: Date;
  transactionId: string | null;
  note: string | null;
}

function toDto(row: SettlementRow): SettlementDto {
  return {
    id: row.id,
    personId: row.personId,
    direction: row.direction,
    amount: fromCents(storedToCents(row.amount)),
    date: storedDateString(row.date),
    transactionId: row.transactionId,
    note: row.note,
  };
}

/** The transaction type a settlement of this direction is: what they paid me is an income, what I paid them an expense. */
export function settlementTransactionType(direction: SettlementDirection): 'INCOME' | 'EXPENSE' {
  return direction === 'RECEIVED' ? 'INCOME' : 'EXPENSE';
}

/** Household that owns a settlement, to authorize routes keyed by the settlement id alone; null when there is none. */
export async function findSettlementHousehold(settlementId: string): Promise<string | null> {
  const settlement = await prisma.settlement.findFirst({ where: { id: settlementId }, select: { householdId: true } });
  return settlement?.householdId ?? null;
}

export async function listSettlements(householdId: string, personId: string): Promise<SettlementDto[]> {
  await findPersonOrThrow(prisma, householdId, personId);
  const rows = await prisma.settlement.findMany({
    where: { householdId, personId },
    orderBy: [{ date: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
  });
  return rows.map(toDto);
}

/** Category of the transaction a settlement creates: the one asked for if it fits the type, else the generic one. */
async function resolveCategory(householdId: string, type: 'INCOME' | 'EXPENSE', requested: string | undefined): Promise<string> {
  const categoryType = type === 'INCOME' ? CategoryType.INCOME : CategoryType.EXPENSE;
  if (requested === undefined) return type === 'INCOME' ? CategoryName.OTHER_INCOME : CategoryName.OTHER_EXPENSES;
  if (isCustomCategoryName(requested)) {
    const category = await prisma.category.findFirst({
      where: { id: toCustomCategoryId(requested)!, householdId, type },
      select: { id: true },
    });
    if (!category) throw new BadRequestError(`Custom category not found for ${type.toLowerCase()} transactions in this household`);
    return requested;
  }
  if (!getCategoriesByType(categoryType).includes(requested as CategoryName)) {
    throw new BadRequestError(`Category ${requested} is not an ${type.toLowerCase()} category`);
  }
  return requested;
}

/**
 * Registers money that changed hands with a person.
 *
 * - `transactionId`: links an existing transaction (an income for RECEIVED, an expense for PAID) that no other
 *   settlement uses.
 * - `createTransaction`: creates the real transaction on the account through the transactions service, so the
 *   account balance stays coherent, and links it. If the settlement cannot be saved afterwards, the transaction is
 *   removed again (balance included).
 * - neither: only the settlement is recorded.
 */
export async function createSettlement(
  householdId: string,
  personId: string,
  input: CreateSettlementInput,
): Promise<SettlementDto> {
  const person = await findPersonOrThrow(prisma, householdId, personId);
  const amountCents = toCents(input.amount);
  if (amountCents < 1) throw new BadRequestError('Amount must be at least 0.01');
  const date = parseLocalDateString(input.date);
  const type = settlementTransactionType(input.direction);
  const linkedMessage = 'That transaction is already linked to a settlement';

  let transactionId: string | null = null;
  let createdTransactionId: string | null = null;

  if (input.transactionId) {
    const transaction = await prisma.transaction.findFirst({
      where: { id: input.transactionId, householdId },
      select: { id: true, type: true },
    });
    if (!transaction) throw new NotFoundError('Transaction');
    if (transaction.type !== type) {
      throw new BadRequestError(
        `A ${input.direction === 'RECEIVED' ? 'received' : 'paid'} settlement links an ${type.toLowerCase()} transaction`,
      );
    }
    if (await prisma.settlement.findFirst({ where: { transactionId: transaction.id }, select: { id: true } })) {
      throw new ConflictError(linkedMessage);
    }
    transactionId = transaction.id;
  } else if (input.createTransaction) {
    const categoryName = await resolveCategory(householdId, type, input.createTransaction.categoryName);
    const created = await createTransaction({
      householdId,
      accountId: input.createTransaction.accountId,
      type: type === 'INCOME' ? TransactionType.INCOME : TransactionType.EXPENSE,
      categoryName,
      amount: fromCents(amountCents),
      description:
        input.createTransaction.description ??
        (input.direction === 'RECEIVED' ? `Acerto recebido de ${person.name}` : `Acerto pago a ${person.name}`),
      date,
      ...(input.note ? { notes: input.note.slice(0, 1000) } : {}),
      paid: true,
      isSplit: false,
    });
    transactionId = created.id;
    createdTransactionId = created.id;
  }

  try {
    const row = await conflictOnUnique(linkedMessage, () =>
      prisma.settlement.create({
        data: {
          householdId,
          personId,
          direction: input.direction,
          amount: decimalFromCents(amountCents),
          date,
          transactionId,
          note: input.note ? input.note : null,
        },
      }),
    );
    return toDto(row);
  } catch (error) {
    if (createdTransactionId) {
      // The settlement was not saved: do not leave a stray transaction (and its effect on the account) behind.
      try {
        await deleteTransaction(createdTransactionId, householdId);
      } catch (cleanup) {
        console.error('[createSettlement] Could not remove the transaction of a failed settlement:', cleanup);
      }
    }
    throw error;
  }
}

/** Deletes the settlement; the transaction it was linked to (or created) stays. */
export async function deleteSettlement(householdId: string, settlementId: string): Promise<void> {
  const settlement = await prisma.settlement.findFirst({ where: { id: settlementId, householdId }, select: { id: true } });
  if (!settlement) throw new NotFoundError('Settlement');
  await prisma.settlement.delete({ where: { id: settlementId } });
}
