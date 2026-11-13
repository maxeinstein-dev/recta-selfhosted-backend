import { describe, expect, it } from 'vitest';
import { buildCategoryHints, type CategoryHistoryRow } from './capture-category.js';
import { buildSuggestion } from './capture-suggestion.js';

const CUSTOM_FOOD = 'CUSTOM:11111111-1111-4111-8111-111111111111';
const CUSTOM_GONE = 'CUSTOM:22222222-2222-4222-8222-222222222222';
const CUSTOM_INCOME = 'CUSTOM:33333333-3333-4333-8333-333333333333';
const customCategories = [
  { id: '11111111-1111-4111-8111-111111111111', type: 'EXPENSE' },
  { id: '33333333-3333-4333-8333-333333333333', type: 'INCOME' },
];

const day = (iso: string) => new Date(`${iso}T00:00:00.000Z`);
const expense = (description: string, categoryName: string | null, date: string, createdAt?: string): CategoryHistoryRow => ({
  type: 'EXPENSE',
  description,
  categoryName,
  date: day(date),
  createdAt: createdAt ? new Date(createdAt) : day(date),
});

function hints(history: CategoryHistoryRow[], recurrences: { description: string | null; aliases: string[]; categoryName: string }[] = []) {
  return buildCategoryHints({ history, recurrences, customCategories });
}

describe('buildCategoryHints', () => {
  it('gives nothing without history, or for an empty merchant', () => {
    expect(hints([]).lookup('EXPENSE', 'Padaria Central')).toBeNull();
    expect(hints([expense('Padaria Central', 'FOOD', '2026-11-01')]).lookup('EXPENSE', '   ')).toBeNull();
  });

  it('takes the category of the latest transaction of the same place, whatever the order it was given in', () => {
    const h = hints([
      expense('Padaria Central', 'FOOD', '2026-10-01'),
      expense('Padaria Central', 'GROCERIES', '2026-11-05'),
      expense('Padaria Central', 'RESTAURANT', '2026-09-20'),
    ]);
    expect(h.lookup('EXPENSE', 'Padaria Central')).toEqual({ categoryName: 'GROCERIES', source: 'history' });
  });

  it('breaks a tie of the same day by the newest created', () => {
    const h = hints([
      expense('Padaria Central', 'FOOD', '2026-11-05', '2026-11-05T10:00:00Z'),
      expense('Padaria Central', 'GROCERIES', '2026-11-05', '2026-11-05T12:00:00Z'),
    ]);
    expect(h.lookup('EXPENSE', 'Padaria Central')?.categoryName).toBe('GROCERIES');
  });

  it('matches the place by the normalized description: case, accents and installment tokens do not matter', () => {
    const h = hints([expense('PADARIA SÃO JOÃO 2/3', 'FOOD', '2026-11-01')]);
    expect(h.lookup('EXPENSE', 'Padaria Sao Joao')?.categoryName).toBe('FOOD');
    expect(h.lookup('EXPENSE', 'Padaria Sao Jose')).toBeNull();
  });

  it('skips a custom category that no longer exists and falls back to the next older one', () => {
    const h = hints([expense('Mercado Bom', CUSTOM_GONE, '2026-11-10'), expense('Mercado Bom', CUSTOM_FOOD, '2026-11-01')]);
    expect(h.lookup('EXPENSE', 'Mercado Bom')).toEqual({ categoryName: CUSTOM_FOOD, source: 'history' });
  });

  it('skips categories of the other type and the internal ones', () => {
    const h = hints([
      expense('Loja X', CUSTOM_INCOME, '2026-11-10'),
      expense('Loja X', 'SALARY', '2026-11-09'),
      expense('Loja X', 'TRANSFER', '2026-11-08'),
      expense('Loja X', null, '2026-11-07'),
    ]);
    expect(h.lookup('EXPENSE', 'Loja X')).toBeNull();
  });

  it('never crosses types: an income of the same name does not set the category of an expense', () => {
    const h = hints([{ type: 'INCOME', description: 'Loja X', categoryName: 'SALES', date: day('2026-11-10'), createdAt: day('2026-11-10') }]);
    expect(h.lookup('EXPENSE', 'Loja X')).toBeNull();
    expect(h.lookup('INCOME', 'Loja X')).toEqual({ categoryName: 'SALES', source: 'history' });
  });

  it('prefers a recurrence that has the place as its name or as an alias, over the history', () => {
    const h = hints(
      [expense('Ebn*Spotify', 'ENTERTAINMENT', '2026-11-10')],
      [{ description: 'Spotify', aliases: ['Ebn*Spotify'], categoryName: 'SUBSCRIPTIONS' }]
    );
    expect(h.lookup('EXPENSE', 'EBN*SPOTIFY')).toEqual({ categoryName: 'SUBSCRIPTIONS', source: 'recurrence' });
    expect(h.lookup('EXPENSE', 'spotify')).toEqual({ categoryName: 'SUBSCRIPTIONS', source: 'recurrence' });
  });

  it('ignores a recurrence whose category is gone or is of the other type, and the first recurrence of a place wins', () => {
    const h = hints(
      [expense('Academia Forte', 'HEALTHCARE', '2026-11-01')],
      [
        { description: 'Academia Forte', aliases: [], categoryName: CUSTOM_GONE },
        { description: 'Academia Forte', aliases: [], categoryName: 'SALARY' },
        { description: 'Seguro', aliases: ['Pg *Seguro'], categoryName: 'TRANSPORTATION' },
        { description: 'Seguro', aliases: [], categoryName: 'UTILITIES' },
      ]
    );
    expect(h.lookup('EXPENSE', 'Academia Forte')).toEqual({ categoryName: 'HEALTHCARE', source: 'history' });
    expect(h.lookup('EXPENSE', 'Seguro')?.categoryName).toBe('TRANSPORTATION');
  });
});

describe('buildSuggestion with category hints', () => {
  const postedAt = new Date('2026-11-13T15:00:00Z');
  const NU = 'com.nu.production';
  const purchase = { kind: 'CARD_PURCHASE', type: 'EXPENSE', amountCents: 1250, merchant: 'Padaria Central', description: 'Padaria Central' };
  const h = hints([expense('Padaria Central', 'FOOD', '2026-11-01')]);

  it('fills the category and says where it came from', () => {
    const s = buildSuggestion({ package: NU, postedAt, parsed: purchase }, [], [], h);
    expect(s.categoryName).toBe('FOOD');
    expect(s.categorySource).toBe('history');
  });

  it('leaves the category empty without a merchant, without a type, or without hints', () => {
    const pixIn = { kind: 'PIX_IN', type: 'INCOME', amountCents: 500, description: 'Padaria Central' };
    expect(buildSuggestion({ package: NU, postedAt, parsed: pixIn }, [], [], h)).toMatchObject({ categoryName: null, categorySource: null });
    expect(buildSuggestion({ package: NU, postedAt, parsed: { ...purchase, type: 'SIDEWAYS' } }, [], [], h).categoryName).toBeNull();
    expect(buildSuggestion({ package: NU, postedAt, parsed: { ...purchase, merchant: 7 } }, [], [], h).categoryName).toBeNull();
    expect(buildSuggestion({ package: NU, postedAt, parsed: purchase }, [], [])).toMatchObject({ categoryName: null, categorySource: null });
  });
});
