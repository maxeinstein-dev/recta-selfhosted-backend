import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { ZodTypeAny } from 'zod';

import { NotFoundError } from '../../shared/errors/app-error.js';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import { requireEditor, requireHouseholdMember } from '../../shared/middleware/authorization.middleware.js';
import {
  createEmploymentSchema,
  eventsHouseholdQuerySchema,
  eventsQuerySchema,
  fgtsBalanceSchema,
  fgtsBalanceUpdateSchema,
  fgtsModeSchema,
  fgtsModeUpdateSchema,
  fgtsWithdrawalSchema,
  fgtsWithdrawalUpdateSchema,
  householdHintQuerySchema,
  idParamSchema,
  itemSchema,
  itemUpdateSchema,
  itemValueSchema,
  itemValueUpdateSchema,
  listEmploymentsQuerySchema,
  salarySchema,
  salaryUpdateSchema,
  simulateGrossSchema,
  simulateNetSchema,
  subParamSchema,
  updateEmploymentSchema,
  vacationSchema,
  vacationUpdateSchema,
  valueParamSchema,
} from './payroll.schema.js';
import {
  createEmployment,
  deleteEmployment,
  fgtsBalances,
  fgtsModes,
  fgtsWithdrawals,
  findEmploymentHousehold,
  getEmployment,
  getEmploymentEvents,
  getHouseholdEvents,
  itemValues,
  items,
  listEmployments,
  salaries,
  simulateGross,
  simulateNet,
  updateEmployment,
  vacations,
  type SubService,
} from './payroll.service.js';

type Access = 'member' | 'editor';

/**
 * Household of a route keyed by the employment id: with a `householdId` hint it is authorized first and scopes the
 * lookup (a foreign id is a 404 inside it); without one it is read from the record, and a caller who is not a member
 * gets the same 404 as for an id that does not exist.
 */
async function employmentHousehold(request: FastifyRequest, id: string, hint: string | undefined, access: Access): Promise<string> {
  if (hint) {
    if (access === 'editor') await requireEditor(request, hint);
    else await requireHouseholdMember(request, hint);
    return hint;
  }
  const householdId = await findEmploymentHousehold(id);
  if (!householdId) throw new NotFoundError('Employment');
  try {
    await requireHouseholdMember(request, householdId);
  } catch (error) {
    // Not an instanceof check: AppError subclasses all end up with AppError's prototype.
    if ((error as { code?: string }).code === 'FORBIDDEN') throw new NotFoundError('Employment');
    throw error;
  }
  if (access === 'editor') await requireEditor(request, householdId);
  return householdId;
}

const docs = (description: string) => ({ description, tags: ['Payroll'], security: [{ bearerAuth: [] }] });

interface SubResource {
  path: string;
  label: string;
  service: SubService;
  create: ZodTypeAny;
  update: ZodTypeAny;
}

const SUBS: SubResource[] = [
  { path: 'salaries', label: 'gross salary entries (value and start date)', service: salaries, create: salarySchema, update: salaryUpdateSchema },
  { path: 'items', label: 'fixed payslip items (with their value history under /items/:subId/values)', service: items, create: itemSchema, update: itemUpdateSchema },
  { path: 'vacations', label: 'marked vacations (exact dates, or only the month = estimated)', service: vacations, create: vacationSchema, update: vacationUpdateSchema },
  { path: 'fgts-balances', label: 'FGTS balances informed from the statement', service: fgtsBalances, create: fgtsBalanceSchema, update: fgtsBalanceUpdateSchema },
  { path: 'fgts-withdrawals', label: 'dated FGTS withdrawals (birthday, termination, other)', service: fgtsWithdrawals, create: fgtsWithdrawalSchema, update: fgtsWithdrawalUpdateSchema },
  { path: 'fgts-modes', label: 'FGTS withdrawal mode history (termination or birthday + month)', service: fgtsModes, create: fgtsModeSchema, update: fgtsModeUpdateSchema },
];

