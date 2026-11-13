import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { dashboardRoutes } from './dashboard.routes.js';
import { loadMonthClose, saveMonthClosing } from './month-close.js';

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
vi.mock('./month-close.js', () => ({ loadMonthClose: vi.fn(), saveMonthClosing: vi.fn() }));
vi.mock('./cash-flow.loader.js', () => ({ loadCashFlow: vi.fn() }));
vi.mock('./dashboard.service.js', () => ({}));

const HH = '11111111-1111-4111-8111-111111111111';
const AUTH = { authorization: 'Bearer test' };
const m = { editor: vi.mocked(requireEditor), save: vi.mocked(saveMonthClosing), member: vi.mocked(requireHouseholdMember), personal: vi.mocked(ensurePersonalHousehold), load: vi.mocked(loadMonthClose) };
const sample = { month: '2026-10', accounts: [], cards: [], general: { ok: true, blockers: [] }, ok: true };

describe('GET /dashboard/month-close', () => {
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
  const get = (qs: string, headers: Record<string, string> = AUTH) => app.inject({ method: 'GET', url: `/dashboard/month-close${qs}`, headers });

  it('answers 401 without credentials, before anything else', async () => {
    expect((await get(`?month=2026-10`, {})).statusCode).toBe(401);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.load).not.toHaveBeenCalled();
  });

  it('checks the membership and returns the close in the envelope', async () => {
    const res = await get(`?householdId=${HH}&month=2026-10`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, month: '2026-10' });
    expect(res.json()).toEqual({ success: true, data: sample });
  });

  it('falls back to the personal household', async () => {
    await get('?month=2026-10');
    expect(m.load).toHaveBeenCalledWith({ householdId: HH, month: '2026-10' });
  });

  it('refuses a missing or malformed month', async () => {
    expect((await get('')).statusCode).toBe(400);
    expect((await get('?month=2026-13')).statusCode).toBe(400);
    expect((await get('?month=10-2026')).statusCode).toBe(400);
    expect(m.load).not.toHaveBeenCalled();
  });

  it('does not load anything for someone outside the household', async () => {
    m.member.mockRejectedValue(new ForbiddenError('no'));
    expect((await get(`?householdId=${HH}&month=2026-10`)).statusCode).toBe(403);
    expect(m.load).not.toHaveBeenCalled();
  });
});

describe('POST /dashboard/month-close', () => {
  let app: FastifyInstance;
  const ACC = '22222222-2222-4222-8222-222222222222';
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
    m.editor.mockResolvedValue({ userId: 'user-1' } as never);
    m.personal.mockResolvedValue(HH);
    m.save.mockResolvedValue({ month: '2026-10' } as never);
  });
  const post = (body: unknown, headers: Record<string, string> = AUTH) => app.inject({ method: 'POST', url: '/dashboard/month-close', headers, payload: body as object });
  const valid = { householdId: HH, month: '2026-10', accountId: ACC, informedBalance: 1234.5 };

  it('answers 401 without credentials, before anything else', async () => {
    expect((await post(valid, {})).statusCode).toBe(401);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.save).not.toHaveBeenCalled();
  });

  it('needs an editor and records with the editor as the author', async () => {
    const res = await post(valid);
    expect(res.statusCode).toBe(200);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.save).toHaveBeenCalledWith({ householdId: HH, month: '2026-10', accountId: ACC, informedBalance: 1234.5, userId: 'user-1' });
  });

  it('writes nothing for a viewer', async () => {
    m.editor.mockRejectedValue(new ForbiddenError('viewer'));
    expect((await post(valid)).statusCode).toBe(403);
    expect(m.save).not.toHaveBeenCalled();
  });

  it('refuses a bad month, a missing or non-numeric balance and a bad account', async () => {
    for (const bad of [{ ...valid, month: '2026-00' }, { ...valid, informedBalance: '10' }, { ...valid, informedBalance: undefined }, { ...valid, accountId: 'x' }, { ...valid, informedBalance: 1e15 }]) {
      expect((await post(bad)).statusCode).toBe(400);
    }
    expect(m.save).not.toHaveBeenCalled();
  });
});
