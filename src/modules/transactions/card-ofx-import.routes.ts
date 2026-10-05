import type { FastifyInstance, FastifyRequest } from 'fastify';
import { z } from 'zod';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireEditor,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import {
  MAX_CARD_OFX_LINES,
  buildCardOfxPreview,
  confirmCardOfxImport,
  resolveCardAccount,
} from './card-ofx-import.service.js';
import { MAX_REVIEW_ACTIONS, MAX_REVIEW_LIMIT, applyReviewActions, listReviewQueue } from './card-ofx-review.service.js';
import { categoryTargetSchema, maxfinMonthSchema, parseJsonField } from './maxfin-import.routes.js';
import { MAX_GROUP_ID_LENGTH } from './ofx-reconcile.js';
import { MAX_CARD_OFX_AMOUNT, MAX_CARD_OFX_FITID_LENGTH } from './parsers/ofx-card.parser.js';

// Error shape mirrors the other import routes and the central error handler.
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

const typeSchema = z.enum(['INCOME', 'EXPENSE']);

export const cardOfxOptionsSchema = z.object({
  monthOverride: maxfinMonthSchema.optional(),
});

const cardOfxLineSchema = z.object({
  ref: z.string().min(1).max(120),
  fitid: z.string().min(1).max(MAX_CARD_OFX_FITID_LENGTH),
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'date must be YYYY-MM-DD'),
  amount: z.number().positive().max(MAX_CARD_OFX_AMOUNT),
  type: typeSchema,
  kind: z.enum(['purchase', 'refund', 'discount', 'payment']),
  memo: z.string().min(1).max(255),
  merchant: z.string().min(1).max(255),
  installment: z
    .object({ number: z.number().int().min(1).max(99), total: z.number().int().min(1).max(99) })
    .nullable(),
});

export const cardOfxConfirmBodySchema = z.object({
  accountId: z.string().uuid(),
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'monthKey must be YYYY-MM'),
  lines: z.array(cardOfxLineSchema).min(1).max(MAX_CARD_OFX_LINES),
  // A group id is kind|sorted refs|target and a proposal covers at most MAX_GROUP_REFS lines.
  selectedGroups: z.array(z.string().min(1).max(MAX_GROUP_ID_LENGTH)).max(MAX_CARD_OFX_LINES),
  categoryMap: z
    .array(z.object({ key: z.string().max(255), type: typeSchema, target: categoryTargetSchema }))
    .max(MAX_CARD_OFX_LINES),
  payment: z
    .object({ apply: z.boolean(), sourceAccountId: z.string().uuid().optional() })
    .nullable(),
});

export const cardOfxReviewQuerySchema = z.object({
  accountId: z.string().uuid(),
  monthKey: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'monthKey must be YYYY-MM').optional(),
  limit: z.coerce.number().int().min(1).max(MAX_REVIEW_LIMIT).optional(),
  view: z.enum(['queue', 'kept']).optional(),
});

export const cardOfxReviewActionsSchema = z.object({
  accountId: z.string().uuid(),
  actions: z
    .array(
      z.object({
        transactionId: z.string().uuid(),
        action: z.enum(['keep', 'unkeep', 'move', 'delete']),
        targetAccountId: z.string().uuid().optional(),
      }),
    )
    .min(1)
    .max(MAX_REVIEW_ACTIONS),
});

interface CardOfxUpload {
  filename: string | undefined;
  buffer: Buffer | null;
  accountIdRaw: unknown;
  optionsRaw: unknown;
}

/** Reads the multipart body of a preview: the first `file` part, `accountId` and `options`. */
async function readCardOfxUpload(request: FastifyRequest): Promise<CardOfxUpload> {
  const upload: CardOfxUpload = { filename: undefined, buffer: null, accountIdRaw: undefined, optionsRaw: undefined };
  for await (const part of request.parts()) {
    if (part.type === 'file') {
      // First file part wins; others must still be consumed so the stream drains.
      if (!upload.buffer) {
        upload.filename = part.filename ?? undefined;
        upload.buffer = await part.toBuffer();
      } else {
        await part.toBuffer();
      }
    } else if (part.fieldname === 'accountId') {
      upload.accountIdRaw = part.value;
    } else if (part.fieldname === 'options') {
      upload.optionsRaw = part.value;
    }
  }
  return upload;
}

