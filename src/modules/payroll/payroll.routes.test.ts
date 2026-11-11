import Fastify, { type FastifyInstance } from 'fastify';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

import { ForbiddenError, InsufficientRoleError, NotFoundError } from '../../shared/errors/app-error.js';
import { errorHandler } from '../../shared/errors/error-handler.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import { payrollRoutes } from './payroll.routes.js';
import * as service from './payroll.service.js';

vi.mock('../../shared/middleware/auth.middleware.js', () => ({
  authMiddleware: () => async (request: { headers: Record<string, string | undefined> }) => {
    if (!request.headers.authorization) throw new (await import('../../shared/errors/app-error.js')).UnauthorizedError();
  },
  getAuthUser: () => ({ uid: 'firebase-1', email: 'user@example.com' }),
}));
vi.mock('../../shared/middleware/authorization.middleware.js', () => ({
  requireEditor: vi.fn(),
  requireHouseholdMember: vi.fn(),
}));

vi.mock('./payroll.service.js', () => ({
  createEmployment: vi.fn(),
  deleteEmployment: vi.fn(),
  findEmploymentHousehold: vi.fn(),
  getEmployment: vi.fn(),
  getEmploymentEvents: vi.fn(),
  getHouseholdEvents: vi.fn(),
  listEmployments: vi.fn(),
  updateEmployment: vi.fn(),
  simulateGross: vi.fn(),
  simulateNet: vi.fn(),
  salaries: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  items: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  vacations: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  fgtsBalances: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  fgtsWithdrawals: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  fgtsModes: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
  itemValues: { list: vi.fn(), create: vi.fn(), update: vi.fn(), remove: vi.fn() },
}));

const HH = '11111111-1111-4111-8111-111111111111';
const OTHER_HH = '99999999-9999-4999-8999-999999999999';
const EMP = '22222222-2222-4222-8222-222222222222';
const SUB = '33333333-3333-4333-8333-333333333333';
const VAL = '44444444-4444-4444-8444-444444444444';
const AUTH = { authorization: 'Bearer test' };

const m = {
  editor: vi.mocked(requireEditor),
  member: vi.mocked(requireHouseholdMember),
  find: vi.mocked(service.findEmploymentHousehold),
  get: vi.mocked(service.getEmployment),
  list: vi.mocked(service.listEmployments),
  create: vi.mocked(service.createEmployment),
  update: vi.mocked(service.updateEmployment),
  remove: vi.mocked(service.deleteEmployment),
  events: vi.mocked(service.getEmploymentEvents),
  householdEvents: vi.mocked(service.getHouseholdEvents),
  net: vi.mocked(service.simulateNet),
  gross: vi.mocked(service.simulateGross),
};

let app: FastifyInstance;

beforeAll(async () => {
  app = Fastify({ logger: false });
  app.setErrorHandler(errorHandler);
  await app.register(payrollRoutes, { prefix: '/payroll' });
  await app.ready();
});
afterAll(async () => {
  await app.close();
});
beforeEach(() => {
  vi.resetAllMocks();
  m.editor.mockResolvedValue({} as never);
  m.member.mockResolvedValue({} as never);
});

function call(method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown, headers: Record<string, string> = AUTH) {
  return app.inject({ method, url, payload: payload as never, headers });
}

const employmentBody = { householdId: HH, employer: 'Acme', admissionDate: '2025-01-10' };
const SUBS: Array<{ path: string; body: unknown }> = [
  { path: 'salaries', body: { amount: 3000, startDate: '2025-01-10' } },
  { path: 'items', body: { name: 'Allowance', value: { amount: 100, startDate: '2025-01-10' } } },
  { path: 'vacations', body: { month: '2027-01' } },
  { path: 'fgts-balances', body: { amount: 1000, asOfDate: '2026-01-10' } },
  { path: 'fgts-withdrawals', body: { amount: 100, date: '2026-05-04', kind: 'BIRTHDAY' } },
  { path: 'fgts-modes', body: { mode: 'BIRTHDAY', birthdayMonth: 5, startDate: '2026-01-01' } },
];

