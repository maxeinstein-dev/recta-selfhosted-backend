import type { FastifyInstance } from 'fastify';
import { authMiddleware } from '../../shared/middleware/auth.middleware.js';
import {
  requireHouseholdMember,
  requireEditor,
  ensurePersonalHousehold,
} from '../../shared/middleware/authorization.middleware.js';
import { cashFlowQuerySchema, dashboardOverviewQuerySchema, monthCloseBodySchema, monthCloseQuerySchema, netWorthQuerySchema } from './dashboard.schema.js';
import { loadCashFlow } from './cash-flow.loader.js';
import { loadMonthClose, saveMonthClosing } from './month-close.js';
import { loadNetWorth } from './net-worth.loader.js';
import * as dashboardService from './dashboard.service.js';

export async function dashboardRoutes(app: FastifyInstance) {
  // All routes require authentication
  app.addHook('preHandler', authMiddleware());

  /**
   * GET /dashboard/overview
   * Get complete dashboard overview with all aggregated data
   */
  app.get('/overview', {
    schema: {
      description: 'Get complete dashboard overview with all aggregated data',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-\\d{2}$' },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                summary: {
                  type: 'object',
                  properties: {
                    totalIncome: { type: 'number' },
                    totalExpense: { type: 'number' },
                    balance: { type: 'number' },
                  },
                },
                trend: {
                  type: 'object',
                  properties: {
                    incomeChange: { type: 'number' },
                    expenseChange: { type: 'number' },
                    balanceChange: { type: 'number' },
                    incomeTrend: { type: 'string' },
                    expenseTrend: { type: 'string' },
                  },
                },
                forecast: {
                  type: 'object',
                  properties: {
                    predictedIncome: { type: 'number' },
                    predictedExpense: { type: 'number' },
                    predictedBalance: { type: 'number' },
                  },
                },
                categoryBreakdown: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      name: { type: 'string' },
                      income: { type: 'number' },
                      expense: { type: 'number' },
                      ownExpense: { type: 'number' },
                      total: { type: 'number' },
                    },
                  },
                },
                monthlyComparison: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      month: { type: 'string' },
                      income: { type: 'number' },
                      expense: { type: 'number' },
                    },
                  },
                },
                balanceEvolution: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      month: { type: 'string' },
                      balance: { type: 'number' },
                    },
                  },
                },
                fixedVsVariable: {
                  type: 'object',
                  properties: {
                    fixed: { type: 'number' },
                    variable: { type: 'number' },
                    fixedPercentage: { type: 'number' },
                    variablePercentage: { type: 'number' },
                  },
                },
                budgetVsRealized: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      category: { type: 'string' },
                      type: { type: 'string' },
                      budgeted: { type: 'number' },
                      spent: { type: 'number' },
                      ownSpent: { type: 'number' },
                      remaining: { type: 'number' },
                      percentage: { type: 'number' },
                      status: { type: 'string' },
                    },
                  },
                },
                heatmap: {
                  type: 'object',
                  properties: {
                    month: { type: 'string' },
                    data: {
                      type: 'array',
                      items: {
                        type: 'object',
                        properties: {
                          day: { type: 'number' },
                          amount: { type: 'number' },
                        },
                      },
                    },
                    total: { type: 'number' },
                    daysInMonth: { type: 'number' },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = dashboardOverviewQuerySchema.parse(request.query);

    // If no householdId provided, ensure user has a personal household
    const householdId = query.householdId || await ensurePersonalHousehold(request);

    await requireHouseholdMember(request, householdId);

    const data = await dashboardService.getDashboardOverview({
      ...query,
      householdId,
    });

    return reply.send({
      success: true,
      data,
    });
  });

  /**
   * GET /dashboard/cash-flow
   * Balance of the cash accounts day by day from today, from what is already known (pending entries, recurrence
   * occurrences not yet generated, invoice payments on their due dates). Read-only.
   */
  const eventSchema = {
    type: 'object',
    properties: {
      date: { type: 'string' },
      description: { type: 'string' },
      amount: { type: 'number' },
      source: { type: 'string', enum: ['pending', 'recurrence', 'payroll', 'invoice', 'reserve'] },
      certainty: { type: 'string', enum: ['confirmed', 'expected', 'estimated'] },
      overdue: { type: 'boolean' },
      originalDate: { type: ['string', 'null'] },
      sourceId: { type: 'string' },
      accountId: { type: 'string' },
      invoiceMonth: { type: ['string', 'null'] },
      // Recurrence with an early-payment discount that can still be had: `amount` is the discounted one
      earlyDiscount: {
        type: 'object',
        properties: {
          limitDate: { type: 'string' },
          fullAmount: { type: 'number' },
          discountedAmount: { type: 'number' },
          savings: { type: 'number' },
          recurringId: { type: 'string' },
          occurrenceDate: { type: 'string' },
          canPayNow: { type: 'boolean' },
        },
      },
    },
  };
  app.get('/cash-flow', {
    schema: {
      description: 'Projected cash flow of the cash accounts, day by day, from known events only',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          accountId: { type: 'string', format: 'uuid' },
          days: { type: 'integer', minimum: 1, maximum: 180 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: {
            success: { type: 'boolean' },
            data: {
              type: 'object',
              properties: {
                currency: { type: ['string', 'null'] },
                period: { type: 'object', properties: { from: { type: 'string' }, to: { type: 'string' }, days: { type: 'integer' } } },
                // Free balance (accounts minus what the savings goals keep); every balance below is free balance too
                startingBalance: { type: 'number' },
                allocated: { type: 'number' },
                totalBalance: { type: 'number' },
                days: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      date: { type: 'string' },
                      events: { type: 'array', items: eventSchema },
                      inflow: { type: 'number' },
                      outflow: { type: 'number' },
                      net: { type: 'number' },
                      endBalance: { type: 'number' },
                    },
                  },
                },
                summary: {
                  type: 'object',
                  properties: {
                    lowestBalance: { type: 'object', properties: { date: { type: 'string' }, amount: { type: 'number' } } },
                    firstNegativeDate: { type: ['string', 'null'] },
                    endingBalance: { type: 'number' },
                    balanceAfterDays: {
                      type: 'array',
                      items: { type: 'object', properties: { days: { type: 'integer' }, date: { type: 'string' }, balance: { type: 'number' } } },
                    },
                    totalInflow: { type: 'number' },
                    totalOutflow: { type: 'number' },
                    eventCount: { type: 'integer' },
                    estimatedCount: { type: 'integer' },
                    overdueCount: { type: 'integer' },
                  },
                },
                unassignedInvoices: {
                  type: 'array',
                  items: {
                    type: 'object',
                    properties: {
                      accountId: { type: 'string' },
                      accountName: { type: 'string' },
                      month: { type: 'string' },
                      dueDate: { type: ['string', 'null'] },
                      amount: { type: 'number' },
                      reason: { type: 'string', enum: ['no_payer_account', 'no_due_date'] },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  }, async (request, reply) => {
    const query = cashFlowQuerySchema.parse(request.query);
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);

    const data = await loadCashFlow({ householdId, accountId: query.accountId, days: query.days });
    return reply.send({ success: true, data });
  });
  /**
   * GET /dashboard/month-close
   * Is the month conferred? Cash account balances, card invoices and what is still pending. Read only.
   */
  app.get('/month-close', {
    schema: {
      description: 'What still stops a month from being conferred: balances, invoices, pending entries',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        required: ['month'],
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          month: { type: 'string', pattern: '^\\d{4}-(0[1-9]|1[0-2])$' },
        },
      },
    },
  }, async (request, reply) => {
    const query = monthCloseQuerySchema.parse(request.query);
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);

    const data = await loadMonthClose({ householdId, month: query.month });
    return reply.send({ success: true, data });
  });

  /**
   * POST /dashboard/month-close
   * Records the conference of one account (or card) for a month. The system figure is computed on the server.
   */
  app.post('/month-close', {
    schema: {
      description: 'Record the conference of one account for a month: informed balance against the system balance',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
    },
  }, async (request, reply) => {
    const body = monthCloseBodySchema.parse(request.body);
    const householdId = body.householdId || await ensurePersonalHousehold(request);
    const membership = await requireEditor(request, householdId);

    const data = await saveMonthClosing({ householdId, month: body.month, accountId: body.accountId, informedBalance: body.informedBalance, userId: membership.userId });
    return reply.send({ success: true, data });
  });

  /**
   * GET /dashboard/net-worth
   * Net worth by month: cash accounts, investments, reserves, FGTS (estimated) minus the card debt. Read-only.
   */
  app.get('/net-worth', {
    schema: {
      description: 'Net worth by month: accounts, investments, reserves and FGTS minus the card debt, with the savings rate',
      tags: ['Dashboard'],
      security: [{ bearerAuth: [] }],
      querystring: {
        type: 'object',
        properties: {
          householdId: { type: 'string', format: 'uuid' },
          months: { type: 'integer', minimum: 1, maximum: 36 },
        },
      },
      response: {
        200: {
          type: 'object',
          properties: { success: { type: 'boolean' }, data: { type: 'object', additionalProperties: true } },
        },
      },
    },
  }, async (request, reply) => {
    const query = netWorthQuerySchema.parse(request.query);
    const householdId = query.householdId || await ensurePersonalHousehold(request);
    await requireHouseholdMember(request, householdId);

    const data = await loadNetWorth({ householdId, months: query.months });
    return reply.send({ success: true, data });
  });
}
