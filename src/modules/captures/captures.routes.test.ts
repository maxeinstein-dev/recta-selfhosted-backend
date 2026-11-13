import Fastify, { type FastifyInstance } from 'fastify';
import rateLimit from '@fastify/rate-limit';
import { createHash } from 'node:crypto';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  env: { AUTH_MODE: 'local', AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_TOKEN_TTL_HOURS: 1, AUTH_ALLOW_REGISTRATION: true, AUTH_FIREBASE_WEB_API_KEY: undefined as string | undefined },
  isLocalAuth: true,
  isProduction: false,
}));

type DeviceRow = {
  id: string; userId: string; householdId: string; name: string; tokenHash: string;
  lastUsedAt: Date | null; revokedAt: Date | null; createdAt: Date;
};
type CaptureRow = { householdId: string; userId: string; dedupKey: string; [k: string]: unknown };

// A small in-memory stand-in for the three tables the routes touch.
const store = vi.hoisted(() => ({
  devices: [] as DeviceRow[],
  captures: [] as CaptureRow[],
  members: new Map<string, string>(), // `${householdId}:${userId}` -> role
  userUpdates: 0,
  personalHousehold: { id: '' },
}));

const matches = (row: Record<string, unknown>, where: Record<string, unknown>): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Record<string, unknown>[]).some((c) => matches(row, c));
    const value = row[key];
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('lt' in cond) return value instanceof Date && value.getTime() < (cond as { lt: Date }).lt.getTime();
      return false;
    }
    return value === cond;
  });

const pick = (row: Record<string, unknown>, select?: Record<string, boolean>) =>
  select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };

vi.mock('../../shared/config/env.js', () => config);
vi.mock('../../shared/db/prisma.js', () => ({
  prisma: {
    user: {
      findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, email: 'ana@example.com', firebaseUid: null })),
    },
    household: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    householdMember: {
      findUnique: vi.fn(async ({ where }: { where: { householdId_userId: { householdId: string; userId: string } } }) => {
        const { householdId, userId } = where.householdId_userId;
        const role = store.members.get(`${householdId}:${userId}`);
        return role ? { id: 'm1', householdId, userId, role } : null;
      }),
    },
    deviceToken: {
      create: vi.fn(async ({ data, select }: { data: Partial<DeviceRow>; select?: Record<string, boolean> }) => {
        const row = { id: `00000000-0000-4000-8000-${String(store.devices.length + 1).padStart(12, '0')}`, lastUsedAt: null, revokedAt: null, createdAt: new Date(), ...data } as DeviceRow;
        store.devices.push(row);
        return pick(row, select);
      }),
      findMany: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) =>
        store.devices.filter((d) => matches(d, where)).map((d) => pick(d, select))),
      findFirst: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = store.devices.find((d) => matches(d, where));
        return row ? pick(row, select) : null;
      }),
      findFirstOrThrow: vi.fn(async ({ where, select }: { where: Record<string, unknown>; select?: Record<string, boolean> }) => {
        const row = store.devices.find((d) => matches(d, where))!;
        return pick(row, select);
      }),
      findUnique: vi.fn(async ({ where }: { where: { tokenHash: string } }) => store.devices.find((d) => d.tokenHash === where.tokenHash) ?? null),
      updateMany: vi.fn(async ({ where, data }: { where: Record<string, unknown>; data: Partial<DeviceRow> }) => {
        const rows = store.devices.filter((d) => matches(d, where));
        rows.forEach((d) => Object.assign(d, data));
        if ('lastUsedAt' in data) store.userUpdates += rows.length;
        return { count: rows.length };
      }),
    },
    capturedNotification: {
      createManyAndReturn: vi.fn(async ({ data }: { data: CaptureRow[] }) => {
        const created: CaptureRow[] = [];
        for (const row of data) {
          if (store.captures.some((c) => c.householdId === row.householdId && c.dedupKey === row.dedupKey)) continue;
          store.captures.push(row);
          created.push(row);
        }
        return created.map((r) => ({ dedupKey: r.dedupKey }));
      }),
    },
  },
}));
vi.mock('../households/households.service.js', () => ({
  getOrCreatePersonalHousehold: vi.fn(async () => store.personalHousehold),
}));
vi.mock('../../shared/config/firebase.js', () => ({
  getFirebaseAuth: () => ({ verifyIdToken: vi.fn().mockRejectedValue(new Error('not a Firebase token')) }),
}));

