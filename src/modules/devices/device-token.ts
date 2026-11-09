import { createHash, randomBytes } from 'node:crypto';

/** Prefix of every device token: lets the JWT middleware refuse them early and secret scanners spot them. */
export const DEVICE_TOKEN_PREFIX = 'rdt_';

/** `rdt_` + 32 random bytes in base64url (43 characters). Anything else cannot be a device token. */
const DEVICE_TOKEN_SHAPE = /^rdt_[A-Za-z0-9_-]{43}$/;

export function generateDeviceToken(): string {
  return DEVICE_TOKEN_PREFIX + randomBytes(32).toString('base64url');
}

export function isDeviceTokenShape(token: string): boolean {
  return DEVICE_TOKEN_SHAPE.test(token);
}

/** SHA-256 hex (64 chars): the only form of the token that is stored. The token is high-entropy, so no salt/KDF. */
export function hashDeviceToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}
