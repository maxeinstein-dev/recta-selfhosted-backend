import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  requireEditor,
  getUserByFirebaseUid,
} from '../../shared/middleware/authorization.middleware.js';
import { BadRequestError } from '../../shared/errors/app-error.js';
import { getAccount } from '../accounts/accounts.service.js';
import {
  assertNotCardInvoice,
  parseImportBuffer,
  buildImportPreview,
  confirmImport,
} from './import.service.js';

// Error shape mirrors auth.routes.ts `errorResponseSchema`
// ({ success, error: { code, message } }) and the central error-handler output.
const errorResponseSchema = {
  type: 'object',
  properties: {
    success: { type: 'boolean' },
    error: {
      type: 'object',
      properties: {
        code: { type: 'string' },
        message: { type: 'string' },
      },
    },
  },
} as const;

const previewRowSchema = {
  type: 'object',
  properties: {
    index: { type: 'number' },
    date: { type: 'string', format: 'date-time' },
    description: { type: 'string' },
    amount: { type: 'number' },
    type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
    duplicate: { type: 'boolean' },
  },
} as const;

const confirmImportBodySchema = z.object({
  accountId: z.string().uuid(),
  rows: z.array(
    z.object({
      date: z.coerce.date(),
      description: z.string().min(1),
      amount: z.number().positive(),
      type: z.enum(['INCOME', 'EXPENSE']),
    }),
  ),
});

export async function importRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /transactions/import/preview — multipart/form-data ONLY.
   * Fields: `accountId` (uuid text field) + `file` (.ofx or .csv, max 5MB).
   * Parses the statement and flags duplicates without persisting anything.
   */
  app.post('/import/preview', {
    schema: {
      description:
        'Preview a bank statement import (multipart/form-data only: text field `accountId` + file field `file` with a .ofx or .csv file, max 5MB). Returns parsed rows flagged as duplicate/new. A credit card invoice OFX (CCSTMTRS) sent to a CREDIT account answers 400 pointing to POST /transactions/import/card-ofx/preview. Requires EDITOR+ on the account household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      consumes: ['multipart/form-data'],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                rows: { type: 'array', items: previewRowSchema },
                total: { type: 'number' },
                duplicateCount: { type: 'number' },
                newCount: { type: 'number' },
              },
            },
          },
        },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    let accountIdRaw: unknown;
    let filename = 'upload';
    let buffer: Buffer | null = null;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        // First file part wins; must be consumed so the request stream drains.
        if (!buffer) {
          filename = part.filename ?? 'upload';
          buffer = await part.toBuffer();
        } else {
          await part.toBuffer();
        }
      } else if (part.fieldname === 'accountId') {
        accountIdRaw = part.value;
      }
    }

    const accountId = z.string().uuid().parse(accountIdRaw);

    if (!buffer) {
      throw new BadRequestError(
        'A statement file (.ofx or .csv) is required in the "file" field.',
      );
    }

    // Fetch account first to resolve the household for authorization.
    const account = await getAccount(accountId);
    await requireEditor(request, account.householdId);

    // A card invoice on a card goes to the card importer, which reconciles instead of duplicating.
    assertNotCardInvoice(account.type, filename, buffer);

    const rows = parseImportBuffer(filename, buffer);
    const preview = await buildImportPreview(accountId, account.householdId, rows);

    return reply.send({ success: true, data: preview });
  });

  /**
   * POST /transactions/import/confirm — application/json ONLY.
   * Body: { accountId, rows: [{ date, description, amount, type }] }.
   * Persists non-duplicate rows (duplicates are re-checked and skipped).
   */
  app.post('/import/confirm', {
    schema: {
      description:
        'Confirm a bank statement import (application/json only: { accountId, rows: [{ date, description, amount, type }] }). Re-validates duplicates at write time; duplicates are skipped. Requires EDITOR+ on the account household.',
      tags: ['Transactions'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        required: ['accountId', 'rows'],
        properties: {
          accountId: { type: 'string', format: 'uuid' },
          rows: {
            type: 'array',
            items: {
              type: 'object',
              required: ['date', 'description', 'amount', 'type'],
              properties: {
                date: { type: 'string', format: 'date-time' },
                description: { type: 'string' },
                amount: { type: 'number' },
                type: { type: 'string', enum: ['INCOME', 'EXPENSE'] },
              },
            },
          },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                imported: { type: 'number' },
                skipped: { type: 'number' },
                ids: { type: 'array', items: { type: 'string', format: 'uuid' } },
              },
            },
          },
        },
        400: errorResponseSchema,
        403: errorResponseSchema,
        404: errorResponseSchema,
      },
    },
  }, async (request, reply) => {
    const input = confirmImportBodySchema.parse(request.body);

    // Fetch account first to resolve the household for authorization.
    const account = await getAccount(input.accountId);
    await requireEditor(request, account.householdId);

    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const result = await confirmImport(
      account.id,
      account.householdId,
      input.rows,
      user.id,
    );

    return reply.status(201).send({ success: true, data: result });
  });
}
