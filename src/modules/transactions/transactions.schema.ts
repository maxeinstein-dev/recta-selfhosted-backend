import { z } from 'zod';
import { paginationSchema, monthFilterSchema } from '../../shared/utils/pagination.js';
import { CategoryName, TransactionType } from '../../shared/enums/index.js';
import { localDateSchema } from '../../shared/utils/dateSchema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';
import { COMPETENCE_MONTH_RE } from '../../shared/utils/competence.js';

/** Reference month 'YYYY-MM' (a calendar month, 01..12). */
export const competenceMonthSchema = z.string().regex(COMPETENCE_MONTH_RE, 'competenceMonth must be in YYYY-MM format');

/**
 * Transaction split input (for expense sharing)
 */
export const transactionSplitInputSchema = z.object({
  userId: z.string().uuid(),
  amount: z.coerce.number().positive('Split amount must be positive'),
  accountId: z.string().uuid().optional(), // Account to pay from (optional, will be auto-selected if not provided)
});

export type TransactionSplitInput = z.infer<typeof transactionSplitInputSchema>;

/**
 * Create transaction request
 */
// Helper to preprocess UUID fields: convert empty string or null to undefined
const uuidOrEmpty = z.preprocess(
  (val) => (val === '' || val === null || val === undefined ? undefined : val),
  z.string().uuid().optional()
);

export const createTransactionSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  type: z.nativeEnum(TransactionType).optional(), // Optional - will be inferred from category if not provided
  accountId: uuidOrEmpty, // Optional for TRANSFER/ALLOCATION, required for INCOME/EXPENSE
  categoryName: categoryNameSchema.optional(), // Optional for TRANSFER/ALLOCATION, required for INCOME/EXPENSE. Enum or "CUSTOM:uuid"
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero'),
  description: z.string().max(255).optional(),
  date: localDateSchema,
  notes: z.string().max(1000).optional(),
  paid: z.boolean().default(true),
  // Transfer fields
  fromAccountId: uuidOrEmpty, // Required for TRANSFER
  toAccountId: uuidOrEmpty, // Required for TRANSFER
  // Allocation fields
  relatedEntityId: uuidOrEmpty, // Required for ALLOCATION (credit card ID)
  recurringTransactionId: uuidOrEmpty,
  installmentId: z.string().optional(),
  installmentNumber: z.number().int().positive().optional(),
  totalInstallments: z.number().int().positive().optional(),
  attachmentUrl: z.string().max(500).optional(), // Pode ser URL ou identificador técnico (ex: invoice_pay:xxx:xxx)
  sourceRef: z.string().max(120).optional(), // Identificador de origem de importação (dedup exata / reimportação idempotente)
  competenceMonth: competenceMonthSchema.nullish(), // Mês de referência (INCOME/EXPENSE); null/omitido = mês da data
  // Split expense fields (only for EXPENSE transactions in shared households)
  isSplit: z.boolean().optional().default(false),
  splits: z.array(transactionSplitInputSchema).optional(), // Array of splits when isSplit is true
}).refine((data) => {
  // If type is TRANSFER, fromAccountId and toAccountId are required
  if (data.type === TransactionType.TRANSFER) {
    return !!data.fromAccountId && !!data.toAccountId;
  }
  // If type is ALLOCATION, accountId and relatedEntityId are required
  if (data.type === TransactionType.ALLOCATION) {
    return !!data.accountId && !!data.relatedEntityId;
  }
  // If type is INCOME or EXPENSE, accountId and categoryName are required
  if (data.type === TransactionType.INCOME || data.type === TransactionType.EXPENSE) {
    return !!data.accountId && !!data.categoryName;
  }
  // If type is not specified, assume INCOME/EXPENSE and require accountId and categoryName
  return !!data.accountId && !!data.categoryName;
}, {
  message: 'Invalid combination of fields for transaction type',
}).refine((data) => {
  // A reference month belongs to income/expense rows; transfers and allocations are cash moves
  if (data.competenceMonth && (data.type === TransactionType.TRANSFER || data.type === TransactionType.ALLOCATION)) return false;
  return true;
}, {
  message: 'competenceMonth only applies to INCOME and EXPENSE transactions',
  path: ['competenceMonth'],
}).refine((data) => {
  // If isSplit is true, splits array must be provided and not empty
  if (data.isSplit === true) {
    if (!data.splits || data.splits.length === 0) {
      return false;
    }
    // Validate that splits only apply to EXPENSE transactions
    // Cannot split TRANSFER, ALLOCATION, or INCOME
    if (data.type === TransactionType.TRANSFER || data.type === TransactionType.ALLOCATION || data.type === TransactionType.INCOME) {
      return false;
    }
    // If type is not specified, check categoryName to infer type (expense categories)
    const expenseCategories: CategoryName[] = [
      CategoryName.FOOD, CategoryName.TRANSPORTATION, CategoryName.HOUSING, CategoryName.HEALTHCARE,
      CategoryName.EDUCATION, CategoryName.ENTERTAINMENT, CategoryName.CLOTHING, CategoryName.UTILITIES,
      CategoryName.SUBSCRIPTIONS, CategoryName.ONLINE_SHOPPING, CategoryName.GROCERIES,
      CategoryName.RESTAURANT, CategoryName.FUEL, CategoryName.PHARMACY, CategoryName.OTHER_EXPENSES
    ];
    if (!data.type && data.categoryName) {
      // Custom categories require type to be set; system: must be expense
      if (typeof data.categoryName === 'string' && data.categoryName.startsWith('CUSTOM:')) return false;
      if (!expenseCategories.includes(data.categoryName as CategoryName)) return false;
    }
    // Validate that sum of splits equals transaction amount (with small tolerance for rounding)
    if (data.splits) {
      const totalSplits = data.splits.reduce((sum, split) => sum + split.amount, 0);
      const tolerance = 0.01; // 1 cent tolerance for rounding
      return Math.abs(totalSplits - Math.abs(data.amount)) <= tolerance;
    }
  }
  return true;
}, {
  message: 'Splits must be provided when isSplit is true, must sum to transaction amount, and only apply to EXPENSE transactions',
  path: ['splits'],
});

