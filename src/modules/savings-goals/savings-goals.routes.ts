import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
} from '../../shared/middleware/authorization.middleware.js';
import {
  createSavingsGoalSchema,
  updateSavingsGoalSchema,
  addToSavingsGoalSchema,
  savingsGoalIdParamSchema,
  listSavingsGoalsQuerySchema,
  contributeSchema,
  contributionParamsSchema,
  contributionsQuerySchema,
} from './savings-goals.schema.js';
import * as savingsGoalsService from './savings-goals.service.js';
import * as contributions from './savings-goals.contributions.js';

export async function savingsGoalRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /savings-goals
   * List savings goals for a household
   * If householdId is not provided, uses personal household automatically
   */
  app.get('/', {
    schema: {
      description: 'List savings goals for a household',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'array', items: { type: 'object', additionalProperties: true } },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = listSavingsGoalsQuerySchema.parse(request.query);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    
    await requireHouseholdMember(request, householdId);

    const goals = await savingsGoalsService.listSavingsGoals({ ...query, householdId });

    return reply.send({
      success: true,
      data: goals,
    });
  });

  const dataResponse = {
    200: {
      type: 'object',
      properties: {
        success: { type: 'boolean' },
        data: { type: 'object', additionalProperties: true },
      },
    },
  };
  const goalIdParams = {
    type: 'object',
    required: ['goalId'],
    properties: { goalId: { type: 'string', format: 'uuid' } },
  };

  /**
   * GET /savings-goals/summary
   * Per account that holds goals: balance (unchanged by goals), kept in goals, free balance
   */
  app.get('/summary', {
    schema: {
      description: 'Balance, kept in goals and free balance of each account that holds savings goals',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      querystring: { type: 'object', properties: { householdId: { type: 'string', format: 'uuid' } } },
      response: dataResponse,
    },
  }, async (request, reply) => {
    const query = listSavingsGoalsQuerySchema.parse(request.query);
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);
    return reply.send({ success: true, data: await savingsGoalsService.savingsSummary(householdId) });
  });

  /**
   * POST /savings-goals/:goalId/contributions
   * Put money in the goal ("guardar agora") (EDITOR+). 409 when the month already has one, unless confirmDuplicate.
   */
  app.post<{ Params: { goalId: string } }>('/:goalId/contributions', {
    schema: {
      description: 'Register a contribution to a savings goal (EDITOR+). Creates no transaction and does not change the account balance',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      params: goalIdParams,
      response: { 201: dataResponse[200] },
    },
  }, async (request, reply) => {
    const { goalId } = savingsGoalIdParamSchema.parse(request.params);
    const input = contributeSchema.parse(request.body ?? {});
    const existing = await savingsGoalsService.getSavingsGoal(goalId);
    await requireEditor(request, existing.householdId);
    const data = await contributions.contribute({ goalId, householdId: existing.householdId, ...input });
    return reply.status(201).send({ success: true, data });
  });

  /**
   * GET /savings-goals/:goalId/contributions?month=YYYY-MM
   */
  app.get<{ Params: { goalId: string } }>('/:goalId/contributions', {
    schema: {
      description: 'List the contributions of a savings goal',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      params: goalIdParams,
      querystring: { type: 'object', properties: { month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' } } },
      response: { 200: { type: 'object', properties: { success: { type: 'boolean' }, data: { type: 'array', items: { type: 'object', additionalProperties: true } } } } },
    },
  }, async (request, reply) => {
    const { goalId } = savingsGoalIdParamSchema.parse(request.params);
    const query = contributionsQuerySchema.parse(request.query);
    const existing = await savingsGoalsService.getSavingsGoal(goalId);
    await requireHouseholdMember(request, existing.householdId);
    const data = await contributions.listContributions({ goalId, householdId: existing.householdId, month: query.month });
    return reply.send({ success: true, data });
  });

  /**
   * DELETE /savings-goals/:goalId/contributions/:contributionId
   * Undo a contribution (EDITOR+): deletes it and gives the amount back to the goal
   */
  app.delete<{ Params: { goalId: string; contributionId: string } }>('/:goalId/contributions/:contributionId', {
    schema: {
      description: 'Undo a contribution to a savings goal (EDITOR+)',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      params: {
        type: 'object',
        required: ['goalId', 'contributionId'],
        properties: { goalId: { type: 'string', format: 'uuid' }, contributionId: { type: 'string', format: 'uuid' } },
      },
      response: dataResponse,
    },
  }, async (request, reply) => {
    const { goalId, contributionId } = contributionParamsSchema.parse(request.params);
    const existing = await savingsGoalsService.getSavingsGoal(goalId);
    await requireEditor(request, existing.householdId);
    const data = await contributions.undoContribution({ goalId, householdId: existing.householdId, contributionId });
    return reply.send({ success: true, data });
  });

  /**
   * POST /savings-goals
   * Create a new savings goal (EDITOR+)
   * If householdId is not provided, creates a personal household automatically
   */
  app.post('/', {
    schema: {
      description: 'Create a new savings goal (EDITOR+)',
      tags: ['Savings Goals'],
      security: [{ bearerAuth: [] }],
      body: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          targetAmount: { type: 'number' },
        },
      },
      response: {
        201: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: { type: 'object', additionalProperties: true },
          },
        },
      },
    },
  }, async (request, reply) => {
    const input = createSavingsGoalSchema.parse(request.body);
    
    // If no householdId provided, ensure user has a personal household
    const householdId = input.householdId || await ensurePersonalHousehold(request);
    
    // Verify user has access to the household
    await requireEditor(request, householdId);

    const goal = await savingsGoalsService.createSavingsGoal({
      ...input,
      householdId,
    });

    return reply.status(201).send({
      success: true,
      data: goal,
    });
  });

  /**
   * GET /savings-goals/:goalId
   * Get savings goal details
   */
  app.get<{ Params: { goalId: string } }>(
    '/:goalId',
    {
      schema: {
        description: 'Get savings goal details',
        tags: ['Savings Goals'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['goalId'],
          properties: {
            goalId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { goalId } = savingsGoalIdParamSchema.parse(request.params);
      const goal = await savingsGoalsService.getSavingsGoal(goalId);

      // Verify user has access to the household
      await requireHouseholdMember(request, goal.householdId);

      return reply.send({
        success: true,
        data: goal,
      });
    }
  );

  /**
   * PATCH /savings-goals/:goalId
   * Update savings goal (EDITOR+)
   */
  app.patch<{ Params: { goalId: string } }>(
    '/:goalId',
    {
      schema: {
        description: 'Update savings goal (EDITOR+)',
        tags: ['Savings Goals'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['goalId'],
          properties: {
            goalId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { goalId } = savingsGoalIdParamSchema.parse(request.params);
      const input = updateSavingsGoalSchema.parse(request.body);

      // Get goal to verify household access
      const existingGoal = await savingsGoalsService.getSavingsGoal(goalId);
      await requireEditor(request, existingGoal.householdId);

      const goal = await savingsGoalsService.updateSavingsGoal(goalId, input);

      return reply.send({
        success: true,
        data: goal,
      });
    }
  );

  /**
   * POST /savings-goals/:goalId/add
   * Add amount to savings goal (EDITOR+)
   */
  app.post<{ Params: { goalId: string } }>(
    '/:goalId/add',
    {
      schema: {
        description: 'Add amount to savings goal (EDITOR+)',
        tags: ['Savings Goals'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['goalId'],
          properties: {
            goalId: { type: 'string', format: 'uuid' },
          },
        },
        body: {
          type: 'object',
          properties: {
            amount: { type: 'number' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { goalId } = savingsGoalIdParamSchema.parse(request.params);
      const input = addToSavingsGoalSchema.parse(request.body);

      // Get goal to verify household access
      const existingGoal = await savingsGoalsService.getSavingsGoal(goalId);
      await requireEditor(request, existingGoal.householdId);

      const goal = await savingsGoalsService.addToSavingsGoal(
        goalId,
        existingGoal.householdId,
        input
      );

      return reply.send({
        success: true,
        data: goal,
      });
    }
  );

  /**
   * DELETE /savings-goals/:goalId
   * Delete savings goal (EDITOR+)
   */
  app.delete<{ Params: { goalId: string } }>(
    '/:goalId',
    {
      schema: {
        description: 'Delete savings goal (EDITOR+)',
        tags: ['Savings Goals'],
        security: [{ bearerAuth: [] }],
        params: {
          type: 'object',
          required: ['goalId'],
          properties: {
            goalId: { type: 'string', format: 'uuid' },
          },
        },
        response: {
          200: {
            type: 'object',
            properties: {
              success: { type: 'boolean' },
              data: { type: 'object', additionalProperties: true },
            },
          },
        },
      },
    },
    async (request, reply) => {
      const { goalId } = savingsGoalIdParamSchema.parse(request.params);

      // Get goal to verify household access
      const existingGoal = await savingsGoalsService.getSavingsGoal(goalId);
      await requireEditor(request, existingGoal.householdId);

      const result = await savingsGoalsService.deleteSavingsGoal(goalId);

      return reply.send({
        success: true,
        data: result,
      });
    }
  );
}

