import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const config = vi.hoisted(() => ({
  env: { AUTH_MODE: 'local', AUTH_JWT_SECRET: 'x'.repeat(40), AUTH_TOKEN_TTL_HOURS: 1, AUTH_ALLOW_REGISTRATION: true, AUTH_FIREBASE_WEB_API_KEY: undefined as string | undefined },
  isLocalAuth: true,
  isProduction: false,
}));

type Row = Record<string, unknown>;

// An in-memory stand-in for the tables the drafts routes touch.
const store = vi.hoisted(() => ({
  captures: [] as Row[],
  rules: [] as Row[],
  cardRules: [] as Row[],
  accounts: [] as Row[],
  transactions: [] as Row[],
  members: new Map<string, string>(), // `${householdId}:${userId}` -> role
  personalHousehold: { id: '' },
  beforeCreate: null as null | (() => void),
  createCalls: 0,
}));

const matches = (row: Row, where: Row): boolean =>
  Object.entries(where).every(([key, cond]) => {
    if (key === 'OR') return (cond as Row[]).some((alt) => matches(row, alt));
    if (cond && typeof cond === 'object' && !(cond instanceof Date)) {
      if ('in' in cond) return (cond as { in: unknown[] }).in.includes(row[key]);
      if ('lt' in cond) return typeof row[key] === 'number' && (row[key] as number) < (cond as { lt: number }).lt;
      return false;
    }
    return (row[key] ?? null) === cond;
  });

const captureOps = {
  findFirst: vi.fn(async ({ where, select }: { where: Row; select?: Record<string, boolean> }) => {
    const row = store.captures.find((c) => matches(c, where));
    return row ? pick(row, select) : null;
  }),
  findMany: vi.fn(async ({ where, orderBy, cursor, skip, take, select }: { where: Row; orderBy: Row[]; cursor?: { id: string }; skip?: number; take: number; select?: Record<string, boolean> }) => {
    void orderBy;
    let rows = store.captures
      .filter((c) => matches(c, where))
      .sort((a, b) => (b.postedAt as Date).getTime() - (a.postedAt as Date).getTime() || String(b.id).localeCompare(String(a.id)));
    if (cursor) rows = rows.slice(rows.findIndex((r) => r.id === cursor.id) + (skip ?? 0));
    return rows.slice(0, take).map((r) => pick(r, select));
  }),
  count: vi.fn(async ({ where }: { where: Row }) => store.captures.filter((c) => matches(c, where)).length),
  updateMany: vi.fn(async ({ where, data }: { where: Row; data: Row }) => {
    const rows = store.captures.filter((c) => matches(c, where));
    rows.forEach((r) => Object.assign(r, data));
    return { count: rows.length };
  }),
};

function pick(row: Row, select?: Record<string, boolean>) {
  return select ? Object.fromEntries(Object.keys(select).filter((k) => select[k]).map((k) => [k, row[k]])) : { ...row };
}

const ruleOps = {
  findMany: vi.fn(async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
    store.rules
      .filter((r) => matches(r, where))
      .sort((a, b) => String(a.package).localeCompare(String(b.package)) || String(a.kind).localeCompare(String(b.kind)))
      .map((r) => pick(r, select))),
  deleteMany: vi.fn(async ({ where }: { where: Row }) => {
    const before = store.rules.length;
    store.rules = store.rules.filter((r) => !matches(r, where));
    return { count: before - store.rules.length };
  }),
  createMany: vi.fn(async ({ data }: { data: Row[] }) => {
    store.rules.push(...data);
    return { count: data.length };
  }),
};

const cardRuleOps = {
  findMany: vi.fn(async ({ where, select }: { where: Row; select?: Record<string, boolean> }) =>
    store.cardRules
      .filter((r) => matches(r, where))
      .sort((a, b) => String(a.package).localeCompare(String(b.package)) || String(a.cardLast4).localeCompare(String(b.cardLast4)))
      .map((r) => pick(r, select))),
  deleteMany: vi.fn(async ({ where }: { where: Row }) => {
    const before = store.cardRules.length;
    store.cardRules = store.cardRules.filter((r) => !matches(r, where));
    return { count: before - store.cardRules.length };
  }),
  createMany: vi.fn(async ({ data }: { data: Row[] }) => {
    store.cardRules.push(...data);
    return { count: data.length };
  }),
};

const prismaMock = vi.hoisted(() => ({ current: null as unknown }));
vi.mock('../../shared/config/env.js', () => config);
vi.mock('../../shared/db/prisma.js', () => {
  const prisma = {
    user: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id, email: 'ana@example.com', firebaseUid: null })) },
    household: { findUnique: vi.fn(async ({ where }: { where: { id: string } }) => ({ id: where.id })) },
    householdMember: {
      findUnique: vi.fn(async ({ where }: { where: { householdId_userId: { householdId: string; userId: string } } }) => {
        const { householdId, userId } = where.householdId_userId;
        const role = store.members.get(`${householdId}:${userId}`);
        return role ? { id: 'm1', householdId, userId, role } : null;
      }),
    },
    capturedNotification: captureOps,
    captureAccountRule: ruleOps,
    captureCardRule: cardRuleOps,
    account: { count: vi.fn(async ({ where }: { where: Row }) => store.accounts.filter((a) => matches(a, where)).length) },
    transaction: { findFirst: vi.fn(async ({ where }: { where: Row }) => store.transactions.find((t) => matches(t, where)) ?? null) },
    $queryRaw: vi.fn(async () => []),
    // Interactive transactions: roll the rule table back when the callback throws.
    $transaction: vi.fn(async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = [...store.rules];
      const cardSnapshot = [...store.cardRules];
      try {
        return await fn(prismaMock.current);
      } catch (error) {
        store.rules = snapshot;
        store.cardRules = cardSnapshot;
        throw error;
      }
    }),
  };
  prismaMock.current = prisma;
  return { prisma };
});
vi.mock('../households/households.service.js', () => ({
  getOrCreatePersonalHousehold: vi.fn(async () => store.personalHousehold),
}));
vi.mock('../../shared/config/firebase.js', () => ({
  getFirebaseAuth: () => ({ verifyIdToken: vi.fn().mockRejectedValue(new Error('not a Firebase token')) }),
}));