const { deviceRoutes } = await import('../devices/index.js');
const { captureRoutes, capturesRateLimit } = await import('./index.js');
const { generateDeviceToken, hashDeviceToken } = await import('../devices/index.js');
const { computeDedupKey } = await import('./captures.service.js');
const { PARSER_VERSION } = await import('./parsers/index.js');
const { errorHandler } = await import('../../shared/errors/error-handler.js');
const { signJwt } = await import('../auth/local.service.js');
const { authRoutes } = await import('../auth/index.js');

const USER_ID = '6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11';
const OTHER_USER_ID = '7a2d2f1f-9b5a-4d64-8d17-4a1b2e2d3c22';
const PERSONAL_ID = 'bb9d2a52-0f0e-4a3e-a0f5-6d6a1b2c3d4e';
const SHARED_ID = 'cc0e3b63-1a1f-4b4f-b1a6-7e7b2c3d4e5f';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(authRoutes, { prefix: '/auth' });
  await app.register(deviceRoutes, { prefix: '/devices' });
  await app.register(captureRoutes, { prefix: '/captures' });
});
afterAll(() => app.close());

beforeEach(() => {
  store.devices.length = 0;
  store.captures.length = 0;
  store.members.clear();
  store.userUpdates = 0;
  store.personalHousehold = { id: PERSONAL_ID };
  store.members.set(`${PERSONAL_ID}:${USER_ID}`, 'OWNER');
  store.members.set(`${SHARED_ID}:${USER_ID}`, 'EDITOR');
  vi.clearAllMocks();
});

const userJwt = (id = USER_ID) => ({ authorization: `Bearer ${signJwt(id, 'ana@example.com')}` });
const deviceAuth = (token: string) => ({ authorization: `Bearer ${token}` });
const item = (over: Record<string, unknown> = {}) => ({
  package: 'com.example.bank',
  title: 'Compra aprovada',
  text: 'Compra de R$ 10,00 em LOJA TESTE',
  postedAt: '2026-11-09T14:03:21.000Z',
  ...over,
});

async function createDevice(payload: Record<string, unknown> = { name: 'Pixel de teste' }, headers = userJwt()) {
  return app.inject({ method: 'POST', url: '/devices', headers, payload });
}
async function newToken(payload: Record<string, unknown> = { name: 'Pixel de teste' }): Promise<string> {
  const res = await createDevice(payload);
  expect(res.statusCode).toBe(201);
  return res.json().data.token as string;
}
const post = (token: string, payload: unknown) =>
  app.inject({ method: 'POST', url: '/captures', headers: deviceAuth(token), payload: payload as object });

describe('POST /devices', () => {
  it('returns the plain token once and stores only its SHA-256, in the personal household by default', async () => {
    const res = await createDevice();

    expect(res.statusCode).toBe(201);
    const { data } = res.json();
    expect(data.token).toMatch(/^rdt_[A-Za-z0-9_-]{43}$/);
    expect(data).toMatchObject({ name: 'Pixel de teste', householdId: PERSONAL_ID, lastUsedAt: null, revokedAt: null });
    expect(res.body).not.toContain('tokenHash');
    expect(store.devices).toHaveLength(1);
    expect(store.devices[0]!.tokenHash).toBe(createHash('sha256').update(data.token).digest('hex'));
    expect(store.devices[0]!.userId).toBe(USER_ID);
    expect(JSON.stringify(store.devices)).not.toContain(data.token);
  });

  it('issues a different token every time', async () => {
    expect(await newToken()).not.toBe(await newToken());
  });

  it('accepts a householdId where the caller is EDITOR', async () => {
    const res = await createDevice({ name: 'Tablet', householdId: SHARED_ID });
    expect(res.statusCode).toBe(201);
    expect(res.json().data.householdId).toBe(SHARED_ID);
  });

  it('refuses a VIEWER (403) and a non-member (403)', async () => {
    store.members.set(`${SHARED_ID}:${USER_ID}`, 'VIEWER');
    expect((await createDevice({ name: 'Tablet', householdId: SHARED_ID })).statusCode).toBe(403);
    expect((await createDevice({ name: 'Tablet', householdId: 'dd1f4c74-2b2a-4c5a-8c7b-8f8c3d4e5f60' })).statusCode).toBe(403);
    expect(store.devices).toHaveLength(0);
  });

  it('validates the name and needs a user login', async () => {
    expect((await createDevice({ name: '   ' })).statusCode).toBe(400);
    expect((await createDevice({ name: 'x'.repeat(101) })).statusCode).toBe(400);
    expect((await createDevice({ name: 'ok' }, {} as never)).statusCode).toBe(401);
  });

  it('is not available to a device token', async () => {
    const token = await newToken();
    const res = await createDevice({ name: 'outro' }, deviceAuth(token) as never);
    expect(res.statusCode).toBe(401);
  });
});

