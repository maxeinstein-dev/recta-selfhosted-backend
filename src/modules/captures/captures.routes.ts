import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deviceAuthMiddleware, extractBearer, getDevice } from '../devices/device-auth.middleware.js';
import { hashDeviceToken } from '../devices/device-token.js';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  ensurePersonalHousehold,
  getUserByFirebaseUid,
  requireEditor,
  requireHouseholdMember,
} from '../../shared/middleware/authorization.middleware.js';
import {
  captureActionQuerySchema,
  captureIdParamSchema,
  confirmCaptureSchema,
  countCapturesQuerySchema,
  createCapturesSchema,
  listCapturesQuerySchema,
  replaceAccountRulesSchema,
} from './captures.schema.js';
import * as capturesService from './captures.service.js';

// A device posts in small bursts, so 120 requests a minute is far above real use and still bounds a leaked token.
// Keyed by the token hash (not the token) so every device has its own budget behind the same NAT/proxy; without a
// bearer it falls back to the IP. The limiter runs before authentication, so the key is only a bucket name.
export const capturesRateLimit = {
  rateLimit: {
    max: 120,
    timeWindow: '1 minute',
    keyGenerator: (request: FastifyRequest) => {
      const token = extractBearer(request);
      return token ? `device:${hashDeviceToken(token)}` : request.ip;
    },
  },
} as const;

const looseObject = { type: 'object', additionalProperties: true } as const;
const objectResponse = { type: 'object', properties: { success: { type: 'boolean' }, data: looseObject } } as const;
const jwtRoute = { tags: ['Captures'], security: [{ bearerAuth: [] }] } as const;

/** The household a drafts request works on: `householdId` when given, else the caller's personal one. */
async function resolveHousehold(request: FastifyRequest, householdId: string | undefined): Promise<string> {
  return householdId ?? (await ensurePersonalHousehold(request));
}

