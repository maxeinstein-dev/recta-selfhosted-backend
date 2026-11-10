import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deviceAuthMiddleware, extractBearer, getDevice } from '../devices/device-auth.middleware.js';
import { hashDeviceToken } from '../devices/device-token.js';
import { createCapturesSchema } from './captures.schema.js';
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
}
