import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireEditor,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { CategoryName } from '../../shared/enums/index.js';
import {
  buildMaxFinPreview,
  confirmMaxFinImport,
  resolveMaxFinAccounts,
} from './maxfin-import.service.js';

// Error shape mirrors import.routes.ts / auth.routes.ts and the central error handler.
const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
        details: { type: 'object', additionalProperties: true },
      },
    },
  },
} as const;

const okResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    data: { type: 'object', additionalProperties: true },
  },
} as const;

const uuid = z.string().uuid();

export const maxfinAccountsSchema = z.object({
  income: uuid,
  bills: uuid,
  credit: uuid,
  debit: uuid,
});

export const maxfinMonthSchema = z.object({
  year: z.number().int().min(2000).max(2100),
  month: z.number().int().min(1).max(12),
});

export const maxfinPreviewOptionsSchema = z.object({
  closedMonth: z.boolean().optional(),
  payInvoice: z.boolean().optional(),
  generateFutureInstallments: z.boolean().optional(),
  monthOverride: maxfinMonthSchema.optional(),
});

const importOptionsSchema = z.object({
  closedMonth: z.boolean(),
  payInvoice: z.boolean(),
  generateFutureInstallments: z.boolean(),
});

const sectionSchema = z.enum(['income', 'bills', 'credit', 'debit']);
const typeSchema = z.enum(['INCOME', 'EXPENSE']);

const installmentSchema = z
  .object({
    number: z.number().int().min(1).max(99),
    total: z.number().int().min(1).max(99),
    prepaid: z.number().int().min(0).max(99),
    baseDescription: z.string().max(255),
    installmentId: z.string().regex(/^maxfin:[a-z0-9-]*:\d{1,2}$/).max(120),
    futureCount: z.number().int().min(0).max(99),
  })
  .nullable();

const categoryTargetSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('system'), categoryName: z.nativeEnum(CategoryName) }),
  z.object({ kind: z.literal('custom'), categoryId: uuid }),
  z.object({ kind: z.literal('create'), name: z.string().trim().min(1).max(100) }),
  z.object({ kind: z.literal('default') }),
]);

export const maxfinConfirmBodySchema = z.object({
  month: maxfinMonthSchema,
  accounts: maxfinAccountsSchema,
  options: importOptionsSchema,
  categoryMap: z
    .array(z.object({ key: z.string().max(200), type: typeSchema, target: categoryTargetSchema }))
    .max(200),
  rows: z
    .array(
      z.object({
        sourceRef: z.string().min(1).max(120),
        section: sectionSchema,
        type: typeSchema,
        description: z.string().min(1).max(255),
        categoryKey: z.string().max(200),
        amount: z.number().positive().max(1_000_000_000),
        paid: z.boolean(),
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
        notes: z.string().max(1000).nullable(),
        installment: installmentSchema,
        replace: z.boolean().optional(),
      }),
    )
    .min(1)
    .max(500),
});

function parseJsonField(name: string, raw: unknown): unknown {
  if (raw === undefined || raw === null || raw === '') return undefined;
  if (typeof raw !== 'string') return raw;
  try {
    return JSON.parse(raw);
  } catch {
    throw new BadRequestError(`Field "${name}" must be a JSON string.`);
  }
}

export async function maxfinImportRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /transactions/import/maxfin/preview — multipart/form-data ONLY.
   * Fields: `file` (.csv, max 5MB), `accounts` (JSON: {income, bills, credit, debit}),
   * `options` (JSON, optional: closedMonth, payInvoice, generateFutureInstallments, monthOverride).
   * Parses the monthly sheet, classifies rows against stored transactions and suggests a category map.
   * Nothing is persisted.
   */
  app.post('/import/maxfin/preview', {
    schema: {
      description:
        'Preview a MaxFin monthly-sheet import (multipart/form-data: file field `file` (.csv, max 5MB) + text fields `accounts` (JSON {income,bills,credit,debit} account ids) and optional `options` (JSON)). Returns rows with status new/duplicate/changed/replaces-future/legacy-duplicate, section totals, category suggestions and the invoice payment that confirm would record (`invoice.alreadyPaid` tells when the payment of that month already exists). Requires EDITOR+ on the accounts household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      response: {
        200: okResponseSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    let accountsRaw: unknown;
    let optionsRaw: unknown;
    let filename = 'upload.csv';
    let buffer: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        // First file part wins; others must still be consumed so the stream drains.
        if (!buffer) {
          filename = part.filename ?? 'upload.csv';
          buffer = await part.toBuffer();
        } else {
          await part.toBuffer();
        }
      } else if (part.fieldname === 'accounts') {
        accountsRaw = part.value;
      } else if (part.fieldname === 'options') {
        optionsRaw = part.value;
      }
    }

    if (!buffer) {
      throw new BadRequestError('A .csv file is required in the "file" field.');
    }
    if (!filename.toLowerCase().endsWith('.csv')) {
      throw new BadRequestError('Only .csv files are accepted by the MaxFin importer (XLSX support is planned).');
    }

    const accounts = maxfinAccountsSchema.parse(parseJsonField('accounts', accountsRaw));
    const options = maxfinPreviewOptionsSchema.parse(parseJsonField('options', optionsRaw) ?? {});

    // Authorization runs inside the resolution, for every household involved, before any mixed-selection error.
    const resolved = await resolveMaxFinAccounts(accounts, (householdId) => requireEditor(request, householdId));

    const preview = await buildMaxFinPreview({ filename, buffer, accounts, options, resolved });
    return reply.send({ success: true, data: preview });
  });

  /**
   * POST /transactions/import/maxfin/confirm — application/json ONLY.
   * Body: MaxFinConfirmRequest (month, accounts, options, categoryMap, rows).
   * Creates the custom categories, the transactions (skipping rows already imported unless
   * `replace` is set), the future installments and the closed-month invoice payment.
   */
  app.post('/import/maxfin/confirm', {
    schema: {
      description:
        'Confirm a MaxFin monthly-sheet import (application/json: { month, accounts, options, categoryMap, rows }). Rows already imported (same sourceRef) and rows that supersede generated future installments (status replaces-future) are skipped unless `replace` is true. Creates requested custom categories, future installments (open month) and the invoice payment (closed month). Requires EDITOR+ on the accounts household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['month', 'accounts', 'options', 'categoryMap', 'rows'],
        properties: {
          month: { type: 'object', additionalProperties: true },
          accounts: { type: 'object', additionalProperties: true },
          options: { type: 'object', additionalProperties: true },
          categoryMap: { type: 'array', items: { type: 'object', additionalProperties: true } },
          rows: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      response: {
        201: okResponseSchema,
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const input = maxfinConfirmBodySchema.parse(request.body);

    const resolved = await resolveMaxFinAccounts(input.accounts, (householdId) => requireEditor(request, householdId));

    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const result = await confirmMaxFinImport({ request: input, userId: user.id, resolved });
    return reply.status(201).send({ success: true, data: result });
  });
}
