import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { ensurePersonalHousehold, requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { savingsGoalRoutes } from './savings-goals.routes.js';
import * as service from './savings-goals.service.js';
import * as contributions from './savings-goals.contributions.js';

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
vi.mock('./savings-goals.service.js', () => ({ getSavingsGoal: vi.fn(), savingsSummary: vi.fn() }));
vi.mock('./savings-goals.contributions.js', () => ({ contribute: vi.fn(), undoContribution: vi.fn(), listContributions: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const GOAL = '33333333-3333-4333-8333-333333333333';
const CONTRIB = '44444444-4444-4444-8444-444444444444';
const AUTH = { authorization: 'Bearer test' };

const m = {
  member: vi.mocked(requireHouseholdMember),
  editor: vi.mocked(requireEditor),
  personal: vi.mocked(ensurePersonalHousehold),
  getGoal: vi.mocked(service.getSavingsGoal),
  summary: vi.mocked(service.savingsSummary),
  contribute: vi.mocked(contributions.contribute),
  undo: vi.mocked(contributions.undoContribution),
  list: vi.mocked(contributions.listContributions),
};

describe('savings goal contribution routes', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(savingsGoalRoutes, { prefix: '/savings-goals' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.member.mockResolvedValue({} as never);
    m.editor.mockResolvedValue({} as never);
    m.personal.mockResolvedValue(HH);
    m.getGoal.mockResolvedValue({ id: GOAL, householdId: HH } as never);
  });

  const post = (payload: unknown, headers: Record<string, string> = AUTH) =>
    app.inject({ method: 'POST', url: `/savings-goals/${GOAL}/contributions`, headers, payload: payload as never });

  it('401 without credentials, before anything else', async () => {
    expect((await post({ amount: 10 }, {})).statusCode).toBe(401);
    expect(m.contribute).not.toHaveBeenCalled();
  });

  it('contributing needs EDITOR on the goal household; a viewer is stopped before anything is written', async () => {
    m.editor.mockRejectedValueOnce(new ForbiddenError());
    expect((await post({ amount: 10 })).statusCode).toBe(403);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.contribute).not.toHaveBeenCalled();
  });

  it('passes the household of the GOAL (never one from the body) and answers 201 in the envelope', async () => {
    m.contribute.mockResolvedValue({ contribution: { id: CONTRIB, amount: 10 }, goal: { id: GOAL, currentAmount: 10 } } as never);
    const res = await post({ amount: 10, householdId: '99999999-9999-4999-8999-999999999999' });
    expect(res.statusCode).toBe(201);
    expect(m.contribute).toHaveBeenCalledWith(expect.objectContaining({ goalId: GOAL, householdId: HH, amount: 10, confirmDuplicate: false }));
    expect(res.json()).toMatchObject({ success: true, data: { contribution: { id: CONTRIB } } });
  });

  it('accepts an empty body (the planned amount) and rejects nonsense with 400', async () => {
    m.contribute.mockResolvedValue({ contribution: {}, goal: {} } as never);
    expect((await post({})).statusCode).toBe(201);
    expect((await post({ amount: -5 })).statusCode).toBe(400);
    expect((await post({ date: '12/11/2026' })).statusCode).toBe(400);
  });

  it('undo needs EDITOR and is scoped to the goal household', async () => {
    m.undo.mockResolvedValue({ undone: {}, goal: {} } as never);
    const res = await app.inject({ method: 'DELETE', url: `/savings-goals/${GOAL}/contributions/${CONTRIB}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.undo).toHaveBeenCalledWith({ goalId: GOAL, householdId: HH, contributionId: CONTRIB });
    m.editor.mockRejectedValueOnce(new ForbiddenError());
    expect((await app.inject({ method: 'DELETE', url: `/savings-goals/${GOAL}/contributions/${CONTRIB}`, headers: AUTH })).statusCode).toBe(403);
  });

  it('listing only needs membership', async () => {
    m.list.mockResolvedValue([{ id: CONTRIB, amount: 10 }] as never);
    const res = await app.inject({ method: 'GET', url: `/savings-goals/${GOAL}/contributions?month=2026-11`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.list).toHaveBeenCalledWith({ goalId: GOAL, householdId: HH, month: '2026-11' });
  });

  it('the summary is not swallowed by /:goalId and checks the membership', async () => {
    m.summary.mockResolvedValue({ accounts: [], totalAllocated: 0 });
    const res = await app.inject({ method: 'GET', url: `/savings-goals/summary?householdId=${HH}`, headers: AUTH });
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.summary).toHaveBeenCalledWith(HH);
  });
});
