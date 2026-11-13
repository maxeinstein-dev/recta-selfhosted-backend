import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, NotFoundError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { loadCashFlow } from './cash-flow.loader.js';
import { buildCashFlow } from './cash-flow.js';
import { dashboardRoutes } from './dashboard.routes.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const ACC = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer test' };

const m = {
  member: vi.mocked(requireHouseholdMember),
  personal: vi.mocked(ensurePersonalHousehold),
  load: vi.mocked(loadCashFlow),
};

// Invented data only.
const sample = () => ({
  currency: 'BRL',
  ...buildCashFlow({
    startingBalanceCents: 150000,
    today: '2026-11-10',
    days: 30,
    events: [
      { date: '2026-11-20', description: 'Salary', amountCents: 400000, source: 'recurrence', certainty: 'expected', sourceId: 'rec-1', accountId: ACC },
      { date: '2026-11-18', description: 'Fatura Card', amountCents: -180000, source: 'invoice', certainty: 'confirmed', sourceId: 'card-1', accountId: ACC, invoiceMonth: '2026-11' },
    ],
  }),
});

describe('GET /dashboard/cash-flow', () => {
  let app: FastifyInstance;

  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(dashboardRoutes, { prefix: '/dashboard' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });

  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.personal.mockResolvedValue(HH);
    m.load.mockResolvedValue(sample() as never);
  });

  const get = (qs: string, headers: Record<string, string> = AUTH) => app.inject({ method: 'GET', url: `/dashboard/cash-flow${qs}`, headers });

  it('answers 401 without credentials, before anything else', async () => {
    expect((await get(`?householdId=${HH}`, {})).statusCode).toBe(401);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.load).not.toHaveBeenCalled();
  });

  it('checks the membership, defaults days to 90 and returns the projection in the envelope', async () => {
    const res = await get(`?householdId=${HH}`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, accountId: undefined, days: 90 });
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.startingBalance).toBe(1500);
    expect(body.data.currency).toBe('BRL');
    expect(body.data.days.map((d: { date: string; endBalance: number }) => [d.date, d.endBalance])).toEqual([
      ['2026-11-18', -300],
      ['2026-11-20', 3700],
    ]);
    expect(body.data.days[0].events[0]).toEqual({
      date: '2026-11-18',
      description: 'Fatura Card',
      amount: -1800,
      source: 'invoice',
      certainty: 'confirmed',
      overdue: false,
      originalDate: null,
      sourceId: 'card-1',
      accountId: ACC,
      invoiceMonth: '2026-11',
    });
    expect(body.data.summary).toMatchObject({
      lowestBalance: { date: '2026-11-18', amount: -300 },
      firstNegativeDate: '2026-11-18',
      endingBalance: 3700,
      eventCount: 2,
    });
    expect(body.data.unassignedInvoices).toEqual([]);
  });

  it('keeps the early-payment discount data of a recurrence event, and leaves the other events as they are', async () => {
    const earlyDiscount = { limitDate: '2026-11-18', fullAmount: 200, discountedAmount: 175, savings: 25, recurringId: 'rec-1', occurrenceDate: '2026-11-20', canPayNow: true };
    m.load.mockResolvedValue({
      currency: 'BRL',
      ...buildCashFlow({
        startingBalanceCents: 100000,
        today: '2026-11-10',
        days: 30,
        events: [{ date: '2026-11-20', description: 'Bill', amountCents: -17500, source: 'recurrence', certainty: 'expected', sourceId: 'rec-1', accountId: ACC, earlyDiscount }],
      }),
    } as never);
    const body = (await get(`?householdId=${HH}`)).json();
    expect(body.data.days[0].events[0]).toMatchObject({ amount: -175, earlyDiscount });
    m.load.mockResolvedValue(sample() as never);
    const plain = (await get(`?householdId=${HH}`)).json();
    expect(plain.data.days[0].events[0]).not.toHaveProperty('earlyDiscount');
  });

  it('passes the account and the days through', async () => {
    await get(`?householdId=${HH}&accountId=${ACC}&days=30`);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, accountId: ACC, days: 30 });
  });

  it('uses the personal household when none is given', async () => {
    await get('');
    expect(m.personal).toHaveBeenCalled();
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
  });

  it('answers 403 to a non-member before touching the data', async () => {
    m.member.mockRejectedValueOnce(new ForbiddenError());
    expect((await get(`?householdId=${HH}`)).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('an account of another household answers 404', async () => {
    m.load.mockRejectedValueOnce(new NotFoundError('Account'));
    expect((await get(`?householdId=${HH}&accountId=${ACC}`)).statusCode).toBe(404);
  });

  it('invalid parameters answer 400 and nothing is loaded', async () => {
    for (const qs of [
      `?householdId=${HH}&days=0`,
      `?householdId=${HH}&days=181`,
      `?householdId=${HH}&days=abc`,
      `?householdId=${HH}&days=2.5`,
      `?householdId=${HH}&accountId=nope`,
      '?householdId=nope',
    ]) {
      const res = await get(qs);
      expect(res.statusCode, qs).toBe(400);
    }
    expect(m.load).not.toHaveBeenCalled();
  });

  it('keeps the free/kept split and the reserve events (the response schema must not drop them)', async () => {
    m.load.mockResolvedValue({
      currency: 'BRL',
      ...buildCashFlow({
        startingBalanceCents: 200000,
        allocatedCents: 100000,
        today: '2026-11-10',
        days: 30,
        events: [{ date: '2026-11-15', description: 'Guardar: Emergency', amountCents: -50000, source: 'reserve', certainty: 'expected', sourceId: 'goal-1', accountId: ACC }],
      }),
    } as never);
    const body = (await get(`?householdId=${HH}`)).json();
    expect(body.data).toMatchObject({ startingBalance: 2000, allocated: 1000, totalBalance: 3000 });
    expect(body.data.days[0].events[0]).toMatchObject({ source: 'reserve', amount: -500, sourceId: 'goal-1' });
    expect(body.data.days[0].endBalance).toBe(1500);
  });

  it('accepts the limits 1 and 180', async () => {
    expect((await get(`?householdId=${HH}&days=1`)).statusCode).toBe(200);
    expect((await get(`?householdId=${HH}&days=180`)).statusCode).toBe(200);
  });
});
