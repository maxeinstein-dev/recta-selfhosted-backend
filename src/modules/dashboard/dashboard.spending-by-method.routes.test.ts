import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { loadSpendingByMethod } from './spending-by-method.loader.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireHouseholdMember: vi.fn(),
  requireEditor: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('./spending-by-method.loader.js', () => ({ loadSpendingByMethod: vi.fn() }));
vi.mock('./income-split.loader.js', () => ({ loadIncomeSplit: vi.fn() }));
vi.mock('./month-close.js', () => ({ loadMonthClose: vi.fn(), saveMonthClosing: vi.fn() }));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./net-worth.loader.js', () => ({ loadNetWorth: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const m = { member: vi.mocked(requireHouseholdMember), personal: vi.mocked(ensurePersonalHousehold), load: vi.mocked(loadSpendingByMethod) };
const sample = {
  basis: 'own-share',
  months: [{ month: '2026-11', credit: 300, other: 100, total: 400, creditShare: 0.75 }],
  totals: { credit: 300, other: 100, total: 400, creditShare: 0.75 },
};

describe('GET /dashboard/spending-by-method', () => {
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
    m.load.mockResolvedValue(sample as never);
  });
  const get = (qs: string, headers: Record<string, string> = AUTH) => app.inject({ method: 'GET', url: `/dashboard/spending-by-method${qs}`, headers });

  it('answers 401 without credentials', async () => {
    expect((await get('', {})).statusCode).toBe(401);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('defaults to six months up to the current month, in the personal household, and returns the loader result', async () => {
    const res = await get('');
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ success: true, data: sample });
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, months: 6, to: undefined });
  });

  it('passes the household, the months and the last month asked for', async () => {
    await get(`?householdId=${HH}&months=3&to=2026-10`);
    expect(m.personal).not.toHaveBeenCalled();
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, months: 3, to: '2026-10' });
  });

  it('validates the query (400)', async () => {
    for (const qs of ['?months=0', '?months=13', '?months=x', '?to=2026-13', '?to=2026-1', '?householdId=abc']) {
      expect((await get(qs)).statusCode, qs).toBe(400);
    }
    expect(m.load).not.toHaveBeenCalled();
  });

  it('refuses a non-member (403) before reading anything', async () => {
    m.member.mockRejectedValue(new ForbiddenError('Not a member'));
    expect((await get(`?householdId=${HH}`)).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });
});