// Every route with a valid request and the access it needs
type Route = { name: string; method: 'GET' | 'POST' | 'PATCH' | 'DELETE'; url: string; body?: unknown; access: 'editor' | 'member' };
const ROUTES: Route[] = [
  { name: 'list employments', method: 'GET', url: `/payroll/employments?householdId=${HH}`, access: 'member' },
  { name: 'create employment', method: 'POST', url: '/payroll/employments', body: employmentBody, access: 'editor' },
  { name: 'household events', method: 'GET', url: `/payroll/events?householdId=${HH}`, access: 'member' },
  { name: 'get employment', method: 'GET', url: `/payroll/employments/${EMP}?householdId=${HH}`, access: 'member' },
  { name: 'update employment', method: 'PATCH', url: `/payroll/employments/${EMP}?householdId=${HH}`, body: { employer: 'Beta' }, access: 'editor' },
  { name: 'delete employment', method: 'DELETE', url: `/payroll/employments/${EMP}?householdId=${HH}`, access: 'editor' },
  { name: 'employment events', method: 'GET', url: `/payroll/employments/${EMP}/events?householdId=${HH}`, access: 'member' },
  ...SUBS.flatMap(({ path, body }): Route[] => [
    { name: `list ${path}`, method: 'GET', url: `/payroll/employments/${EMP}/${path}?householdId=${HH}`, access: 'member' },
    { name: `create ${path}`, method: 'POST', url: `/payroll/employments/${EMP}/${path}?householdId=${HH}`, body, access: 'editor' },
    { name: `update ${path}`, method: 'PATCH', url: `/payroll/employments/${EMP}/${path}/${SUB}?householdId=${HH}`, body: path === 'vacations' ? { sellDays: 2 } : path === 'fgts-modes' ? { startDate: '2026-02-01' } : path === 'items' ? { name: 'X' } : path === 'fgts-withdrawals' ? { note: 'n' } : path === 'fgts-balances' ? { amount: 1 } : { amount: 1 }, access: 'editor' },
    { name: `delete ${path}`, method: 'DELETE', url: `/payroll/employments/${EMP}/${path}/${SUB}?householdId=${HH}`, access: 'editor' },
  ]),
  { name: 'list item values', method: 'GET', url: `/payroll/employments/${EMP}/items/${SUB}/values?householdId=${HH}`, access: 'member' },
  { name: 'create item value', method: 'POST', url: `/payroll/employments/${EMP}/items/${SUB}/values?householdId=${HH}`, body: { amount: 120, startDate: '2026-07-01' }, access: 'editor' },
  { name: 'update item value', method: 'PATCH', url: `/payroll/employments/${EMP}/items/${SUB}/values/${VAL}?householdId=${HH}`, body: { amount: 130 }, access: 'editor' },
  { name: 'delete item value', method: 'DELETE', url: `/payroll/employments/${EMP}/items/${SUB}/values/${VAL}?householdId=${HH}`, access: 'editor' },
];

const everyService = () => [
  m.list, m.create, m.get, m.update, m.remove, m.events, m.householdEvents,
  ...[service.salaries, service.items, service.vacations, service.fgtsBalances, service.fgtsWithdrawals, service.fgtsModes, service.itemValues].flatMap((s) => [
    s.list, s.create, s.update, s.remove,
  ]).map((f) => vi.mocked(f as never)),
];

describe('authentication and authorization', () => {
  it.each(ROUTES)('$name: 401 without credentials, and nothing runs', async ({ method, url, body }) => {
    const res = await call(method, url, body, {});
    expect(res.statusCode).toBe(401);
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.member).not.toHaveBeenCalled();
  });

  it.each(ROUTES)('$name: authorizes the household before touching any data', async ({ method, url, body, access }) => {
    m.editor.mockRejectedValue(new InsufficientRoleError());
    m.member.mockRejectedValue(new ForbiddenError());
    if (access === 'member') m.editor.mockResolvedValue({} as never);
    const res = await call(method, url, body);
    expect(res.statusCode).toBe(403);
    for (const s of everyService()) expect(s).not.toHaveBeenCalled();
  });

  it.each(ROUTES.filter((r) => r.access === 'editor'))('$name: a viewer (member only) cannot write', async ({ method, url, body }) => {
    m.editor.mockRejectedValue(new InsufficientRoleError());
    const res = await call(method, url, body);
    expect(res.statusCode).toBe(403);
  });
});