describe('GET /devices and DELETE /devices/:id', () => {
  it('lists only the caller devices, never the hash or the token', async () => {
    const token = await newToken();
    store.devices.push({ id: '00000000-0000-4000-8000-0000000000aa', userId: OTHER_USER_ID, householdId: PERSONAL_ID, name: 'De outra pessoa', tokenHash: 'h'.repeat(64), lastUsedAt: null, revokedAt: null, createdAt: new Date() });

    const res = await app.inject({ method: 'GET', url: '/devices', headers: userJwt() });

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(1);
    expect(res.json().data[0].name).toBe('Pixel de teste');
    expect(res.body).not.toContain('tokenHash');
    expect(res.body).not.toContain(token);
    expect(res.body).not.toContain(hashDeviceToken(token));
  });

  it('revokes, idempotently keeping the first revocation time', async () => {
    const token = await newToken();
    const id = store.devices[0]!.id;

    const first = await app.inject({ method: 'DELETE', url: `/devices/${id}`, headers: userJwt() });
    expect(first.statusCode).toBe(200);
    const revokedAt = first.json().data.revokedAt;
    expect(revokedAt).toEqual(expect.any(String));

    const second = await app.inject({ method: 'DELETE', url: `/devices/${id}`, headers: userJwt() });
    expect(second.statusCode).toBe(200);
    expect(second.json().data.revokedAt).toBe(revokedAt);

    expect((await post(token, { items: [item()] })).statusCode).toBe(401);
  });

  it("answers 404 for someone else's device and 400 for a malformed id", async () => {
    await newToken();
    const id = store.devices[0]!.id;
    expect((await app.inject({ method: 'DELETE', url: `/devices/${id}`, headers: userJwt(OTHER_USER_ID) })).statusCode).toBe(404);
    expect(store.devices[0]!.revokedAt).toBeNull();
    expect((await app.inject({ method: 'DELETE', url: '/devices/not-a-uuid', headers: userJwt() })).statusCode).toBe(400);
  });
});