export async function captureRoutes(app: FastifyInstance) {
  /**
   * POST /captures
   * Intake of raw bank notifications from the Android app. Device token only (not the user JWT).
   * Household and user come from the token. Repeats are not errors: they answer `duplicate`.
   */
  app.post('/', {
    config: capturesRateLimit,
    preHandler: deviceAuthMiddleware(),
    schema: {
      description:
        'Store raw notification captures (1..50 per request). Authenticate with a device token (Bearer rdt_...). ' +
        'Idempotent: an item already stored for the household answers `duplicate`.',
      tags: ['Captures'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                results: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      dedupKey: { type: 'string' },
                      status: { type: 'string', enum: ['created', 'duplicate'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const device = getDevice(request);
    const { items } = createCapturesSchema.parse(request.body);

    const results = await capturesService.ingestCaptures(
      { householdId: device.householdId, userId: device.userId },
      items
    );
    return reply.status(200).send({ success: true, data: { results } });
  });

  // The routes below take the user's own login (never a device token) and work on one household. Fastify matches
  // the static paths (/count, /account-rules) before the parametric /:id/... ones, so they do not shadow each other.
  const jwt = { preHandler: authMiddleware() };

  /** GET /captures?status=&limit=&cursor=&householdId= : drafts, newest first. VIEWER may read. */
  app.get('/', {
    ...jwt,
    schema: {
      ...jwtRoute,
      description: 'List the household captures (default status PENDING), newest first, with a suggestion for each',
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: looseObject },
            pagination: { type: 'object', properties: { nextCursor: { type: ['string', 'null'] }, hasMore: { type: 'boolean' } } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listCapturesQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireHouseholdMember(request, householdId);
    const result = await capturesService.listCaptures(householdId, query);
    return reply.send({ success: true, ...result });
  });

  /** GET /captures/count?status= : for a menu badge. */
  app.get('/count', {
    ...jwt,
    schema: { ...jwtRoute, description: 'Count the household captures with a status (default PENDING)', response: { 200: objectResponse } },
  }, async (request, reply) => {
    const query = countCapturesQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireHouseholdMember(request, householdId);
    const count = await capturesService.countCaptures(householdId, query.status);
    return reply.send({ success: true, data: { count } });
  });

  /** GET /captures/account-rules : which account receives each (package, kind). */
  app.get('/account-rules', {
    ...jwt,
    schema: {
      ...jwtRoute,
      description: 'List the household capture account rules',
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: looseObject } } } },
    },
  }, async (request, reply) => {
    const query = captureActionQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireHouseholdMember(request, householdId);
    return reply.send({ success: true, data: await capturesService.listAccountRules(householdId) });
  });

  /** PUT /captures/account-rules : replace all rules at once (EDITOR+). */
  app.put('/account-rules', {
    ...jwt,
    schema: {
      ...jwtRoute,
      description: 'Replace all capture account rules of the household (EDITOR+). Duplicate (package, kind) is a 400; an account that is not an active account of the household is a 404.',
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: looseObject } } } },
    },
  }, async (request, reply) => {
    const query = captureActionQuerySchema.parse(request.query);
    const body = replaceAccountRulesSchema.parse(request.body);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireEditor(request, householdId);
    return reply.send({ success: true, data: await capturesService.replaceAccountRules(householdId, body.rules) });
  });

  /** POST /captures/:id/confirm : creates the transaction (201), or returns the existing one when already confirmed (200). */
  app.post('/:id/confirm', {
    ...jwt,
    schema: {
      ...jwtRoute,
      description: 'Confirm a PENDING capture as a transaction (EDITOR+). Idempotent: an already confirmed capture answers 200 with its transaction. DISMISSED/IGNORED, or a confirmed one whose transaction was deleted, answer 409.',
      response: { 200: objectResponse, 201: objectResponse },
    },
  }, async (request, reply) => {
    const { id } = captureIdParamSchema.parse(request.params);
    const query = captureActionQuerySchema.parse(request.query);
    const input = confirmCaptureSchema.parse(request.body);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireEditor(request, householdId);

    const result = await capturesService.confirmCapture({ householdId, userId: user.id }, id, input);
    return reply.status(result.created ? 201 : 200).send({
      success: true,
      data: { capture: result.capture, transaction: result.transaction },
    });
  });

  /** POST /captures/reparse : read the PENDING drafts again with the current parser (EDITOR+). */
  app.post('/reparse', {
    ...jwt,
    schema: {
      ...jwtRoute,
      description: 'Re-read the PENDING captures of the household with the current parser version (EDITOR+). Known informative notices become IGNORED; no transaction is created.',
      response: { 200: objectResponse },
    },
  }, async (request, reply) => {
    const query = captureActionQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireEditor(request, householdId);
    return reply.send({ success: true, data: await capturesService.reparseCaptures(householdId) });
  });

  /** POST /captures/:id/dismiss : PENDING -> DISMISSED (idempotent). */
  app.post('/:id/dismiss', {
    ...jwt,
    schema: { ...jwtRoute, description: 'Dismiss a PENDING capture (EDITOR+). Idempotent on DISMISSED; CONFIRMED answers 409.', response: { 200: objectResponse } },
  }, async (request, reply) => {
    const { id } = captureIdParamSchema.parse(request.params);
    const query = captureActionQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireEditor(request, householdId);
    return reply.send({ success: true, data: await capturesService.dismissCapture(householdId, id) });
  });

  /** POST /captures/:id/restore : DISMISSED -> PENDING. */
  app.post('/:id/restore', {
    ...jwt,
    schema: { ...jwtRoute, description: 'Restore a DISMISSED capture to PENDING (EDITOR+). Any other status answers 409.', response: { 200: objectResponse } },
  }, async (request, reply) => {
    const { id } = captureIdParamSchema.parse(request.params);
    const query = captureActionQuerySchema.parse(request.query);
    const householdId = await resolveHousehold(request, query.householdId);
    await requireEditor(request, householdId);
    return reply.send({ success: true, data: await capturesService.restoreCapture(householdId, id) });
  });
}
