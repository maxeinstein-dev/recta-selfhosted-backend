import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { InsufficientRoleError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor } from '../../shared/middleware/authorization.middleware.js';
import { recurringTransactionRoutes } from './recurring-transactions.routes.js';
import * as service from './recurring-transactions.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
  ensurePersonalHousehold: vi.fn(),
}));
vi.mock('./recurring-detect.service.js', () => ({ detectRecurringTransactions: vi.fn(), applyDetectedRecurrences: vi.fn() }));
vi.mock('./recurring-transactions.service.js', () => ({ getRecurringTransaction: vi.fn(), payNextOccurrence: vi.fn() }));

const HH = '11111111-1111-4111-8111-111111111111';
const REC = '33333333-3333-4333-8333-333333333333';
const ACC = '22222222-2222-4222-8222-222222222222';
const AUTH = { authorization: 'Bearer test' };

const m = {
  editor: vi.mocked(requireEditor),
  get: vi.mocked(service.getRecurringTransaction),
  pay: vi.mocked(service.payNextOccurrence),
};

describe('POST /recurring-transactions/:id/pay-next', () => {
  let app: FastifyInstance;
  beforeAll(async () => {
    app = Fastify({ logger: false });
    app.setErrorHandler(errorHandler);
    await app.register(recurringTransactionRoutes, { prefix: '/recurring-transactions' });
    await app.ready();
  });
  afterAll(async () => {
    await app.close();
  });
  beforeEach(() => {
    vi.clearAllMocks();
    m.editor.mockResolvedValue({} as never);
    m.get.mockResolvedValue({ id: REC, householdId: HH } as never);
    m.pay.mockResolvedValue({ transaction: { id: 'tx-1', amount: 175 }, nextRunAt: new Date(Date.UTC(2027, 0, 10)), skipped: false } as never);
  });
  const post = (payload?: unknown, headers: Record<string, string> = AUTH, id = REC) =>
    app.inject({ method: 'POST', url: `/recurring-transactions/${id}/pay-next`, payload: payload as never, headers });

  it('answers 401 without credentials, before anything else', async () => {
    expect((await post({}, {})).statusCode).toBe(401);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.pay).not.toHaveBeenCalled();
  });

  it('needs an editor of the household of the recurrence: a viewer is refused and nothing is created', async () => {
    m.editor.mockRejectedValue(new InsufficientRoleError('EDITOR'));
    const res = await post({});
    expect(res.statusCode).toBe(403);
    expect(m.editor).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.pay).not.toHaveBeenCalled();
  });

  it('works with no body at all, and answers the created occurrence in the envelope', async () => {
    const res = await post();
    expect(res.statusCode).toBe(200);
    expect(m.pay).toHaveBeenCalledWith(REC, HH, {});
    const body = res.json();
    expect(body.success).toBe(true);
    expect(body.data.transaction).toMatchObject({ id: 'tx-1', amount: 175 });
    expect(body.data.nextRunAt).toBeDefined();
  });

  it('passes amount, date and accountId through', async () => {
    const res = await post({ amount: 180.5, date: '2026-12-04', accountId: ACC });
    expect(res.statusCode).toBe(200);
    expect(m.pay).toHaveBeenCalledWith(REC, HH, expect.objectContaining({ amount: 180.5, accountId: ACC, date: expect.any(Date) }));
  });

  it('refuses a body that is not valid (amount <= 0, account not a uuid, unknown date) with 400', async () => {
    for (const bad of [{ amount: 0 }, { amount: -5 }, { accountId: 'x' }, { date: 'tomorrow' }]) {
      expect((await post(bad)).statusCode, JSON.stringify(bad)).toBe(400);
    }
    expect(m.pay).not.toHaveBeenCalled();
  });
});