/** /payroll: employment (CLT), simulation and forecast events. */
export async function payrollRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authMiddleware());

  // Simulation: no household, no employment -------------------------------------
  app.post('/simulate/net', { schema: docs('Gross to net of one month with the full composition (no employment needed)') }, async (request, reply) => {
    const data = simulateNet(simulateNetSchema.parse(request.body));
    return reply.send({ success: true, data });
  });

  app.post('/simulate/gross', { schema: docs('Net to gross: the smallest gross whose net reaches the target (no employment needed)') }, async (request, reply) => {
    const data = simulateGross(simulateGrossSchema.parse(request.body));
    return reply.send({ success: true, data });
  });

  // Employments ---------------------------------------------------------------------
  app.get('/employments', { schema: docs('List the employments of a household, with their sub-resources (read: member)') }, async (request, reply) => {
    const query = listEmploymentsQuerySchema.parse(request.query);
    await requireHouseholdMember(request, query.householdId);
    return reply.send({ success: true, data: await listEmployments(query.householdId) });
  });

  app.post('/employments', { schema: docs('Create an employment; a household may have several (EDITOR+)') }, async (request, reply) => {
    const input = createEmploymentSchema.parse(request.body);
    await requireEditor(request, input.householdId);
    return reply.status(201).send({ success: true, data: await createEmployment(input) });
  });

  app.get('/events', { schema: docs('Forecast events of every active employment of the household in a period (read: member)') }, async (request, reply) => {
    const query = eventsHouseholdQuerySchema.parse(request.query);
    await requireHouseholdMember(request, query.householdId);
    return reply.send({ success: true, data: await getHouseholdEvents(query.householdId, query) });
  });

  app.get('/employments/:id', { schema: docs('One employment with its sub-resources (read: member)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await employmentHousehold(request, id, hint, 'member');
    return reply.send({ success: true, data: await getEmployment(householdId, id) });
  });

  app.patch('/employments/:id', { schema: docs('Update an employment (EDITOR+)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const input = updateEmploymentSchema.parse(request.body);
    const householdId = await employmentHousehold(request, id, hint, 'editor');
    return reply.send({ success: true, data: await updateEmployment(householdId, id, input) });
  });

  app.delete('/employments/:id', { schema: docs('Delete an employment and everything under it (EDITOR+)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await employmentHousehold(request, id, hint, 'editor');
    await deleteEmployment(householdId, id);
    return reply.status(204).send();
  });

  app.get('/employments/:id/events', { schema: docs('Forecast events of one employment: monthly salary with composition, 13th installments, vacations, birthday FGTS withdrawal, FGTS deposits and estimated balance (read: member)') }, async (request, reply) => {
    const { id } = idParamSchema.parse(request.params);
    const query = eventsQuerySchema.parse(request.query);
    const householdId = await employmentHousehold(request, id, query.householdId, 'member');
    return reply.send({ success: true, data: await getEmploymentEvents(householdId, id, query) });
  });

  // Sub-resources (same shape for each) -----------------------------------------------
  for (const sub of SUBS) {
    const base = `/employments/:id/${sub.path}`;
    app.get(base, { schema: docs(`List the ${sub.label} (read: member)`) }, async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const { householdId: hint } = householdHintQuerySchema.parse(request.query);
      const householdId = await employmentHousehold(request, id, hint, 'member');
      return reply.send({ success: true, data: await sub.service.list(householdId, id) });
    });
    app.post(base, { schema: docs(`Add to the ${sub.label} (EDITOR+)`) }, async (request, reply) => {
      const { id } = idParamSchema.parse(request.params);
      const { householdId: hint } = householdHintQuerySchema.parse(request.query);
      const body = sub.create.parse(request.body);
      const householdId = await employmentHousehold(request, id, hint, 'editor');
      return reply.status(201).send({ success: true, data: await sub.service.create(householdId, id, body) });
    });
    app.patch(`${base}/:subId`, { schema: docs(`Update one of the ${sub.label} (EDITOR+)`) }, async (request, reply) => {
      const { id, subId } = subParamSchema.parse(request.params);
      const { householdId: hint } = householdHintQuerySchema.parse(request.query);
      const body = sub.update.parse(request.body);
      const householdId = await employmentHousehold(request, id, hint, 'editor');
      return reply.send({ success: true, data: await sub.service.update(householdId, id, subId, body) });
    });
    app.delete(`${base}/:subId`, { schema: docs(`Remove one of the ${sub.label} (EDITOR+)`) }, async (request, reply) => {
      const { id, subId } = subParamSchema.parse(request.params);
      const { householdId: hint } = householdHintQuerySchema.parse(request.query);
      const householdId = await employmentHousehold(request, id, hint, 'editor');
      await sub.service.remove(householdId, id, subId);
      return reply.status(204).send();
    });
  }

  // Value history of a fixed item ------------------------------------------------------
  const values = '/employments/:id/items/:subId/values';
  app.get(values, { schema: docs('Value history of a fixed item (read: member)') }, async (request, reply) => {
    const { id, subId } = subParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await employmentHousehold(request, id, hint, 'member');
    return reply.send({ success: true, data: await itemValues.list(householdId, id, subId) });
  });
  app.post(values, { schema: docs('Add a value to the history of a fixed item (EDITOR+)') }, async (request, reply) => {
    const { id, subId } = subParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const body = itemValueSchema.parse(request.body);
    const householdId = await employmentHousehold(request, id, hint, 'editor');
    return reply.status(201).send({ success: true, data: await itemValues.create(householdId, id, subId, body) });
  });
  app.patch(`${values}/:valueId`, { schema: docs('Update a value of a fixed item (EDITOR+)') }, async (request, reply) => {
    const { id, subId, valueId } = valueParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const body = itemValueUpdateSchema.parse(request.body);
    const householdId = await employmentHousehold(request, id, hint, 'editor');
    return reply.send({ success: true, data: await itemValues.update(householdId, id, subId, valueId, body) });
  });
  app.delete(`${values}/:valueId`, { schema: docs('Remove a value of a fixed item (EDITOR+)') }, async (request, reply) => {
    const { id, subId, valueId } = valueParamSchema.parse(request.params);
    const { householdId: hint } = householdHintQuerySchema.parse(request.query);
    const householdId = await employmentHousehold(request, id, hint, 'editor');
    await itemValues.remove(householdId, id, subId, valueId);
    return reply.status(204).send();
  });
}