export type CreateTransactionInput = z.infer<typeof createTransactionSchema>;

/**
 * Update transaction request
 */
export const updateTransactionSchema = z.object({
  accountId: z.string().uuid().optional(),
  categoryName: categoryNameSchema.optional(),
  type: z.nativeEnum(TransactionType).optional(), // Allow changing transaction type (INCOME/EXPENSE)
  amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero').optional(),
  description: z.string().max(255).optional(),
  date: z.coerce.date().optional(),
  notes: z.string().max(1000).nullable().optional(),
  paid: z.boolean().optional(),
  recurringTransactionId: z.string().uuid().nullable().optional(),
  installmentId: z.string().nullable().optional(),
  installmentNumber: z.number().int().positive().nullable().optional(),
  totalInstallments: z.number().int().positive().nullable().optional(),
  attachmentUrl: z.string().max(500).nullable().optional(), // Pode ser URL ou identificador técnico (ex: invoice_pay:xxx:xxx)
  competenceMonth: competenceMonthSchema.nullable().optional(), // Mês de referência; null limpa (volta ao mês da data)
});

export type UpdateTransactionInput = z.infer<typeof updateTransactionSchema>;

/**
 * Transaction ID param
 */
export const transactionIdParamSchema = z.object({
  transactionId: z.string().uuid(),
});

export type TransactionIdParam = z.infer<typeof transactionIdParamSchema>;

/**
 * List transactions query
 */
export const listTransactionsQuerySchema = paginationSchema
  .merge(monthFilterSchema)
  .extend({
    householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
    accountId: z.string().uuid().optional(),
    categoryName: categoryNameSchema.optional(),
    type: z.nativeEnum(TransactionType).optional(), // Now supports TRANSFER and ALLOCATION
    startDate: localDateSchema.optional(),
    endDate: localDateSchema.optional(),
    // Inclusive range of planning months ('YYYY-MM'): rows whose reference month (else the month of the date) is in it
    monthFrom: competenceMonthSchema.optional(),
    monthTo: competenceMonthSchema.optional(),
    search: z.string().max(100).optional(),
    // paid=false lists the pending ones (forecasts waiting to be confirmed); paid=true the settled ones
    paid: z.enum(['true', 'false']).transform((v) => v === 'true').optional(),
  })
  .refine((q) => !(q.month && (q.monthFrom || q.monthTo)), {
    message: 'Use either month or monthFrom/monthTo, not both',
    path: ['month'],
  })
  .refine((q) => !(q.monthFrom && q.monthTo && q.monthFrom > q.monthTo), {
    message: 'monthFrom must not be after monthTo',
    path: ['monthFrom'],
  });