// createTransaction is replaced by a stand-in that honours what confirm relies on: the (householdId, sourceRef)
// unique constraint (P2002 for the loser) and the in-transaction hook, which runs before the row becomes visible.
vi.mock('../transactions/transactions.service.js', () => ({
  createTransaction: vi.fn(async (input: Row, _userId: string, hooks?: { inTransaction?: (tx: unknown, created: { id: string }) => Promise<void> }) => {
    store.createCalls += 1;
    await Promise.resolve(); // lets a concurrent confirm get past its own pre-check first
    store.beforeCreate?.();
    if (input.sourceRef && store.transactions.some((t) => t.householdId === input.householdId && t.sourceRef === input.sourceRef)) {
      throw Object.assign(new Error('Unique constraint failed'), { code: 'P2002' });
    }
    const row = { id: `00000000-0000-4000-8000-${String(store.transactions.length + 1).padStart(12, '0')}`, ...input };
    const before = store.captures.map((c) => ({ ...c }));
    try {
      await hooks?.inTransaction?.(prismaMock.current, row);
    } catch (error) {
      store.captures = before; // the hook failed: the database transaction rolls back
      throw error;
    }
    store.transactions.push(row);
    return row;
  }),
  getTransactionWithHousehold: vi.fn(async (id: string, householdId: string) => {
    const row = store.transactions.find((t) => t.id === id && t.householdId === householdId);
    if (!row) throw Object.assign(new Error('Transaction not found'), { statusCode: 404, code: 'NOT_FOUND' });
    return { ...row };
  }),
}));

const { captureRoutes, buildSuggestion } = await import('./index.js');
const { PARSER_VERSION } = await import('./parsers/index.js');
const { generateDeviceToken } = await import('../devices/index.js');
const { errorHandler } = await import('../../shared/errors/error-handler.js');
const { signJwt } = await import('../auth/local.service.js');
const { createTransaction } = await import('../transactions/transactions.service.js');

const USER_ID = '6f1c1f0e-8a49-4c53-9c06-3f0a1d1c2b11';
const VIEWER_ID = '7a2d2f1f-9b5a-4d64-8d17-4a1b2e2d3c22';
const OUTSIDER_ID = '8b3e3a2a-0c6b-4e75-9e28-5b2c3f3e4d33';
const PERSONAL_ID = 'bb9d2a52-0f0e-4a3e-a0f5-6d6a1b2c3d4e';
const OTHER_HOUSEHOLD_ID = 'cc0e3b63-1a1f-4b4f-b1a6-7e7b2c3d4e5f';
const ACCOUNT_ID = 'dd1f4c74-2b2a-4c5a-8c7b-8f8c3d4e5f60';
const CARD_ID = 'ee205d85-3c3b-4d6b-9d8c-9a9d4e5f6071';
const FOREIGN_ACCOUNT_ID = 'ff316e96-4d4c-4e7c-8e9d-ab0e5f607182';
const PKG = 'com.example.bank';

let app: FastifyInstance;
beforeAll(async () => {
  app = Fastify();
  app.setErrorHandler(errorHandler);
  await app.register(captureRoutes, { prefix: '/captures' });
});
afterAll(() => app.close());

const capId = (n: number) => `00000000-0000-4000-9000-${String(n).padStart(12, '0')}`;
function addCapture(n: number, over: Row = {}): Row {
  const row: Row = {
    id: capId(n), householdId: PERSONAL_ID, userId: USER_ID, package: PKG, title: 'Compra aprovada', text: `Compra de R$ ${n},00 em LOJA ${n}`,
    postedAt: new Date(Date.UTC(2026, 10, 9, 12, n)), dedupKey: `key${n}`.padEnd(40, '0'), status: 'PENDING', parsed: null, transactionId: null, ...over,
  };
  store.captures.push(row);
  return row;
}

beforeEach(() => {
  store.captures = [];
  store.rules = [];
  store.cardRules = [];
  store.transactions = [];
  store.members.clear();
  store.beforeCreate = null;
  store.createCalls = 0;
  store.personalHousehold = { id: PERSONAL_ID };
  store.accounts = [
    { id: ACCOUNT_ID, householdId: PERSONAL_ID, isActive: true },
    { id: CARD_ID, householdId: PERSONAL_ID, isActive: true },
    { id: FOREIGN_ACCOUNT_ID, householdId: OTHER_HOUSEHOLD_ID, isActive: true },
  ];
  store.members.set(`${PERSONAL_ID}:${USER_ID}`, 'OWNER');
  store.members.set(`${PERSONAL_ID}:${VIEWER_ID}`, 'VIEWER');
  store.members.set(`${OTHER_HOUSEHOLD_ID}:${OUTSIDER_ID}`, 'OWNER');
  vi.clearAllMocks();
});

const as = (id = USER_ID) => ({ authorization: `Bearer ${signJwt(id, 'ana@example.com')}` });
const confirmBody = (over: Row = {}) => ({
  type: 'EXPENSE', accountId: CARD_ID, categoryName: 'FOOD', amount: 12.5, description: 'Loja de teste', date: '2026-11-09', ...over,
});
const get = (url: string, headers = as()) => app.inject({ method: 'GET', url, headers });
const postTo = (url: string, payload?: unknown, headers = as()) => app.inject({ method: 'POST', url, headers, payload: payload as object });
const put = (payload: unknown, headers = as(), url = '/captures/account-rules') => app.inject({ method: 'PUT', url, headers, payload: payload as object });
const confirm = (n: number, body: Row = confirmBody(), headers = as()) => postTo(`/captures/${capId(n)}/confirm`, body, headers);

