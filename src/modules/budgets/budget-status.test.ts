import { describe, expect, it } from 'vitest';
import { budgetAlertCopy, budgetAlertKind, budgetStatusOf } from './budget-status.js';

// Status of a budget against its limit, in whole cents: exactly at the limit is "reached" (every cent of the limit is
// used), above it "exceeded"; from 80% on, "warning". A limit of zero or less never reaches anything.
describe('budgetStatusOf', () => {
  it('is ok under 80%, warning from 80% up to the limit, reached exactly at the limit, exceeded above it', () => {
    expect(budgetStatusOf(0, 500)).toBe('ok');
    expect(budgetStatusOf(399.99, 500)).toBe('ok');
    expect(budgetStatusOf(400, 500)).toBe('warning');
    expect(budgetStatusOf(499.99, 500)).toBe('warning');
    expect(budgetStatusOf(500, 500)).toBe('reached');
    expect(budgetStatusOf(500.01, 500)).toBe('exceeded');
  });

  it('compares cents, so binary floats do not decide the boundary', () => {
    // 0.1 + 0.2 is 0.30000000000000004 in floats: it is exactly the limit of 0.30 in cents
    expect(budgetStatusOf(0.1 + 0.2, 0.3)).toBe('reached');
    expect(budgetStatusOf(850, 850)).toBe('reached');
  });

  it('a budget without a positive limit is never reached or exceeded', () => {
    expect(budgetStatusOf(10, 0)).toBe('ok');
    expect(budgetStatusOf(10, -5)).toBe('ok');
  });
});

describe('budgetAlertKind', () => {
  it('warns once at 75% while under the limit, and never again in the month', () => {
    expect(budgetAlertKind(374.99, 500, [])).toBeNull();
    expect(budgetAlertKind(375, 500, [])).toBe('warning');
    expect(budgetAlertKind(375, 500, [{ status: 'warning', percentage: 75 }])).toBeNull();
  });

  it('sends "reached" once at the exact limit', () => {
    expect(budgetAlertKind(500, 500, [])).toBe('reached');
    expect(budgetAlertKind(500, 500, [{ status: 'reached', percentage: 100 }])).toBeNull();
  });

  it('sends "exceeded" once after a "reached" was already sent', () => {
    expect(budgetAlertKind(500.01, 500, [{ status: 'reached', percentage: 100 }])).toBe('exceeded');
    expect(budgetAlertKind(500.01, 500, [{ status: 'reached', percentage: 100 }, { status: 'exceeded', percentage: 100 }])).toBeNull();
  });

  it('a jump straight above the limit sends "exceeded" alone', () => {
    expect(budgetAlertKind(600, 500, [])).toBe('exceeded');
  });

  it('reads older notifications that have no status by their percentage', () => {
    expect(budgetAlertKind(500, 500, [{ percentage: 100 }])).toBeNull();
    expect(budgetAlertKind(500.01, 500, [{ percentage: 100 }])).toBe('exceeded');
    expect(budgetAlertKind(380, 500, [{ percentage: 76 }])).toBeNull();
  });
});

describe('budgetAlertCopy', () => {
  it('reached: "atingido", and the message says the whole limit is used', () => {
    const copy = budgetAlertCopy('reached', { name: 'Supermercado', spending: 850, limit: 850, ownNote: '' });
    expect(copy.title).toBe('Orçamento Supermercado atingido');
    expect(copy.message).toContain('todo o limite');
    expect(copy.message).toContain('850.00');
    expect(copy.message).not.toContain('excedido');
    expect(copy.message).not.toContain('em 0.00');
  });

  it('exceeded: "excedido" with the amount over the limit', () => {
    const copy = budgetAlertCopy('exceeded', { name: 'Supermercado', spending: 850.01, limit: 850, ownNote: ' (sua parte)' });
    expect(copy.title).toBe('Orçamento Supermercado excedido!');
    expect(copy.message).toContain('em 0.01');
    expect(copy.message).toContain('(sua parte)');
  });
});