describe('device token hook (POST /captures)', () => {
  it('accepts a valid token and stamps last_used_at', async () => {
    const token = await newToken();
    const res = await post(token, { items: [item()] });
    expect(res.statusCode).toBe(200);
    expect(store.devices[0]!.lastUsedAt).toBeInstanceOf(Date);
  });

  it('refreshes last_used_at at most once a minute', async () => {
    const token = await newToken();
    await post(token, { items: [item({ text: 'um' })] });
    await post(token, { items: [item({ text: 'dois' })] });
    await post(token, { items: [item({ text: 'tres' })] });
    expect(store.userUpdates).toBe(1);

    store.devices[0]!.lastUsedAt = new Date(Date.now() - 61_000);
    await post(token, { items: [item({ text: 'quatro' })] });
    expect(store.userUpdates).toBe(2);
  });

  it('still captures when the last_used_at write fails', async () => {
    const token = await newToken();
    const { prisma } = await import('../../shared/db/prisma.js');
    vi.mocked(prisma.deviceToken.updateMany).mockRejectedValueOnce(new Error('db down'));
    expect((await post(token, { items: [item()] })).statusCode).toBe(200);
  });

  it('rejects a missing header, a wrong scheme, garbage and an unknown token with 401', async () => {
    const unknown = generateDeviceToken();
    for (const headers of [{}, { authorization: 'Basic abc' }, { authorization: 'Bearer nonsense' }, deviceAuth(unknown), deviceAuth('rdt_short')]) {
      const res = await app.inject({ method: 'POST', url: '/captures', headers, payload: { items: [item()] } });
      expect(res.statusCode).toBe(401);
    }
    expect(store.captures).toHaveLength(0);
  });

  it('rejects a revoked token with 401', async () => {
    const token = await newToken();
    store.devices[0]!.revokedAt = new Date();
    expect((await post(token, { items: [item()] })).statusCode).toBe(401);
  });

  it('rejects a user JWT with 401', async () => {
    const res = await app.inject({ method: 'POST', url: '/captures', headers: userJwt(), payload: { items: [item()] } });
    expect(res.statusCode).toBe(401);
    expect(store.captures).toHaveLength(0);
  });

  it('keeps the JWT middleware refusing rdt_ tokens, even a valid one', async () => {
    const token = await newToken();
    for (const [method, url] of [['GET', '/devices'], ['GET', '/auth/me']] as const) {
      const res = await app.inject({ method, url, headers: deviceAuth(token) });
      expect(res.statusCode).toBe(401);
      expect(res.json().error.code).toBe('INVALID_TOKEN');
    }
  });

  it('answers 403 when the owner was removed from the household or downgraded to VIEWER', async () => {
    const token = await newToken({ name: 'Tablet', householdId: SHARED_ID });

    store.members.set(`${SHARED_ID}:${USER_ID}`, 'VIEWER');
    expect((await post(token, { items: [item()] })).statusCode).toBe(403);

    store.members.delete(`${SHARED_ID}:${USER_ID}`);
    expect((await post(token, { items: [item()] })).statusCode).toBe(403);

    store.members.set(`${SHARED_ID}:${USER_ID}`, 'OWNER');
    expect((await post(token, { items: [item()] })).statusCode).toBe(200);
    expect(store.captures).toHaveLength(1);
  });
});

describe('POST /captures validation', () => {
  it.each([
    ['no items', { items: [] }],
    ['items missing', {}],
    ['51 items', { items: Array.from({ length: 51 }, (_, i) => item({ text: `n${i}` })) }],
    ['package over 150', { items: [item({ package: 'p'.repeat(151) })] }],
    ['empty package', { items: [item({ package: '' })] }],
    ['title over 300', { items: [item({ title: 't'.repeat(301) })] }],
    ['text over 2000', { items: [item({ text: 'x'.repeat(2001) })] }],
    ['empty text', { items: [item({ text: '' })] }],
    ['NUL in text', { items: [item({ text: 'a\u0000b' })] }],
    ['NUL in title', { items: [item({ title: 'a\u0000b' })] }],
    ['NUL in package', { items: [item({ package: 'a\u0000b' })] }],
    ['postedAt not a date', { items: [item({ postedAt: 'ontem' })] }],
    ['postedAt without zone', { items: [item({ postedAt: '2026-11-09T14:03:21' })] }],
    ['postedAt date only', { items: [item({ postedAt: '2026-11-09' })] }],
    ['postedAt missing', { items: [{ package: 'p', text: 't' }] }],
  ])('400 for %s, storing nothing', async (_label, payload) => {
    const token = await newToken();
    const res = await post(token, payload);
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ success: false, error: { code: 'VALIDATION_ERROR' } });
    expect(store.captures).toHaveLength(0);
  });

  it('one bad item rejects the whole batch', async () => {
    const token = await newToken();
    expect((await post(token, { items: [item(), item({ text: '' })] })).statusCode).toBe(400);
    expect(store.captures).toHaveLength(0);
  });

  it('accepts the limits: 50 items, 150/300/2000 characters, no title, offset dates', async () => {
    const token = await newToken();
    const edge = item({ package: 'p'.repeat(150), title: 't'.repeat(300), text: 'x'.repeat(2000), postedAt: '2026-11-09T11:03:21-03:00' });
    const res = await post(token, { items: [edge, ...Array.from({ length: 48 }, (_, i) => item({ text: `n${i}` })), item({ title: undefined, text: 'sem titulo' })] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data.results).toHaveLength(50);
    expect(store.captures).toHaveLength(50);
    expect(store.captures.at(-1)).toMatchObject({ title: null, status: 'PENDING' });
  });
});

