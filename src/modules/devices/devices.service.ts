import { prisma } from '../../shared/db/prisma.js';
import { NotFoundError } from '../../shared/errors/index.js';
import { generateDeviceToken, hashDeviceToken } from './device-token.js';

// Never select tokenHash: it must not leave the service.
const publicSelect = {
  id: true,
  name: true,
  householdId: true,
  lastUsedAt: true,
  revokedAt: true,
  createdAt: true,
} as const;

/** Creates the device and returns the plain token, which exists only in this return value. */
export async function createDevice(input: { userId: string; householdId: string; name: string }) {
  const token = generateDeviceToken();
  const device = await prisma.deviceToken.create({
    data: { userId: input.userId, householdId: input.householdId, name: input.name, tokenHash: hashDeviceToken(token) },
    select: publicSelect,
  });
  return { ...device, token };
}

export async function listDevices(userId: string) {
  return prisma.deviceToken.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, select: publicSelect });
}

/** Revokes a device of the caller. Revoking twice keeps the first revocation time. Someone else's device is a 404. */
export async function revokeDevice(userId: string, id: string) {
  const device = await prisma.deviceToken.findFirst({ where: { id, userId }, select: { id: true, revokedAt: true } });
  if (!device) {
    throw new NotFoundError('Device');
  }
  if (!device.revokedAt) {
    await prisma.deviceToken.updateMany({ where: { id, userId, revokedAt: null }, data: { revokedAt: new Date() } });
  }
  return prisma.deviceToken.findFirstOrThrow({ where: { id, userId }, select: publicSelect });
}