describe('buildSuggestion (pure)', () => {
  const postedAt = new Date('2026-11-09T14:03:21.000Z');
  const rules = [{ package: PKG, kind: 'CARD_PURCHASE', accountId: CARD_ID }];

  it('without parsed data only the date is filled', () => {
    expect(buildSuggestion({ package: PKG, postedAt, parsed: null }, rules)).toEqual({
      type: null, accountId: null, categoryName: null, amount: null, description: null, date: '2026-11-09T14:03:21.000Z',
      cardLast4: null, warning: null,
    });
  });

  it('suggests the account only when parsed.kind exists and a rule matches (package, kind)', () => {
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 'CARD_PURCHASE' } }, rules).accountId).toBe(CARD_ID);
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 'PIX_IN' } }, rules).accountId).toBeNull();
    expect(buildSuggestion({ package: 'com.other', postedAt, parsed: { kind: 'CARD_PURCHASE' } }, rules).accountId).toBeNull();
    expect(buildSuggestion({ package: PKG, postedAt, parsed: {} }, rules).accountId).toBeNull();
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 7 } }, rules).accountId).toBeNull();
    expect(buildSuggestion({ package: PKG, postedAt, parsed: 'text' }, rules).accountId).toBeNull();
  });
});

describe('authentication on the drafts routes', () => {
  it.each([
    ['GET', '/captures'],
    ['GET', '/captures/count'],
    ['GET', '/captures/account-rules'],
    ['PUT', '/captures/account-rules'],
    ['POST', `/captures/${capId(1)}/confirm`],
    ['POST', `/captures/${capId(1)}/dismiss`],
    ['POST', `/captures/${capId(1)}/restore`],
  ] as const)('%s %s refuses a device token and a missing login with 401', async (method, url) => {
    addCapture(1);
    const device = await app.inject({ method, url, headers: { authorization: `Bearer ${generateDeviceToken()}` }, payload: method === 'GET' ? undefined : {} });
    const none = await app.inject({ method, url, payload: method === 'GET' ? undefined : {} });
    expect(device.statusCode).toBe(401);
    expect(none.statusCode).toBe(401);
    expect(store.captures[0]!.status).toBe('PENDING');
    expect(store.transactions).toHaveLength(0);
  });
});

describe('GET /captures', () => {
  it('lists PENDING by default, newest postedAt first, without the dedupKey', async () => {
    addCapture(1);
    addCapture(3);
    addCapture(2);
    addCapture(4, { status: 'DISMISSED' });
    addCapture(5, { householdId: OTHER_HOUSEHOLD_ID });

    const res = await get('/captures');

    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.data.map((c: { id: string }) => c.id)).toEqual([capId(3), capId(2), capId(1)]);
    expect(body.pagination).toEqual({ nextCursor: null, hasMore: false });
    expect(Object.keys(body.data[0]).sort()).toEqual(['id', 'package', 'parsed', 'postedAt', 'status', 'suggestion', 'text', 'title', 'transactionId']);
    expect(res.body).not.toContain('dedupKey');
    expect(res.body).not.toContain(OTHER_HOUSEHOLD_ID);
  });

  it('puts the posted instant in the suggestion and leaves the other fields null while there is no parser', async () => {
    addCapture(1);
    const { data } = (await get('/captures')).json();
    expect(data[0].suggestion).toEqual({
      type: null, accountId: null, categoryName: null, amount: null, description: null, date: '2026-11-09T12:01:00.000Z',
      cardLast4: null, warning: null,
    });
  });

  it('suggests the account from the rule only for a parsed kind that matches', async () => {
    store.rules.push({ householdId: PERSONAL_ID, package: PKG, kind: 'CARD_PURCHASE', accountId: CARD_ID });
    addCapture(1, { parsed: { kind: 'CARD_PURCHASE' } });
    addCapture(2, { parsed: { kind: 'PIX_IN' } });
    addCapture(3);

    const { data } = (await get('/captures')).json();
    const byId = Object.fromEntries(data.map((c: { id: string; suggestion: { accountId: string | null } }) => [c.id, c.suggestion.accountId]));
    expect(byId).toEqual({ [capId(1)]: CARD_ID, [capId(2)]: null, [capId(3)]: null });
  });

  it('filters by status', async () => {
    addCapture(1, { status: 'DISMISSED' });
    addCapture(2);
    const res = await get('/captures?status=DISMISSED');
    expect(res.json().data.map((c: { id: string }) => c.id)).toEqual([capId(1)]);
  });

  it('paginates with limit and cursor, without overlap', async () => {
    for (let n = 1; n <= 5; n++) addCapture(n);
    const first = (await get('/captures?limit=2')).json();
    expect(first.data.map((c: { id: string }) => c.id)).toEqual([capId(5), capId(4)]);
    expect(first.pagination).toEqual({ nextCursor: capId(4), hasMore: true });

    const second = (await get(`/captures?limit=2&cursor=${first.pagination.nextCursor}`)).json();
    expect(second.data.map((c: { id: string }) => c.id)).toEqual([capId(3), capId(2)]);
    const third = (await get(`/captures?limit=2&cursor=${second.pagination.nextCursor}`)).json();
    expect(third.data.map((c: { id: string }) => c.id)).toEqual([capId(1)]);
    expect(third.pagination).toEqual({ nextCursor: null, hasMore: false });
  });

  it('validates the query (400)', async () => {
    for (const q of ['status=NOPE', 'limit=0', 'limit=101', 'cursor=abc', 'householdId=abc']) {
      expect((await get(`/captures?${q}`)).statusCode).toBe(400);
    }
  });

  it('lets a VIEWER read but not a non-member (403), and never shows another household', async () => {
    addCapture(1);
    expect((await get('/captures?householdId=' + PERSONAL_ID, as(VIEWER_ID))).statusCode).toBe(200);
    expect((await get('/captures?householdId=' + PERSONAL_ID, as(OUTSIDER_ID))).statusCode).toBe(403);
  });
});

describe('GET /captures/count', () => {
  it('counts by status (PENDING by default) and is not swallowed by /:id', async () => {
    addCapture(1);
    addCapture(2);
    addCapture(3, { status: 'DISMISSED' });
    addCapture(4, { householdId: OTHER_HOUSEHOLD_ID });

    expect((await get('/captures/count')).json()).toEqual({ success: true, data: { count: 2 } });
    expect((await get('/captures/count?status=DISMISSED')).json().data.count).toBe(1);
    expect((await get('/captures/count', as(VIEWER_ID))).statusCode).toBe(200);
    expect((await get('/captures/count?status=X')).statusCode).toBe(400);
  });
});

