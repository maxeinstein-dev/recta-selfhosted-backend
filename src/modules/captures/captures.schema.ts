import { z } from 'zod';
import { localDateSchema } from '../../shared/utils/dateSchema.js';
import { categoryNameSchema } from '../categories/categories.schema.js';
import { competenceMonthSchema } from '../transactions/transactions.schema.js';

export const MAX_CAPTURE_ITEMS = 50;

// Postgres text cannot store U+0000; a body can carry it as the JSON escape \u0000, so it is refused here with a 400
// instead of surfacing as a 500 from the insert.
const noNul = (value: string) => !value.includes('\u0000');
const NUL_MESSAGE = 'Must not contain NUL characters';

export const captureItemSchema = z.object({
  package: z.string().min(1, 'package is required').max(150).refine(noNul, NUL_MESSAGE),
  title: z.string().max(300).refine(noNul, NUL_MESSAGE).nullish(),
  text: z.string().min(1, 'text is required').max(2000).refine(noNul, NUL_MESSAGE),
  // ISO 8601 with a zone ("2026-11-09T14:03:21.000Z" or "...-03:00"): a local time without zone is ambiguous.
  postedAt: z.string().datetime({ offset: true }),
});

export const createCapturesSchema = z.object({
  items: z.array(captureItemSchema).min(1, 'At least one item').max(MAX_CAPTURE_ITEMS, `At most ${MAX_CAPTURE_ITEMS} items`),
});

export type CaptureItemInput = z.infer<typeof captureItemSchema>;
export type CreateCapturesInput = z.infer<typeof createCapturesSchema>;

// ---------------------------------------------------------------------------------------------------------------
// Drafts: the web app lists captures, confirms them as transactions, dismisses them and maps apps to accounts.
// ---------------------------------------------------------------------------------------------------------------

export const CAPTURE_STATUSES = ['PENDING', 'CONFIRMED', 'DISMISSED', 'IGNORED'] as const;
export const CAPTURE_KINDS = ['CARD_PURCHASE', 'PIX_OUT', 'PIX_IN', 'REFUND', 'SAVINGS_MOVE'] as const;
export const MAX_ACCOUNT_RULES = 100;

export type CaptureStatusValue = (typeof CAPTURE_STATUSES)[number];
export type CaptureKind = (typeof CAPTURE_KINDS)[number];

const householdQuery = { householdId: z.string().uuid().optional() }; // omitted: the personal household

export const captureIdParamSchema = z.object({ id: z.string().uuid() });

export const listCapturesQuerySchema = z.object({
  ...householdQuery,
  status: z.enum(CAPTURE_STATUSES).default('PENDING'),
  cursor: z.string().uuid().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(20),
});

export const countCapturesQuerySchema = z.object({
  ...householdQuery,
  status: z.enum(CAPTURE_STATUSES).default('PENDING'),
});

export const captureActionQuerySchema = z.object(householdQuery);

/**
 * What the client may correct when it confirms a capture. A subset of createTransactionSchema on purpose: only plain
 * INCOME/EXPENSE rows (no transfers, allocations, splits, recurrences, installments) and no sourceRef, which the
 * server sets from the capture. Unknown keys are a 400 instead of being dropped, so nothing the user typed is lost.
 */
export const confirmCaptureSchema = z.object({
  type: z.enum(['INCOME', 'EXPENSE']).optional(),
  accountId: z.string().uuid(),
  categoryName: categoryNameSchema,
  amount: z.coerce.number().positive('Amount must be positive'),
  description: z.string().max(255).optional(),
  date: localDateSchema,
  notes: z.string().max(1000).optional(),
  paid: z.boolean().default(true),
  competenceMonth: competenceMonthSchema.nullish(),
}).strict();

export const accountRuleSchema = z.object({
  package: z.string().min(1, 'package is required').max(150).refine(noNul, NUL_MESSAGE),
  kind: z.enum(CAPTURE_KINDS),
  accountId: z.string().uuid(),
}).strict();

export const replaceAccountRulesSchema = z.object({
  rules: z.array(accountRuleSchema).max(MAX_ACCOUNT_RULES, `At most ${MAX_ACCOUNT_RULES} rules`),
}).strict().superRefine((body, ctx) => {
  const seen = new Set<string>();
  body.rules.forEach((rule, index) => {
    const key = JSON.stringify([rule.package, rule.kind]);
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['rules', index], message: `Duplicate rule for package "${rule.package}" and kind ${rule.kind}` });
    }
    seen.add(key);
  });
});

export type ConfirmCaptureInput = z.infer<typeof confirmCaptureSchema>;
export type AccountRuleInput = z.infer<typeof accountRuleSchema>;

// Card-ending rules: the account of the purchases of one card (the four digits the notification carries).
export const CARD_LAST4_PATTERN = /^\d{4}$/;

export const cardRuleSchema = z.object({
  package: z.string().min(1, 'package is required').max(150).refine(noNul, NUL_MESSAGE),
  cardLast4: z.string().regex(CARD_LAST4_PATTERN, 'cardLast4 must be the last four digits of the card'),
  accountId: z.string().uuid(),
}).strict();

export const replaceCardRulesSchema = z.object({
  rules: z.array(cardRuleSchema).max(MAX_ACCOUNT_RULES, `At most ${MAX_ACCOUNT_RULES} rules`),
}).strict().superRefine((body, ctx) => {
  const seen = new Set<string>();
  body.rules.forEach((rule, index) => {
    const key = JSON.stringify([rule.package, rule.cardLast4]);
    if (seen.has(key)) {
      ctx.addIssue({ code: 'custom', path: ['rules', index], message: `Duplicate rule for package "${rule.package}" and card ending ${rule.cardLast4}` });
    }
    seen.add(key);
  });
});

export type CardRuleInput = z.infer<typeof cardRuleSchema>;
