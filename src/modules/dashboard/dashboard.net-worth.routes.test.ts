import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { loadNetWorth } from './net-worth.loader.js';

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
vi.mock('./net-worth.loader.js', () => ({ loadNetWorth: vi.fn() }));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const m = { member: vi.mocked(requireHouseholdMember), personal: vi.mocked(ensurePersonalHousehold), load: vi.mocked(loadNetWorth) };

// Invented data only.
const sample = { currency: 'BRL', incomeBasis: 'realized', months: [{ month: '2026-11', cash: 1500, investments: 0, reserves: 0, fgts: 0, cardDebt: 0, total: 1500, savings: { income: 0, expense: 0, surplus: 0, contributed: 0, rate: null } }], composition: [] };

describe('GET /dashboard/net-worth', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(dashboardRoutes, { prefix: '/dashboard' });
    await app.ready();
  });
  afterAll(() => app.close());
  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.personal.mockResolvedValue(HH);
    m.load.mockResolvedValue(sample as never);
  });

  const get = (qs: string, headers: Record<string, string> = AUTH) => app.inject({ method: 'GET', url: `/dashboard/net-worth${qs}`, headers });

  it('answers 401 without credentials, before anything else', async () => {
    expect((await get(`?householdId=${HH}`, {})).statusCode).toBe(401);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.load).not.toHaveBeenCalled();
  });

  it('checks the membership, defaults to 12 months and returns the data in the envelope', async () => {
    const res = await get(`?householdId=${HH}`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, months: 12 });
    expect(res.json()).toEqual({ success: true, data: sample });
  });

  it('passes the months through and uses the personal household when none is given', async () => {
    await get('?months=6');
    expect(m.personal).toHaveBeenCalled();
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, months: 6 });
  });

  it('answers 403 to a non-member before touching the data', async () => {
    m.member.mockRejectedValueOnce(new ForbiddenError());
    expect((await get(`?householdId=${HH}`)).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });

  it.each(['?months=0', '?months=37', '?months=abc', '?householdId=nope'])('invalid parameters (%s) answer 400 and nothing is loaded', async (qs) => {
    expect((await get(qs)).statusCode).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });
});