describe('POST /captures/:id/confirm', () => {
  it('creates the transaction with sourceRef notif:<dedupKey> in the capture household and confirms the capture', async () => {
    const cap = addCapture(1);

    const res = await confirm(1);

    expect(res.statusCode).toBe(201);
    expect(store.transactions).toHaveLength(1);
    const tx = store.transactions[0]!;
    expect(tx).toMatchObject({ householdId: PERSONAL_ID, sourceRef: `notif:${cap.dedupKey as string}`, accountId: CARD_ID, categoryName: 'FOOD', amount: 12.5, paid: true, isSplit: false });
    expect(cap).toMatchObject({ status: 'CONFIRMED', transactionId: tx.id });
    expect(res.json().data.capture).toEqual({ id: capId(1), status: 'CONFIRMED', transactionId: tx.id });
    expect(res.json().data.transaction.id).toBe(tx.id);
    expect(createTransaction).toHaveBeenCalledWith(expect.objectContaining({ householdId: PERSONAL_ID }), USER_ID, expect.anything());
  });

  it('is idempotent: confirming again answers 200 with the same transaction and creates nothing', async () => {
    addCapture(1);
    const first = await confirm(1);
    const again = await confirm(1, confirmBody({ amount: 99 }));

    expect(again.statusCode).toBe(200);
    expect(again.json().data.transaction.id).toBe(first.json().data.transaction.id);
    expect(again.json().data.transaction.amount).toBe(12.5);
    expect(store.transactions).toHaveLength(1);
    expect(store.createCalls).toBe(1);
  });

  it('two simultaneous confirms yield one transaction: one 201, one 200 with the winner row', async () => {
    addCapture(1);
    const [a, b] = await Promise.all([confirm(1), confirm(1)]);

    expect([a.statusCode, b.statusCode].sort()).toEqual([200, 201]);
    expect(store.transactions).toHaveLength(1);
    expect(a.json().data.transaction.id).toBe(b.json().data.transaction.id);
    expect(store.captures[0]).toMatchObject({ status: 'CONFIRMED', transactionId: store.transactions[0]!.id });
  });

  it('a dismiss that lands while the transaction is being created wins: 409, no transaction, capture stays DISMISSED', async () => {
    addCapture(1);
    store.beforeCreate = () => { store.captures[0]!.status = 'DISMISSED'; };

    const res = await confirm(1);

    expect(res.statusCode).toBe(409);
    expect(store.transactions).toHaveLength(0);
    expect(store.captures[0]!.status).toBe('DISMISSED');
  });

  it('heals a capture left PENDING next to a transaction that already carries its reference', async () => {
    const cap = addCapture(1);
    store.transactions.push({ id: '00000000-0000-4000-8000-0000000000aa', householdId: PERSONAL_ID, sourceRef: `notif:${cap.dedupKey as string}` });

    const res = await confirm(1);

    expect(res.statusCode).toBe(200);
    expect(res.json().data.transaction.id).toBe('00000000-0000-4000-8000-0000000000aa');
    expect(cap).toMatchObject({ status: 'CONFIRMED', transactionId: '00000000-0000-4000-8000-0000000000aa' });
    expect(store.transactions).toHaveLength(1);
  });

  it.each(['DISMISSED', 'IGNORED'])('answers 409 for a %s capture and creates nothing', async (status) => {
    addCapture(1, { status });
    const res = await confirm(1);
    expect(res.statusCode).toBe(409);
    expect(store.transactions).toHaveLength(0);
    expect(store.captures[0]!.status).toBe(status);
  });

  it('answers 409 when the transaction of a CONFIRMED capture was deleted (transaction_id NULL)', async () => {
    addCapture(1, { status: 'CONFIRMED', transactionId: null });
    const res = await confirm(1);
    expect(res.statusCode).toBe(409);
    expect(res.json().error.message).toMatch(/deleted/);
    expect(store.transactions).toHaveLength(0);
  });

  it('answers 404 for a capture of another household or an unknown id, and 403 to a non-member', async () => {
    addCapture(1, { householdId: OTHER_HOUSEHOLD_ID });
    expect((await confirm(1)).statusCode).toBe(404);
    expect((await confirm(9)).statusCode).toBe(404);
    expect((await postTo(`/captures/${capId(1)}/confirm?householdId=${OTHER_HOUSEHOLD_ID}`, confirmBody())).statusCode).toBe(403);
    expect((await postTo(`/captures/${capId(1)}/confirm?householdId=${OTHER_HOUSEHOLD_ID}`, confirmBody(), as(OUTSIDER_ID))).statusCode).toBe(201);
    expect(store.transactions).toHaveLength(1);
  });

  it('requires EDITOR or OWNER (a VIEWER gets 403)', async () => {
    addCapture(1);
    const res = await postTo(`/captures/${capId(1)}/confirm?householdId=${PERSONAL_ID}`, confirmBody(), as(VIEWER_ID));
    expect(res.statusCode).toBe(403);
    expect(store.captures[0]!.status).toBe('PENDING');
  });

  it.each([
    ['sourceRef sent by the client', { sourceRef: 'x' }],
    ['installments', { totalInstallments: 3 }],
    ['splits', { isSplit: true }],
    ['householdId in the body', { householdId: OTHER_HOUSEHOLD_ID }],
    ['a transfer type', { type: 'TRANSFER' }],
    ['a zero amount', { amount: 0 }],
    ['a negative amount', { amount: -5 }],
    ['no account', { accountId: undefined }],
    ['no category', { categoryName: undefined }],
    ['a bad date', { date: 'ontem' }],
    ['a malformed reference month', { competenceMonth: '2026-13' }],
  ])('400 for %s, creating nothing', async (_label, over) => {
    addCapture(1);
    const res = await confirm(1, confirmBody(over));
    expect(res.statusCode).toBe(400);
    expect(store.transactions).toHaveLength(0);
    expect(store.captures[0]!.status).toBe('PENDING');
  });

  it('passes the corrected fields and the reference month through', async () => {
    addCapture(1);
    const res = await confirm(1, confirmBody({ type: 'INCOME', amount: 40, paid: false, notes: 'obs', competenceMonth: '2026-12' }));
    expect(res.statusCode).toBe(201);
    expect(store.transactions[0]).toMatchObject({ type: 'INCOME', amount: 40, paid: false, notes: 'obs', competenceMonth: '2026-12' });
  });
});

