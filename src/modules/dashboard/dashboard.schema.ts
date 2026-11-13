import { z } from 'zod';

/**
 * Dashboard overview query parameters
 */
export const dashboardOverviewQuerySchema = z.object({
  householdId: z.string().uuid(),
  month: z.string().regex(/^\d{4}-\d{2}$/, 'Month must be in YYYY-MM format'),
});

export type DashboardOverviewQuery = z.infer<typeof dashboardOverviewQuerySchema>;

/**
 * Dashboard overview response types
 */
export interface DashboardSummary {
  totalIncome: number;
  totalExpense: number;
  balance: number;
}

export interface DashboardTrend {
  incomeChange: number;
  expenseChange: number;
  balanceChange: number;
  incomeTrend: 'up' | 'down' | 'stable';
  expenseTrend: 'up' | 'down' | 'stable';
}

export interface DashboardForecast {
  predictedIncome: number;
  predictedExpense: number;
  predictedBalance: number;
}

export interface CategoryBreakdown {
  name: string;
  income: number;
  expense: number;
  /** Expense by the user's own share: each expense minus what other people owe the user on it (never below zero). */
  ownExpense: number;
  total: number;
}

export interface MonthlyComparisonItem {
  month: string;
  income: number;
  expense: number;
}

export interface BalanceEvolutionItem {
  month: string;
  balance: number;
}

export interface FixedVsVariable {
  fixed: number;
  variable: number;
  fixedPercentage: number;
  variablePercentage: number;
}

export interface BudgetVsRealized {
  category: string;
  type: 'INCOME' | 'EXPENSE';
  budgeted: number;
  spent: number;
  /** `spent` by the user's own share (expense budgets; equal to `spent` for income budgets and without shares). */
  ownSpent: number;
  remaining: number;
  percentage: number;
  /** 'reached': the spending is exactly the limit (all of it used); 'exceeded': above the limit. */
  status: 'ok' | 'warning' | 'reached' | 'exceeded';
}

export interface DashboardHeatmapDay {
  day: number;
  amount: number;
}

export interface DashboardOverviewResponse {
  summary: DashboardSummary;
  trend: DashboardTrend;
  forecast: DashboardForecast;
  categoryBreakdown: CategoryBreakdown[];
  monthlyComparison: MonthlyComparisonItem[];
  balanceEvolution: BalanceEvolutionItem[];
  fixedVsVariable: FixedVsVariable;
  budgetVsRealized: BudgetVsRealized[];
  heatmap: {
    month: string;
    data: DashboardHeatmapDay[];
    total: number;
    daysInMonth: number;
  };
}

/**
 * Projected cash flow query: `accountId` is one cash account (omit it for all of them), `days` the length of the
 * period after today (1 to 180, default 90).
 */
export const cashFlowQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  accountId: z.string().uuid().optional(),
  days: z.coerce.number().int().min(1).max(180).default(90),
});

export type CashFlowQuery = z.infer<typeof cashFlowQuerySchema>;

/** Month close query: the month to check, 'YYYY-MM'. */
export const monthCloseQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
});

export type MonthCloseQuery = z.infer<typeof monthCloseQuerySchema>;

/** Record a month conference: the balance the statement shows (an invoice total for a card), for one account. */
export const monthCloseBodySchema = z.object({
  householdId: z.string().uuid().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
  accountId: z.string().uuid(),
  informedBalance: z.number().finite().min(-1_000_000_000_000).max(1_000_000_000_000),
});

export type MonthCloseBody = z.infer<typeof monthCloseBodySchema>;

/** Net worth query: `months` is how many months back from the current one, included (1 to 36, default 12). */
export const netWorthQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  months: z.coerce.number().int().min(1).max(36).default(12),
});

export type NetWorthQuery = z.infer<typeof netWorthQuerySchema>;

/** GET /dashboard/income-split: one month ('YYYY-MM'). */
export const incomeSplitQuerySchema = z.object({
  householdId: z.string().uuid().optional(),
  month: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, 'month must be YYYY-MM'),
});
