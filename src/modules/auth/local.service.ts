import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { z } from 'zod';
import { prisma } from '../../shared/db/prisma.js';
import { env } from '../../shared/config/env.js';
import {
  ConflictError,
  InvalidTokenError,
  UnauthorizedError,
  ValidationError,
} from '../../shared/errors/index.js';

const credentialsSchema = z.object({
  email: z.string().email('Invalid email address'),
  password: z.string().min(8, 'Password must be at least 8 characters'),
});

export interface LocalJwtPayload {
  sub: string;
  email: string;
}

function requireJwtSecret(): string {
  const secret = env.AUTH_JWT_SECRET;
  if (!secret) {
    throw new Error('AUTH_JWT_SECRET is required when AUTH_MODE=local');
  }
  return secret;
}

export function signJwt(userId: string, email: string): string {
  return jwt.sign({ sub: userId, email }, requireJwtSecret(), {
    expiresIn: env.AUTH_TOKEN_TTL_HOURS * 3600,
  });
}

export function verifyJwt(token: string): LocalJwtPayload {
  let decoded: unknown;
  try {
    decoded = jwt.verify(token, requireJwtSecret());
  } catch {
    throw new InvalidTokenError();
  }

  const parsed = z
    .object({ sub: z.string().min(1), email: z.string().email() })
    .safeParse(decoded);

  if (!parsed.success) {
    throw new InvalidTokenError();
  }

  return { sub: parsed.data.sub, email: parsed.data.email };
}

export async function register(email: string, password: string) {
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) {
    throw new ValidationError('Validation failed', parsed.error.flatten().fieldErrors);
  }

  const existing = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });
  if (existing) {
    throw new ConflictError('Email already registered');
  }

  const passwordHash = await bcrypt.hash(parsed.data.password, 12);

  const user = await prisma.user.create({
    data: {
      email: parsed.data.email,
      passwordHash,
      firebaseUid: null,
      emailVerified: false,
    },
  });

  const { passwordHash: _omitted, ...safeUser } = user;
  return safeUser;
}

export async function login(email: string, password: string) {
  const parsed = credentialsSchema.safeParse({ email, password });
  if (!parsed.success) {
    throw new UnauthorizedError('Invalid credentials');
  }

  const user = await prisma.user.findUnique({
    where: { email: parsed.data.email },
  });

  const hash = user?.passwordHash;
  const matches = hash ? await bcrypt.compare(parsed.data.password, hash) : false;

  if (!user || !matches) {
    throw new UnauthorizedError('Invalid credentials');
  }

  const token = signJwt(user.id, user.email);
  const { passwordHash: _omitted, ...safeUser } = user;
  return { user: safeUser, token };
}
