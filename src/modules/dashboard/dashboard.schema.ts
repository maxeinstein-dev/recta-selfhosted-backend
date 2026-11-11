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
  status: 'ok' | 'warning' | 'exceeded';
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