describe('dismiss and restore', () => {
  it('dismisses a PENDING capture, idempotently', async () => {
    addCapture(1);
    const first = await postTo(`/captures/${capId(1)}/dismiss`);
    const again = await postTo(`/captures/${capId(1)}/dismiss`);

    expect(first.statusCode).toBe(200);
    expect(first.json().data).toMatchObject({ id: capId(1), status: 'DISMISSED' });
    expect(first.body).not.toContain('dedupKey');
    expect(again.statusCode).toBe(200);
    expect(store.captures[0]!.status).toBe('DISMISSED');
  });

  it.each(['CONFIRMED', 'IGNORED'])('refuses to dismiss a %s capture with 409', async (status) => {
    addCapture(1, { status });
    expect((await postTo(`/captures/${capId(1)}/dismiss`)).statusCode).toBe(409);
    expect(store.captures[0]!.status).toBe(status);
  });

  it('restores a DISMISSED capture to PENDING and refuses any other status with 409', async () => {
    addCapture(1, { status: 'DISMISSED' });
    addCapture(2);
    addCapture(3, { status: 'CONFIRMED', transactionId: null });
    addCapture(4, { status: 'IGNORED' });

    const ok = await postTo(`/captures/${capId(1)}/restore`);
    expect(ok.statusCode).toBe(200);
    expect(ok.json().data.status).toBe('PENDING');
    for (const n of [2, 3, 4]) expect((await postTo(`/captures/${capId(n)}/restore`)).statusCode).toBe(409);
    expect(store.captures.map((c) => c.status)).toEqual(['PENDING', 'PENDING', 'CONFIRMED', 'IGNORED']);
  });

  it('answers 404 across households and unknown ids, and 403 to a VIEWER', async () => {
    addCapture(1, { householdId: OTHER_HOUSEHOLD_ID });
    addCapture(2);
    for (const action of ['dismiss', 'restore']) {
      expect((await postTo(`/captures/${capId(1)}/${action}`)).statusCode).toBe(404);
      expect((await postTo(`/captures/${capId(9)}/${action}`)).statusCode).toBe(404);
      expect((await postTo(`/captures/${capId(2)}/${action}?householdId=${PERSONAL_ID}`, undefined, as(VIEWER_ID))).statusCode).toBe(403);
    }
    expect((await postTo('/captures/not-a-uuid/dismiss')).statusCode).toBe(400);
    expect(store.captures[0]!.status).toBe('PENDING');
    expect(store.captures[1]!.status).toBe('PENDING');
  });
});

describe('account rules', () => {
  const rule = (over: Row = {}) => ({ package: PKG, kind: 'CARD_PURCHASE', accountId: CARD_ID, ...over });

  it('lists the household rules sorted, and an empty list when there are none', async () => {
    expect((await get('/captures/account-rules')).json()).toEqual({ success: true, data: [] });
    store.rules.push(
      { householdId: PERSONAL_ID, package: 'b.app', kind: 'PIX_IN', accountId: ACCOUNT_ID },
      { householdId: PERSONAL_ID, package: PKG, kind: 'PIX_OUT', accountId: ACCOUNT_ID },
      { householdId: OTHER_HOUSEHOLD_ID, package: 'z.app', kind: 'REFUND', accountId: FOREIGN_ACCOUNT_ID },
    );
    const { data } = (await get('/captures/account-rules')).json();
    expect(data).toEqual([
      { package: 'b.app', kind: 'PIX_IN', accountId: ACCOUNT_ID },
      { package: PKG, kind: 'PIX_OUT', accountId: ACCOUNT_ID },
    ]);
  });

  it('replaces all rules at once, and an empty body clears them', async () => {
    store.rules.push({ householdId: PERSONAL_ID, package: 'old.app', kind: 'REFUND', accountId: ACCOUNT_ID });

    const res = await put({ rules: [rule(), rule({ kind: 'PIX_OUT', accountId: ACCOUNT_ID })] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { package: PKG, kind: 'CARD_PURCHASE', accountId: CARD_ID },
      { package: PKG, kind: 'PIX_OUT', accountId: ACCOUNT_ID },
    ]);
    expect(store.rules).toHaveLength(2);

    expect((await put({ rules: [] })).json().data).toEqual([]);
    expect(store.rules).toHaveLength(0);
  });

  it('accepts every kind and the same package with different kinds', async () => {
    const kinds = ['CARD_PURCHASE', 'PIX_OUT', 'PIX_IN', 'REFUND', 'SAVINGS_MOVE'];
    const res = await put({ rules: kinds.map((kind) => rule({ kind })) });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toHaveLength(5);
  });

  it('rejects a duplicate (package, kind) with 400 and keeps the old rules', async () => {
    store.rules.push({ householdId: PERSONAL_ID, package: 'old.app', kind: 'REFUND', accountId: ACCOUNT_ID });
    const res = await put({ rules: [rule(), rule({ accountId: ACCOUNT_ID })] });
    expect(res.statusCode).toBe(400);
    expect(store.rules).toEqual([{ householdId: PERSONAL_ID, package: 'old.app', kind: 'REFUND', accountId: ACCOUNT_ID }]);
  });

  it('rejects an account of another household (or unknown, or inactive) with 404 and changes nothing', async () => {
    store.rules.push({ householdId: PERSONAL_ID, package: 'old.app', kind: 'REFUND', accountId: ACCOUNT_ID });
    for (const accountId of [FOREIGN_ACCOUNT_ID, '11111111-1111-4111-8111-111111111111']) {
      const res = await put({ rules: [rule(), rule({ kind: 'PIX_IN', accountId })] });
      expect(res.statusCode).toBe(404);
    }
    store.accounts.find((a) => a.id === CARD_ID)!.isActive = false;
    expect((await put({ rules: [rule()] })).statusCode).toBe(404);
    expect(store.rules).toEqual([{ householdId: PERSONAL_ID, package: 'old.app', kind: 'REFUND', accountId: ACCOUNT_ID }]);
  });

  it.each([
    ['unknown kind', { rules: [{ package: PKG, kind: 'NOPE', accountId: CARD_ID }] }],
    ['empty package', { rules: [{ package: '', kind: 'PIX_IN', accountId: CARD_ID }] }],
    ['package over 150', { rules: [{ package: 'p'.repeat(151), kind: 'PIX_IN', accountId: CARD_ID }] }],
    ['NUL in package', { rules: [{ package: 'a\u0000b', kind: 'PIX_IN', accountId: CARD_ID }] }],
    ['accountId not a uuid', { rules: [{ package: PKG, kind: 'PIX_IN', accountId: 'abc' }] }],
    ['rules missing', {}],
    ['extra keys', { rules: [], other: 1 }],
    ['over 100 rules', { rules: Array.from({ length: 101 }, (_, i) => rule({ package: `p${i}` })) }],
  ])('400 for %s', async (_label, payload) => {
    expect((await put(payload)).statusCode).toBe(400);
  });

  it('requires EDITOR+ to write (VIEWER 403) but lets a VIEWER read', async () => {
    expect((await put({ rules: [] }, as(VIEWER_ID), `/captures/account-rules?householdId=${PERSONAL_ID}`)).statusCode).toBe(403);
    expect((await get(`/captures/account-rules?householdId=${PERSONAL_ID}`, as(VIEWER_ID))).statusCode).toBe(200);
    expect((await put({ rules: [] }, as(OUTSIDER_ID), `/captures/account-rules?householdId=${PERSONAL_ID}`)).statusCode).toBe(403);
  });

  it('runs the replace in one database transaction', async () => {
    const { prisma } = await import('../../shared/db/prisma.js');
    await put({ rules: [rule()] });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
  });
});