describe('POST /captures storage and dedup', () => {
  it('stores the raw text as PENDING with no parsed data and answers in input order', async () => {
    const token = await newToken();
    const a = item({ text: 'primeira' });
    const b = item({ text: 'segunda', title: null });

    const res = await post(token, { items: [a, b] });

    expect(res.statusCode).toBe(200);
    const { results } = res.json().data;
    expect(res.json().success).toBe(true);
    expect(results).toEqual([
      { dedupKey: computeDedupKey({ ...a, postedAt: new Date(a.postedAt as string) } as never), status: 'created' },
      { dedupKey: computeDedupKey({ ...b, postedAt: new Date(b.postedAt as string) } as never), status: 'created' },
    ]);
    expect(store.captures[0]).toMatchObject({ package: 'com.example.bank', title: 'Compra aprovada', text: 'primeira', status: 'PENDING' });
    expect(store.captures[0]!.parsed).toBeUndefined();
    expect(store.captures[1]).toMatchObject({ title: null });
  });

  it('marks a repeated item inside one batch as duplicate and stores it once', async () => {
    const token = await newToken();
    const res = await post(token, { items: [item(), item({ text: 'outra' }), item()] });

    const statuses = res.json().data.results.map((r: { status: string }) => r.status);
    expect(statuses).toEqual(['created', 'created', 'duplicate']);
    expect(res.json().data.results[0].dedupKey).toBe(res.json().data.results[2].dedupKey);
    expect(store.captures).toHaveLength(2);
  });

  it('answers 200 with all duplicates when the same batch is sent again', async () => {
    const token = await newToken();
    const payload = { items: [item({ text: 'a' }), item({ text: 'b' })] };
    const first = await post(token, payload);
    const second = await post(token, payload);

    expect(second.statusCode).toBe(200);
    expect(second.json().data.results.map((r: { status: string }) => r.status)).toEqual(['duplicate', 'duplicate']);
    expect(second.json().data.results.map((r: { dedupKey: string }) => r.dedupKey)).toEqual(first.json().data.results.map((r: { dedupKey: string }) => r.dedupKey));
    expect(store.captures).toHaveLength(2);
  });

  it('truncates postedAt to the minute: same minute is a duplicate, the next minute is new', async () => {
    const token = await newToken();
    const r1 = await post(token, { items: [item({ postedAt: '2026-11-09T14:03:05.000Z' })] });
    const r2 = await post(token, { items: [item({ postedAt: '2026-11-09T14:03:59.999Z' })] });
    const r3 = await post(token, { items: [item({ postedAt: '2026-11-09T14:04:00.000Z' })] });

    expect(r1.json().data.results[0].status).toBe('created');
    expect(r2.json().data.results[0]).toEqual({ dedupKey: r1.json().data.results[0].dedupKey, status: 'duplicate' });
    expect(r3.json().data.results[0].status).toBe('created');
    expect(store.captures).toHaveLength(2);
  });

  it('treats the same instant in another zone as the same notification', async () => {
    const token = await newToken();
    await post(token, { items: [item({ postedAt: '2026-11-09T14:03:21.000Z' })] });
    const res = await post(token, { items: [item({ postedAt: '2026-11-09T11:03:21-03:00' })] });
    expect(res.json().data.results[0].status).toBe('duplicate');
  });

  it('computes sha1(package|minute ISO|title|text) and treats a missing title as empty', () => {
    const postedAt = new Date('2026-11-09T14:03:21.000Z');
    const expected = createHash('sha1').update('com.example.bank|2026-11-09T14:03:00.000Z||texto').digest('hex');
    expect(computeDedupKey({ package: 'com.example.bank', postedAt, text: 'texto' })).toBe(expected);
    expect(computeDedupKey({ package: 'com.example.bank', title: null, postedAt, text: 'texto' })).toBe(expected);
    expect(computeDedupKey({ package: 'com.example.bank', title: 'T', postedAt, text: 'texto' })).not.toBe(expected);
    expect(expected).toHaveLength(40);
  });

  it('takes household and user from the token, ignoring the body', async () => {
    const token = await newToken({ name: 'Tablet', householdId: SHARED_ID });
    const res = await post(token, {
      householdId: PERSONAL_ID,
      userId: OTHER_USER_ID,
      items: [{ ...item(), householdId: PERSONAL_ID, userId: OTHER_USER_ID }],
    });

    expect(res.statusCode).toBe(200);
    expect(store.captures[0]).toMatchObject({ householdId: SHARED_ID, userId: USER_ID });
  });

  it('dedups per household: the same notification in two households is stored twice', async () => {
    const personal = await newToken();
    const shared = await newToken({ name: 'Tablet', householdId: SHARED_ID });
    await post(personal, { items: [item()] });
    const res = await post(shared, { items: [item()] });
    expect(res.json().data.results[0].status).toBe('created');
    expect(store.captures.map((c) => c.householdId).sort()).toEqual([PERSONAL_ID, SHARED_ID].sort());
  });
});

