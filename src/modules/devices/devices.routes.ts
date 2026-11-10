import type { FastifyInstance } from 'fastify';
import { authMiddleware, getAuthUser } from '../../shared/middleware/auth.middleware.js';
import {
  ensurePersonalHousehold,
  getUserByFirebaseUid,
  requireEditor,
} from '../../shared/middleware/authorization.middleware.js';
import { createDeviceSchema, deviceIdParamSchema } from './devices.schema.js';
import * as devicesService from './devices.service.js';

const objectResponse = {
  type: 'object',
  properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } },
} as const;

export async function deviceRoutes(app: FastifyInstance) {
  // Managing devices takes the user's own login; a device token cannot create or revoke devices.
  app.addHook('preHandler', authMiddleware());

  /**
   * POST /devices
   * Create a device token (EDITOR+ on the household). The plain token is returned once, here.
   */
  app.post('/', {
    schema: {
      description: 'Create a device token for the Android capture app (EDITOR+). The token is shown only in this response.',
      tags: ['Devices'],
      security: [{ bearerAuth: [] }],
      response: { 201: objectResponse },
    },
  }, async (request, reply) => {
    const input = createDeviceSchema.parse(request.body);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);

    const householdId = input.householdId || await ensurePersonalHousehold(request);
    await requireEditor(request, householdId);

    const device = await devicesService.createDevice({ userId: user.id, householdId, name: input.name });
    return reply.status(201).send({ success: true, data: device });
  });

  /**
   * GET /devices
   * The caller's devices (never the token or its hash).
   */
  app.get('/', {
    schema: {
      description: 'List the devices of the caller',
      tags: ['Devices'],
      security: [{ bearerAuth: [] }],
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const devices = await devicesService.listDevices(user.id);
    return reply.send({ success: true, data: devices });
  });

  /**
   * DELETE /devices/:id
   * Revoke one of the caller's devices (idempotent).
   */
  app.delete('/:id', {
    schema: {
      description: 'Revoke a device of the caller (idempotent)',
      tags: ['Devices'],
      security: [{ bearerAuth: [] }],
      response: { 200: objectResponse },
    },
  }, async (request, reply) => {
    const { id } = deviceIdParamSchema.parse(request.params);
    const authUser = getAuthUser(request);
    const user = await getUserByFirebaseUid(authUser.uid, authUser.email);
    const device = await devicesService.revokeDevice(user.id, id);
    return reply.send({ success: true, data: device });
  });
}