describe('buildSuggestion with a parsed notification', () => {
  const postedAt = new Date('2026-11-09T14:03:21.000Z');
  const rules = [{ package: PKG, kind: 'CARD_PURCHASE', accountId: CARD_ID }];
  const parsed = { kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 37.5, description: 'PADARIA ZETA' };

  it('fills type, amount, description and the account of the rule; the category stays null', () => {
    expect(buildSuggestion({ package: PKG, postedAt, parsed }, rules)).toEqual({
      type: 'EXPENSE', accountId: CARD_ID, categoryName: null, amount: 37.5, description: 'PADARIA ZETA', date: '2026-11-09T14:03:21.000Z',
      cardLast4: null, warning: null,
    });
  });

  it('suggests income for a refund', () => {
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 'REFUND', type: 'INCOME', amount: 12.34, description: 'Estorno: X' } }, rules)).toMatchObject({
      type: 'INCOME', amount: 12.34, description: 'Estorno: X', accountId: null,
    });
  });

  it('ignores parsed fields of the wrong shape', () => {
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 'PIX_IN', type: 'SIDEWAYS', amount: '5', description: 7 } }, rules)).toMatchObject({
      type: null, amount: null, description: null,
    });
    expect(buildSuggestion({ package: PKG, postedAt, parsed: { kind: 'PIX_IN', type: 'INCOME', amount: -1, description: '' } }, rules)).toMatchObject({
      type: 'INCOME', amount: null, description: null,
    });
  });
});

describe('buildSuggestion: cents, card ending and warning', () => {
  const postedAt = new Date('2026-11-09T14:03:21.000Z');
  const NU = 'com.nu.production';
  const NUBANK_CARD = '12121212-2b2a-4c5a-8c7b-8f8c3d4e5f61';
  const VIRTUAL_CARD = '13131313-2b2a-4c5a-8c7b-8f8c3d4e5f62';
  const kindRules = [{ package: NU, kind: 'CARD_PURCHASE', accountId: NUBANK_CARD }];
  const cardRules = [
    { package: NU, cardLast4: '4321', accountId: VIRTUAL_CARD },
    { package: 'com.other', cardLast4: '1234', accountId: ACCOUNT_ID },
  ];
  const purchase = (over: Row = {}) => ({ kind: 'CARD_PURCHASE', type: 'EXPENSE', amountCents: 3750, amount: 37.5, description: 'PADARIA', ...over });

  it('takes the amount from the integer cents, and still reads the reais of an older reading', () => {
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase({ amountCents: 29, amount: 99 }) }, kindRules).amount).toBe(0.29);
    expect(buildSuggestion({ package: NU, postedAt, parsed: { kind: 'CARD_PURCHASE', type: 'EXPENSE', amount: 12.5 } }, kindRules).amount).toBe(12.5);
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase({ amountCents: 12.5 }) }, kindRules).amount).toBeNull();
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase({ amountCents: 0 }) }, kindRules).amount).toBeNull();
  });

  it('a card-ending rule of the same app wins over the (app, kind) rule', () => {
    const s = buildSuggestion({ package: NU, postedAt, parsed: purchase({ cardLast4: '4321' }) }, kindRules, cardRules);
    expect(s).toMatchObject({ accountId: VIRTUAL_CARD, cardLast4: '4321' });
  });

  it('falls back to the (app, kind) rule when no rule names the card ending, or it belongs to another app', () => {
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase({ cardLast4: '9999' }) }, kindRules, cardRules).accountId).toBe(NUBANK_CARD);
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase({ cardLast4: '1234' }) }, kindRules, cardRules).accountId).toBe(NUBANK_CARD);
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase() }, kindRules, cardRules).accountId).toBe(NUBANK_CARD);
  });

  it('drops a card ending of the wrong shape (never matched, never shown)', () => {
    for (const cardLast4 of ['432', '43210', 4321, 'abcd']) {
      const s = buildSuggestion({ package: NU, postedAt, parsed: purchase({ cardLast4 }) }, [], [{ package: NU, cardLast4: '4321', accountId: VIRTUAL_CARD }]);
      expect(s).toMatchObject({ accountId: null, cardLast4: null });
    }
  });

  it('passes the possible-own-transfer warning and drops an unknown one', () => {
    const pixIn = { kind: 'PIX_IN', type: 'INCOME', amountCents: 1000, amount: 10, description: 'Depósito via Pix' };
    expect(buildSuggestion({ package: NU, postedAt, parsed: { ...pixIn, warning: 'POSSIBLE_OWN_TRANSFER' } }, []).warning).toBe('POSSIBLE_OWN_TRANSFER');
    expect(buildSuggestion({ package: NU, postedAt, parsed: { ...pixIn, warning: 'OTHER' } }, []).warning).toBeNull();
  });

  it('GET /captures suggests the account of the card-ending rule', async () => {
    store.accounts.push({ id: NUBANK_CARD, householdId: PERSONAL_ID, isActive: true });
    store.rules.push({ householdId: PERSONAL_ID, package: NU, kind: 'CARD_PURCHASE', accountId: NUBANK_CARD });
    store.cardRules.push(
      { householdId: PERSONAL_ID, package: NU, cardLast4: '4321', accountId: CARD_ID },
      { householdId: OTHER_HOUSEHOLD_ID, package: NU, cardLast4: '5555', accountId: FOREIGN_ACCOUNT_ID },
    );
    addCapture(1, { package: NU, parsed: purchase({ cardLast4: '4321' }) });
    addCapture(2, { package: NU, parsed: purchase({ cardLast4: '5555' }) });

    const { data } = (await get('/captures')).json();
    const byId = Object.fromEntries(data.map((c: Row) => [c.id, c]));
    expect(byId[capId(1)].suggestion).toMatchObject({ accountId: CARD_ID, cardLast4: '4321', amount: 37.5 });
    // Another household's rule never applies.
    expect(byId[capId(2)].suggestion).toMatchObject({ accountId: NUBANK_CARD, cardLast4: '5555' });
  });
});