describe('employment of another household', () => {
  it('without a household hint, a non-member gets the same 404 as for a missing employment', async () => {
    m.find.mockResolvedValue(OTHER_HH);
    m.member.mockRejectedValue(new ForbiddenError());
    const foreign = await call('GET', `/payroll/employments/${EMP}`);
    m.find.mockResolvedValue(null);
    const missing = await call('GET', `/payroll/employments/${EMP}`);
    expect(foreign.statusCode).toBe(404);
    expect(missing.statusCode).toBe(404);
    expect(foreign.json().error.code).toBe(missing.json().error.code);
    expect(foreign.json().error.message).toBe(missing.json().error.message);
    expect(m.get).not.toHaveBeenCalled();
  });

  it('a write without a hint also answers 404 to a non-member, and never reaches the service', async () => {
    m.find.mockResolvedValue(OTHER_HH);
    m.member.mockRejectedValue(new ForbiddenError());
    const res = await call('PATCH', `/payroll/employments/${EMP}`, { employer: 'Beta' });
    expect(res.statusCode).toBe(404);
    expect(m.update).not.toHaveBeenCalled();
  });

  it('with the hint, the service is scoped to that household and answers 404 for a foreign id', async () => {
    m.get.mockRejectedValue(new NotFoundError('Employment'));
    const res = await call('GET', `/payroll/employments/${EMP}?householdId=${HH}`);
    expect(res.statusCode).toBe(404);
    expect(m.get).toHaveBeenCalledWith(HH, EMP);
  });

  it('sub-resource routes resolve the household of the employment and pass it down', async () => {
    m.find.mockResolvedValue(HH);
    vi.mocked(service.salaries.list).mockResolvedValue([]);
    const res = await call('GET', `/payroll/employments/${EMP}/salaries`);
    expect(res.statusCode).toBe(200);
    expect(service.salaries.list).toHaveBeenCalledWith(HH, EMP);
  });
});

describe('employment', () => {
  it('creates with the defaults of the user habit: pay day 5, 13th in June and December, CLT, several allowed', async () => {
    m.create.mockResolvedValue({ id: EMP } as never);
    const res = await call('POST', '/payroll/employments', employmentBody);
    expect(res.statusCode).toBe(201);
    expect(m.create).toHaveBeenCalledWith(
      expect.objectContaining({
        regime: 'CLT',
        payDay: 5,
        dependents: 0,
        bracketMethod: 'DEDUCTION',
        rounding: 'TRUNCATE',
        thirteenthFirstMonth: 6,
        thirteenthFirstDay: 30,
        thirteenthSecondMonth: 12,
        thirteenthSecondDay: 20,
        isActive: true,
      }),
    );
  });

  it('refuses a regime that is not CLT (nothing else exists yet)', async () => {
    const res = await call('POST', '/payroll/employments', { ...employmentBody, regime: 'PJ' });
    expect(res.statusCode).toBe(400);
    expect(m.create).not.toHaveBeenCalled();
  });

  it('refuses bad input: pay day, month, date', async () => {
    for (const bad of [{ payDay: 32 }, { thirteenthFirstMonth: 13 }, { admissionDate: '2025-02-30' }, { employer: '' }, { dependents: -1 }]) {
      const res = await call('POST', '/payroll/employments', { ...employmentBody, ...bad });
      expect(res.statusCode).toBe(400);
    }
    expect(m.create).not.toHaveBeenCalled();
  });

  it('an empty patch is refused', async () => {
    expect((await call('PATCH', `/payroll/employments/${EMP}?householdId=${HH}`, {})).statusCode).toBe(400);
  });

  it('delete answers 204', async () => {
    m.remove.mockResolvedValue(undefined);
    expect((await call('DELETE', `/payroll/employments/${EMP}?householdId=${HH}`)).statusCode).toBe(204);
    expect(m.remove).toHaveBeenCalledWith(HH, EMP);
  });
});

