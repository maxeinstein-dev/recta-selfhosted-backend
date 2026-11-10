import type { FastifyReply, FastifyRequest } from 'fastify';
import type { HouseholdRole } from '../../generated/prisma/client.js';
import { prisma } from '../../shared/db/prisma.js';
import { ForbiddenError, UnauthorizedError } from '../../shared/errors/index.js';
import { hashDeviceToken, isDeviceTokenShape } from './device-token.js';

/** Who a request authenticated with a device token acts as. Household and user come from the token, never the body. */
export interface DeviceAuth {
  deviceId: string;
  userId: string;
  householdId: string;
  role: HouseholdRole;
}

declare module 'fastify' {
  interface FastifyRequest {
    device?: DeviceAuth;
  }
}

/** `last_used_at` is refreshed at most this often per token, so a busy device does not write on every request. */
export const LAST_USED_REFRESH_MS = 60_000;

export function extractBearer(request: Pick<FastifyRequest, 'headers'>): string | null {
  const header = request.headers.authorization;
  if (!header) return null;
  const [scheme, token, ...rest] = header.split(' ');
  if (scheme?.toLowerCase() !== 'bearer' || !token || rest.length > 0) return null;
  return token;
}

/**
 * preHandler for the routes a device may call (today only POST /captures). Accepts `Authorization: Bearer rdt_...`
 * and nothing else: a user JWT or Firebase token fails the shape check without a database round trip.
 *  - 401: missing, malformed, unknown or revoked token.
 *  - 403: the token's user is no longer an EDITOR or OWNER of the token's household.
 */
export function deviceAuthMiddleware() {
  return async function authenticateDevice(request: FastifyRequest, _reply: FastifyReply): Promise<void> {
    const token = extractBearer(request);
    if (!token || !isDeviceTokenShape(token)) {
      throw new UnauthorizedError('Device token required');
    }

    // The lookup is by the hash (unique index): there is nothing to compare in application code.
    const device = await prisma.deviceToken.findUnique({ where: { tokenHash: hashDeviceToken(token) } });
    if (!device || device.revokedAt) {
      throw new UnauthorizedError('Invalid or revoked device token');
    }

    const membership = await prisma.householdMember.findUnique({
      where: { householdId_userId: { householdId: device.householdId, userId: device.userId } },
    });
    if (!membership || membership.role === 'VIEWER') {
      throw new ForbiddenError('The device owner can no longer add data to this household');
    }

    const now = Date.now();
    if (!device.lastUsedAt || now - device.lastUsedAt.getTime() >= LAST_USED_REFRESH_MS) {
      try {
        // The condition makes concurrent requests write once; a failure here must not reject the capture.
        await prisma.deviceToken.updateMany({
          where: {
            id: device.id,
            OR: [{ lastUsedAt: null }, { lastUsedAt: { lt: new Date(now - LAST_USED_REFRESH_MS) } }],
          },
          data: { lastUsedAt: new Date(now) },
        });
      } catch (error) {
        request.log.warn({ error }, 'Could not refresh device last_used_at');
      }
    }

    request.device = {
      deviceId: device.id,
      userId: device.userId,
      householdId: device.householdId,
      role: membership.role,
    };
  };
}

export function getDevice(request: FastifyRequest): DeviceAuth {
  if (!request.device) {
    throw new UnauthorizedError('Device authentication required');
  }
  return request.device;
}