describe('card rules', () => {
  const NU = 'com.nu.production';
  const putCards = (payload: unknown, headers = as(), url = '/captures/card-rules') => put(payload, headers, url);
  const rule = (over: Row = {}) => ({ package: NU, cardLast4: '4321', accountId: CARD_ID, ...over });

  it('lists only the household rules, sorted', async () => {
    expect((await get('/captures/card-rules')).json()).toEqual({ success: true, data: [] });
    store.cardRules.push(
      { householdId: PERSONAL_ID, package: NU, cardLast4: '9999', accountId: ACCOUNT_ID },
      { householdId: PERSONAL_ID, package: NU, cardLast4: '1111', accountId: CARD_ID },
      { householdId: OTHER_HOUSEHOLD_ID, package: NU, cardLast4: '2222', accountId: FOREIGN_ACCOUNT_ID },
    );
    expect((await get('/captures/card-rules')).json().data).toEqual([
      { package: NU, cardLast4: '1111', accountId: CARD_ID },
      { package: NU, cardLast4: '9999', accountId: ACCOUNT_ID },
    ]);
  });

  it('replaces all card rules at once without touching the (app, kind) rules', async () => {
    store.rules.push({ householdId: PERSONAL_ID, package: NU, kind: 'PIX_IN', accountId: ACCOUNT_ID });
    store.cardRules.push({ householdId: PERSONAL_ID, package: NU, cardLast4: '0000', accountId: ACCOUNT_ID });

    const res = await putCards({ rules: [rule(), rule({ cardLast4: '8765', accountId: CARD_ID })] });
    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual([
      { package: NU, cardLast4: '4321', accountId: CARD_ID },
      { package: NU, cardLast4: '8765', accountId: CARD_ID },
    ]);
    expect(store.rules).toHaveLength(1);
    expect((await putCards({ rules: [] })).json().data).toEqual([]);
  });

  it('rejects a duplicate (app, ending) with 400 and an account outside the household with 404, keeping the old rules', async () => {
    store.cardRules.push({ householdId: PERSONAL_ID, package: NU, cardLast4: '0000', accountId: ACCOUNT_ID });
    expect((await putCards({ rules: [rule(), rule({ accountId: ACCOUNT_ID })] })).statusCode).toBe(400);
    expect((await putCards({ rules: [rule({ accountId: FOREIGN_ACCOUNT_ID })] })).statusCode).toBe(404);
    expect(store.cardRules).toEqual([{ householdId: PERSONAL_ID, package: NU, cardLast4: '0000', accountId: ACCOUNT_ID }]);
  });

  it.each([
    ['three digits', { rules: [rule({ cardLast4: '123' })] }],
    ['five digits', { rules: [rule({ cardLast4: '12345' })] }],
    ['letters', { rules: [rule({ cardLast4: '12a4' })] }],
    ['a number instead of text', { rules: [rule({ cardLast4: 1234 })] }],
    ['extra keys', { rules: [{ ...rule(), kind: 'CARD_PURCHASE' }] }],
    ['over 100 rules', { rules: Array.from({ length: 101 }, (_, i) => rule({ cardLast4: String(i).padStart(4, '0') })) }],
  ])('400 for %s', async (_label, payload) => {
    expect((await putCards(payload)).statusCode).toBe(400);
  });

  it('requires EDITOR+ to write (VIEWER 403) but lets a VIEWER read', async () => {
    expect((await putCards({ rules: [] }, as(VIEWER_ID), `/captures/card-rules?householdId=${PERSONAL_ID}`)).statusCode).toBe(403);
    expect((await get(`/captures/card-rules?householdId=${PERSONAL_ID}`, as(VIEWER_ID))).statusCode).toBe(200);
    expect((await putCards({ rules: [] }, as(OUTSIDER_ID), `/captures/card-rules?householdId=${PERSONAL_ID}`)).statusCode).toBe(403);
  });
});

// The in-memory stand-in stores Prisma's DbNull sentinel as is; for the database it means SQL NULL.
const isNullJson = (value: unknown) => value == null || (value as object).constructor?.name === 'DbNull';