export async function cardOfxImportRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /transactions/import/card-ofx/preview — multipart/form-data ONLY.
   * Fields: `file` (.ofx card invoice, max 5MB), `accountId` (the card), `options` (JSON, optional: monthOverride).
   * Reconciles the invoice with what the card stores. Nothing is persisted.
   */
  app.post('/import/card-ofx/preview', {
    schema: {
      description:
        'Preview a credit card invoice OFX import (multipart/form-data: file field `file` (.ofx, max 5MB) + text fields `accountId` (the credit card) and optional `options` (JSON { monthOverride?: { year, month } })). Returns the invoice month (due month, from DTEND and the card due/closing days unless overridden), every OFX line with its status (reconciled, proposed, payment) and group, the reconciliation proposals (enrich-exact, enrich-plan, enrich-sum, enrich-merge, enrich-neighbour, enrich-group, enrich-near, consume-future, create, reversal), the sheet rows left without a line, the previous invoice payment proposal (ok, adjust, create) and the category map of the new purchases. Requires EDITOR+ on the card household.',
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
    const { filename = 'upload.ofx', buffer, accountIdRaw, optionsRaw } = await readCardOfxUpload(request);

    if (!buffer) {
      throw new BadRequestError('A card invoice (.ofx) is required in the "file" field.');
    }
    if (!filename.toLowerCase().endsWith('.ofx')) {
      throw new BadRequestError('Only .ofx card invoices are accepted here.');
    }

    const accountId = z.string().uuid().parse(accountIdRaw);
    const options = cardOfxOptionsSchema.parse(parseJsonField('options', optionsRaw) ?? {});

    // Authorization runs on the card's household before the account type is checked or the file is read.
    const account = await resolveCardAccount(accountId, (householdId) => requireEditor(request, householdId));

    const preview = await buildCardOfxPreview({ account, buffer, options });
    return reply.send({ success: true, data: preview });
  });

  /**
   * POST /transactions/import/card-ofx/confirm — application/json ONLY.
   * Body: { accountId, monthKey, lines, selectedGroups, categoryMap, payment }.
   * Recomputes the reconciliation and applies the selected groups that still exist.
   */
  app.post('/import/card-ofx/confirm', {
    schema: {
      description:
        'Confirm a credit card invoice OFX import (application/json: { accountId, monthKey, lines (the preview lines, up to 1000, in the preview order), selectedGroups, categoryMap, payment: null | { apply, sourceAccountId? } }). The server validates the lines against their own content, recomputes the reconciliation with what is stored now and applies only the selected groups that still exist (the others count as skipped): enrich the sheet rows, consume the stored future installments, create the new purchases (with their future installments in months without sheet rows) and the reversal pairs, and adjust or record the previous invoice payment. Every OFX ref used is recorded, so a re-import shows everything reconciled. Requires EDITOR+ on the card household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['accountId', 'monthKey', 'lines', 'selectedGroups', 'categoryMap', 'payment'],
        properties: {
          accountId: { type: 'string' },
          monthKey: { type: 'string' },
          lines: { type: 'array', items: { type: 'object', additionalProperties: true } },
          selectedGroups: { type: 'array', items: { type: 'string' } },
          categoryMap: { type: 'array', items: { type: 'object', additionalProperties: true } },
          payment: { type: ['object', 'null'], additionalProperties: true },
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
    const input = cardOfxConfirmBodySchema.parse(request.body);

    const account = await resolveCardAccount(input.accountId, (householdId) => requireEditor(request, householdId));

    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const result = await confirmCardOfxImport({ request: input, account, userId: user.id });
    return reply.status(201).send({ success: true, data: result });
  });

  /**
   * GET /transactions/import/card-ofx/review-queue — card sheet rows that found no bank line in a statement already
   * imported for their month. Read-only.
   */
  app.get('/import/card-ofx/review-queue', {
    schema: {
      description:
        'Review queue of a credit card: sheet rows with no bank counterpart in months whose OFX statement was imported (rows tied to an OFX line, merged or already reviewed are not listed). Query: accountId (the card), optional monthKey (YYYY-MM), limit (default 200, max 500) and view (queue, default, or kept: rows already marked without receipt). Requires EDITOR+ on the card household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      response: { 200: okResponseSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const query = cardOfxReviewQuerySchema.parse(request.query);
    const account = await resolveCardAccount(query.accountId, (householdId) => requireEditor(request, householdId));
    const queue = await listReviewQueue({ account, monthKey: query.monthKey, limit: query.limit, view: query.view });
    return reply.send({ success: true, data: queue });
  });

  /**
   * POST /transactions/import/card-ofx/review-queue/actions — keep ("sem comprovante"), move to another account, or
   * delete rows of the queue. Idempotent: rows no longer in the queue are reported as skipped.
   */
  app.post('/import/card-ofx/review-queue/actions', {
    schema: {
      description:
        'Apply review decisions to rows of the card review queue (application/json: { accountId, actions: [{ transactionId, action: keep | unkeep | move | delete, targetAccountId? }] }, up to 200). The request is partial, row by row: each result is done, skipped, blocked or failed, and one failing row does not stop the others. keep marks the row as reviewed without receipt and unkeep takes the mark away; move sends it to another non-card account of the household (the row is claimed first, balances and the card limit are updated once; moving a paid expense debits the destination now and moving a credit adds to it); delete removes it and registers a tombstone so re-importing the workbook does not bring it back. Rows not in the queue (already handled) are skipped; rows with shares, splits, settlements, recurrences or attachments refuse move and delete. Requires EDITOR+ on the card household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['accountId', 'actions'],
        properties: {
          accountId: { type: 'string' },
          actions: { type: 'array', items: { type: 'object', additionalProperties: true } },
        },
      },
      response: { 200: okResponseSchema, 400: errorResponseSchema, 403: errorResponseSchema, 404: errorResponseSchema },
    },
  }, async (request, reply) => {
    const input = cardOfxReviewActionsSchema.parse(request.body);
    const account = await resolveCardAccount(input.accountId, (householdId) => requireEditor(request, householdId));
    const result = await applyReviewActions({ account, actions: input.actions });
    return reply.send({ success: true, data: result });
  });
}