describe('POST /captures reads the notification', () => {
  const NU = 'com.nu.production';
  const purchase = { package: NU, title: 'Compra no crédito aprovada', text: 'Compra de R$ 37,50 APROVADA em PADARIA ZETA para o cartão com final 1234.' };

  it('stores what the parser understood, with the parser version, and keeps the capture PENDING', async () => {
    const token = await newToken();
    const res = await post(token, { items: [item(purchase)] });

    expect(res.statusCode).toBe(200);
    expect(store.captures[0]).toMatchObject({
      status: 'PENDING',
      parserVersion: PARSER_VERSION,
      parsed: { kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 37.5, description: 'PADARIA ZETA' },
    });
  });

  it('stores a notice (limit, promotion) as DISMISSED, so the user can restore it', async () => {
    const token = await newToken();
    await post(token, { items: [
      item({ package: NU, title: 'Seu novo limite está valendo', text: 'Agora você pode enviar até R$ 80.000,00 via Pix, TED e boleto de dia.' }),
      item({ package: NU, title: 'Promoção', text: 'Ganhe um cupom agora.' }),
    ] });

    expect(store.captures).toHaveLength(2);
    for (const capture of store.captures) {
      expect(capture).toMatchObject({ status: 'DISMISSED', parserVersion: PARSER_VERSION, parsed: { kind: 'IGNORE', ignore: true } });
    }
  });

  it('stores the cents, the card ending and the warning of a reading', async () => {
    const token = await newToken();
    await post(token, { items: [item(purchase), item({ package: 'com.mercadopago.wallet', title: 'Seu dinheiro já está disponível', text: 'Você depositou R$ 10,00 via Pix e o valor já está rendendo na sua conta.' })] });

    expect(store.captures[0]).toMatchObject({ parsed: { amountCents: 3750, cardLast4: '1234' } });
    expect(store.captures[1]).toMatchObject({ status: 'PENDING', parsed: { kind: 'PIX_IN', type: 'INCOME', amountCents: 1000, warning: 'POSSIBLE_OWN_TRANSFER' } });
  });

  it('answers 200 and keeps the capture PENDING without parsed when the text is not understood, marking the version that tried', async () => {
    const token = await newToken();
    const res = await post(token, { items: [item({ package: NU, title: 'Novidade', text: 'Você ganhou R$ 20,00 de cashback.' })] });

    expect(res.statusCode).toBe(200);
    expect(res.json().data.results[0].status).toBe('created');
    expect(store.captures[0]).toMatchObject({ status: 'PENDING', parserVersion: PARSER_VERSION });
    expect(store.captures[0]!.parsed).toBeUndefined();
  });
});

describe('POST /captures rate limit', () => {
  it('is 120 per minute per token (hash), falling back to the IP', async () => {
    const limited = Fastify();
    limited.setErrorHandler(errorHandler);
    await limited.register(rateLimit, { max: 1000, timeWindow: 60000, keyGenerator: (r) => r.ip });
    await limited.register(captureRoutes, { prefix: '/captures' });

    expect(capturesRateLimit.rateLimit.max).toBe(120);
    const tokenA = generateDeviceToken();
    const tokenB = generateDeviceToken();
    const statuses: number[] = [];
    for (let i = 0; i < 121; i++) {
      const res = await limited.inject({ method: 'POST', url: '/captures', headers: deviceAuth(tokenA), payload: { items: [item()] } });
      statuses.push(res.statusCode);
    }
    // Unknown tokens answer 401 until the bucket is full, then 429.
    expect(statuses.slice(0, 120).every((s) => s === 401)).toBe(true);
    expect(statuses[120]).toBe(429);

    const other = await limited.inject({ method: 'POST', url: '/captures', headers: deviceAuth(tokenB), payload: { items: [item()] } });
    expect(other.statusCode).toBe(401);
    await limited.close();
  }, 30000);
});