describe('POST /captures/reparse', () => {
  const NU = 'com.nu.production';
  const purchaseText = 'Compra de R$ 37,50 APROVADA em PADARIA ZETA para o cartão com final 1234.';
  const limitText = 'Agora você pode enviar até R$ 80.000,00 via Pix, TED e boleto de dia.';

  it('reads the PENDING captures read by an older parser (or never read) and stores the result', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText });
    addCapture(2, { package: NU, title: 'Estorno', text: 'A compra em PADARIA ZETA no valor de R$ 37,50 foi estornada.', parserVersion: 3 });
    addCapture(3, { package: NU, title: 'Novidade', text: 'Você ganhou R$ 20,00 de cashback.', parserVersion: 1 });
    addCapture(4, { package: NU, title: 'Seu novo limite está valendo', text: limitText, parserVersion: 3 });

    const res = await postTo('/captures/reparse');

    expect(res.statusCode).toBe(200);
    expect(res.json().data).toEqual({ scanned: 4, updated: 4, understood: 2, dismissed: 1, notUnderstood: 1, parserVersion: PARSER_VERSION });
    const byId = Object.fromEntries(store.captures.map((c) => [c.id, c]));
    expect(byId[capId(1)]).toMatchObject({ status: 'PENDING', parserVersion: PARSER_VERSION, parsed: { kind: 'CARD_PURCHASE', amountCents: 3750, cardLast4: '1234' } });
    expect(byId[capId(2)]).toMatchObject({ status: 'PENDING', parsed: { kind: 'REFUND', type: 'INCOME' } });
    expect(byId[capId(3)]).toMatchObject({ status: 'PENDING', parserVersion: PARSER_VERSION });
    expect(isNullJson(byId[capId(3)]!.parsed)).toBe(true);
    // A promotion is dismissed (decision of 13/11/2026), so "restore" brings it back.
    expect(byId[capId(4)]).toMatchObject({ status: 'DISMISSED', parsed: { kind: 'IGNORE' } });
  });

  it('replaces an older reading and clears one that is no longer understood', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText, parsed: { kind: 'CARD_PURCHASE', amount: 1 }, parserVersion: 0 });
    addCapture(2, { package: NU, title: 'x', text: 'você ganhou R$ 9,00', parsed: { kind: 'PIX_IN', amount: 9 }, parserVersion: 0 });

    await postTo('/captures/reparse');

    expect(store.captures[0]).toMatchObject({ parsed: { amount: 37.5, amountCents: 3750 }, parserVersion: PARSER_VERSION });
    expect(isNullJson(store.captures[1]!.parsed)).toBe(true);
    expect(store.captures[1]!.parserVersion).toBe(PARSER_VERSION);
  });

  it('turns the own transfers of the first reader into income with a warning', async () => {
    addCapture(1, { package: NU, title: 'Transferência recebida', text: 'Recebemos sua transferência de R$ 2.500,00.', parsed: { kind: 'OWN_TRANSFER_IN', type: null, amount: 2500 }, parserVersion: 3 });
    await postTo('/captures/reparse');
    expect(store.captures[0]).toMatchObject({ status: 'PENDING', parsed: { kind: 'PIX_IN', type: 'INCOME', amountCents: 250000, warning: 'POSSIBLE_OWN_TRANSFER' } });
  });

  it('is idempotent: a second run finds nothing to read and changes nothing', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText });
    addCapture(2, { package: NU, title: 'Limite', text: limitText });
    await postTo('/captures/reparse');
    const after = store.captures.map((c) => ({ ...c }));

    const second = await postTo('/captures/reparse');

    expect(second.json().data).toMatchObject({ scanned: 0, updated: 0 });
    expect(store.captures).toEqual(after);
  });

  it('two simultaneous runs update each capture once', async () => {
    for (let n = 1; n <= 5; n += 1) addCapture(n, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText.replace('37,50', `${n},00`) });

    const [a, b] = await Promise.all([postTo('/captures/reparse'), postTo('/captures/reparse')]);

    expect(a.json().data.updated + b.json().data.updated).toBe(5);
    expect(store.captures.every((c) => c.parserVersion === PARSER_VERSION && c.status === 'PENDING')).toBe(true);
  });

  it('moves the IGNORED notices of the first reader to DISMISSED, and an IGNORED text now understood back to PENDING', async () => {
    addCapture(1, { package: NU, title: 'Limite', text: limitText, status: 'IGNORED', parsed: { kind: 'IGNORE', ignore: true }, parserVersion: 3 });
    addCapture(2, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText, status: 'IGNORED', parserVersion: 3 });

    await postTo('/captures/reparse');

    expect(store.captures.map((c) => c.status)).toEqual(['DISMISSED', 'PENDING']);
    expect((await postTo(`/captures/${capId(1)}/restore`)).statusCode).toBe(200);
  });

  it('a notice the user restored is not dismissed again by the next run', async () => {
    addCapture(1, { package: NU, title: 'Limite', text: limitText });
    await postTo('/captures/reparse');
    await postTo(`/captures/${capId(1)}/restore`);

    await postTo('/captures/reparse');

    expect(store.captures[0]!.status).toBe('PENDING');
  });

  it('never touches CONFIRMED or DISMISSED captures, nor another household', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText, status: 'CONFIRMED', transactionId: 'tx' });
    addCapture(2, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText, status: 'DISMISSED' });
    addCapture(3, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText, householdId: OTHER_HOUSEHOLD_ID });

    const res = await postTo('/captures/reparse');

    expect(res.json().data).toMatchObject({ scanned: 0, updated: 0 });
    expect(store.captures.every((c) => c.parsed === null && c.parserVersion === undefined)).toBe(true);
    expect(store.captures.map((c) => c.status)).toEqual(['CONFIRMED', 'DISMISSED', 'PENDING']);
  });

  it('a capture confirmed between the read and the write is left alone', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText });
    const original = captureOps.updateMany.getMockImplementation()!;
    captureOps.updateMany.mockImplementationOnce(async (args) => {
      store.captures[0]!.status = 'CONFIRMED';
      return original(args);
    });

    const res = await postTo('/captures/reparse');

    expect(res.json().data).toMatchObject({ scanned: 1, updated: 0 });
    expect(store.captures[0]).toMatchObject({ status: 'CONFIRMED', parsed: null });
  });

  it('needs an EDITOR login: a VIEWER gets 403, a device token or nothing gets 401', async () => {
    addCapture(1, { package: NU, title: 'Compra no crédito aprovada', text: purchaseText });
    expect((await postTo('/captures/reparse', undefined, as(VIEWER_ID))).statusCode).toBe(403);
    expect((await postTo('/captures/reparse', undefined, { authorization: `Bearer ${generateDeviceToken()}` })).statusCode).toBe(401);
    expect((await postTo('/captures/reparse', undefined, {} as never)).statusCode).toBe(401);
    expect(store.captures[0]!.parsed).toBeNull();
  });
});