describe('sub-resource validation', () => {
  const post = (path: string, body: unknown) => call('POST', `/payroll/employments/${EMP}/${path}?householdId=${HH}`, body);

  it('vacation: a start date or only the month, never both or neither; sold days at most 10', async () => {
    expect((await post('vacations', { startDate: '2027-01-04', month: '2027-01' })).statusCode).toBe(400);
    expect((await post('vacations', {})).statusCode).toBe(400);
    expect((await post('vacations', { month: '2027-13' })).statusCode).toBe(400);
    expect((await post('vacations', { month: '2027-01', sellDays: 11 })).statusCode).toBe(400);
    expect((await post('vacations', { startDate: '2027-01-04', days: 25, sellDays: 10 })).statusCode).toBe(400);
  });

  it('FGTS mode: the birthday mode needs its month, the termination mode has none', async () => {
    expect((await post('fgts-modes', { mode: 'BIRTHDAY', startDate: '2026-01-01' })).statusCode).toBe(400);
    expect((await post('fgts-modes', { mode: 'TERMINATION', birthdayMonth: 5, startDate: '2026-01-01' })).statusCode).toBe(400);
    vi.mocked(service.fgtsModes.create).mockResolvedValue({} as never);
    expect((await post('fgts-modes', { mode: 'TERMINATION', startDate: '2026-01-01' })).statusCode).toBe(201);
    expect((await post('fgts-modes', { mode: 'BIRTHDAY', birthdayMonth: 5, expectedAmount: 800, startDate: '2026-01-01' })).statusCode).toBe(201);
  });

  it('FGTS withdrawal: a kind among birthday, termination and other', async () => {
    expect((await post('fgts-withdrawals', { amount: 10, date: '2026-05-04', kind: 'WHATEVER' })).statusCode).toBe(400);
  });

  it('salary: positive amount and a real date', async () => {
    expect((await post('salaries', { amount: 0, startDate: '2026-01-01' })).statusCode).toBe(400);
    expect((await post('salaries', { amount: 10, startDate: '2026-02-30' })).statusCode).toBe(400);
  });
});

describe('simulation and events', () => {
  it('simulate net/gross need a login but no household and no employment', async () => {
    m.net.mockReturnValue({ payroll: {} } as never);
    m.gross.mockReturnValue({} as never);
    expect((await call('POST', '/payroll/simulate/net', { gross: 4000 }, {})).statusCode).toBe(401);
    expect((await call('POST', '/payroll/simulate/net', { gross: 4000 })).statusCode).toBe(200);
    expect((await call('POST', '/payroll/simulate/gross', { targetNet: 3000 })).statusCode).toBe(200);
    expect(m.member).not.toHaveBeenCalled();
    expect(m.editor).not.toHaveBeenCalled();
    expect(m.net).toHaveBeenCalledWith(expect.objectContaining({ gross: 4000, dependents: 0, items: [], bracketMethod: 'DEDUCTION', rounding: 'TRUNCATE' }));
  });

  it('simulation refuses invalid input', async () => {
    expect((await call('POST', '/payroll/simulate/net', { gross: -1 })).statusCode).toBe(400);
    expect((await call('POST', '/payroll/simulate/net', { gross: 100, workedDays: 31 })).statusCode).toBe(400);
    expect((await call('POST', '/payroll/simulate/gross', { targetNet: 0 })).statusCode).toBe(400);
  });

  it('events: the period is validated and forwarded', async () => {
    m.find.mockResolvedValue(HH);
    m.events.mockResolvedValue({ salary: [] } as never);
    expect((await call('GET', `/payroll/employments/${EMP}/events?from=2026-12-01&to=2026-01-01`)).statusCode).toBe(400);
    expect((await call('GET', `/payroll/employments/${EMP}/events?from=2026-01-01&to=2040-01-01`)).statusCode).toBe(400);
    const ok = await call('GET', `/payroll/employments/${EMP}/events?from=2026-11-01&to=2027-01-31`);
    expect(ok.statusCode).toBe(200);
    expect(m.events).toHaveBeenCalledWith(HH, EMP, expect.objectContaining({ from: '2026-11-01', to: '2027-01-31' }));
  });

  it('household events add every active employment (the service decides), member access only', async () => {
    m.householdEvents.mockResolvedValue({ employments: [] } as never);
    const res = await call('GET', `/payroll/events?householdId=${HH}`);
    expect(res.statusCode).toBe(200);
    expect(m.member).toHaveBeenCalledWith(expect.anything(), HH);
    expect(m.editor).not.toHaveBeenCalled();
  });
});
