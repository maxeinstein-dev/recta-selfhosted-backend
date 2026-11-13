import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { loadIncomeSplit } from './income-split.loader.js';

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
vi.mock('./income-split.loader.js', () => ({ loadIncomeSplit: vi.fn() }));
vi.mock('./month-close.js', () => ({ loadMonthClose: vi.fn(), saveMonthClosing: vi.fn() }));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./net-worth.loader.js', () => ({ loadNetWorth: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const m = { member: vi.mocked(requireHouseholdMember), personal: vi.mocked(ensurePersonalHousehold), load: vi.mocked(loadIncomeSplit) };
const sample = {
  month: '2026-11',
  income: { amount: 1000, basis: 'expected' },
  groups: [{ id: null, key: 'OTHER', name: 'Outros', color: null, isHousing: false, sortOrder: 0, realized: 10, committed: 0, amount: 10, percentOfIncome: 0.01 }],
  totalSpent: 10,
  leftover: { amount: 990, percentOfIncome: 0.99 },
  housing: { amount: 0, percentOfIncome: 0, reference: 0.3, housingGroups: 0 },
};

describe('GET /dashboard/income-split', () => {
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
  const get = (qs: string, headers: Record<string, string> = AUTH) => app.inject({ method: 'GET', url: `/dashboard/income-split${qs}`, headers });

  it('answers 401 without credentials', async () => {
    expect((await get('?month=2026-11', {})).statusCode).toBe(401);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('checks the membership and returns the split in the envelope, with nulls kept', async () => {
    m.load.mockResolvedValue({ ...sample, leftover: { amount: -10, percentOfIncome: null } } as never);
    const res = await get(`?householdId=${HH}&month=2026-11`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, month: '2026-11' });
    expect(res.json()).toEqual({ success: true, data: { ...sample, leftover: { amount: -10, percentOfIncome: null } } });
  });

  it('falls back to the personal household', async () => {
    await get('?month=2026-11');
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, month: '2026-11' });
  });

  it('refuses a missing or malformed month', async () => {
    expect((await get('')).statusCode).toBe(400);
    expect((await get('?month=2026-13')).statusCode).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('loads nothing for someone outside the household', async () => {
    m.member.mockRejectedValue(new ForbiddenError('no'));
    expect((await get(`?householdId=${HH}&month=2026-11`)).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });
});