export type ListTransactionsQuery = z.infer<typeof listTransactionsQuerySchema>;

/**
 * Transaction summary query
 */
export const transactionSummaryQuerySchema = monthFilterSchema.extend({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  startDate: z.coerce.date().optional(),
  endDate: z.coerce.date().optional(),
});

export type TransactionSummaryQuery = z.infer<typeof transactionSummaryQuerySchema>;

/**
 * Batch create transactions
 */
export const batchCreateTransactionsSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will create personal household if not provided
  transactions: z.array(
    z.object({
      accountId: z.string().uuid(),
      categoryName: categoryNameSchema,
      amount: z.coerce.number().refine((val) => val !== 0, 'Amount cannot be zero'),
      description: z.string().max(255).optional(),
      date: localDateSchema,
      notes: z.string().max(1000).optional(),
      paid: z.boolean().default(true),
      recurringTransactionId: z.string().uuid().optional(),
      installmentId: z.string().optional(),
      installmentNumber: z.number().int().positive().optional(),
      totalInstallments: z.number().int().positive().optional(),
      sourceRef: z.string().max(120).optional(), // Identificador de origem de importação
    })
  ).min(1).max(100),
});

export type BatchCreateTransactionsInput = z.infer<typeof batchCreateTransactionsSchema>;

/**
 * Batch delete transactions
 */
export const batchDeleteTransactionsSchema = z.object({
  householdId: z.string().uuid(),
  transactionIds: z.array(z.string().uuid()).min(1).max(100),
});

export type BatchDeleteTransactionsInput = z.infer<typeof batchDeleteTransactionsSchema>;

/**
 * Pay credit card invoice request
 */
export const payInvoiceSchema = z.object({
  accountId: z.string().uuid().optional(), // Credit card account ID (from params)
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  sourceAccountId: z.string().uuid(), // Conta bancária que vai pagar
  amount: z.coerce.number().positive().optional(), // Valor a pagar (opcional, se não fornecido usa o total da fatura)
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in format YYYY-MM'), // "YYYY-MM"
  description: z.string().max(255).optional(),
  paymentDate: localDateSchema.optional(), // Data do lançamento de pagamento (default: hoje). Usado por importações de meses fechados.
});

export type PayInvoiceInput = z.infer<typeof payInvoiceSchema>;

/**
 * Credit card account ID and month params
 */
export const creditCardInvoiceParamsSchema = z.object({
  accountId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in format YYYY-MM'),
});

export type CreditCardInvoiceParams = z.infer<typeof creditCardInvoiceParamsSchema>;

/**
 * Undo payment params
 */
export const undoPaymentParamsSchema = z.object({
  accountId: z.string().uuid(),
  transactionId: z.string().uuid(),
});

export type UndoPaymentParams = z.infer<typeof undoPaymentParamsSchema>;

/**
 * Create transfer request
 */
export const createTransferSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  fromAccountId: z.string().uuid(),
  toAccountId: z.string().uuid(),
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
  date: localDateSchema,
  notes: z.string().max(1000).optional(),
});

export type CreateTransferInput = z.infer<typeof createTransferSchema>;

/**
 * Create allocation request
 */
export const createAllocationSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  accountId: z.string().uuid(), // Source account (bank account)
  creditCardId: z.string().uuid(), // Credit card to allocate to
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
  date: localDateSchema,
  notes: z.string().max(1000).optional(),
});

export type CreateAllocationInput = z.infer<typeof createAllocationSchema>;

/**
 * Create deallocation request
 */
export const createDeallocationSchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  accountId: z.string().uuid(), // Source account (bank account)
  creditCardId: z.string().uuid(), // Credit card to deallocate from
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
  date: localDateSchema,
  notes: z.string().max(1000).optional(),
});

export type CreateDeallocationInput = z.infer<typeof createDeallocationSchema>;

/**
 * Monthly recap query
 */
export const monthlyRecapQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in format YYYY-MM').optional(), // Optional, defaults to current month
});

export type MonthlyRecapQuery = z.infer<typeof monthlyRecapQuerySchema>;

/**
 * Heatmap query - get daily spending for a month
 */
export const heatmapQuerySchema = z.object({
  householdId: z.string().uuid().optional(), // Optional - will use personal household if not provided
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in format YYYY-MM').optional(), // Optional, defaults to current month
});

export type HeatmapQuery = z.infer<typeof heatmapQuerySchema>;



