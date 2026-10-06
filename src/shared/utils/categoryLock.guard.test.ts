import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join, relative, sep } from 'node:path';
import { describe, expect, it } from 'vitest';

/**
 * Structural guard: every function that writes a `categoryName` column (create / createMany / update / updateMany /
 * upsert with a `categoryName` key in the call) must take the category share lock (lockCustomCategory) in that same
 * function, or be listed below with the reason it cannot leave an orphan CUSTOM:<id> reference after a merge.
 */
const EXCEPTIONS: Record<string, string> = {
  'modules/categories/categories.merge.service.ts::run': 'the merge itself: it holds the category rows FOR UPDATE and re-points the references',
  'modules/accounts/accounts.service.ts::transferBetweenAccounts': 'writes the fixed system names TRANSFER/ALLOCATION, never a custom id',
  'modules/accounts/accounts.service.ts::adjustBalance': 'writes the system names OTHER_INCOME/OTHER_EXPENSES by sign, never a custom id',
  'modules/transactions/transactions.service.ts::payCreditCardInvoice': 'writes the fixed system name OTHER_EXPENSES',
  'modules/transactions/transactions.service.ts::createTransfer': 'writes the fixed system name TRANSFER',
  'modules/transactions/transactions.service.ts::createAllocation': 'writes the fixed system name ALLOCATION',
  'modules/transactions/transactions.service.ts::createDeallocation': 'writes the fixed system name ALLOCATION',
  'modules/transactions/transactions.service.ts::updateTransactionOnce': 'locks through its caller block `if (input.categoryName) await lockCustomCategory` inside the same $transaction (checked by the test below)',
};

function sources(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    if (name === 'generated' || name === 'scripts' || name === '__fixtures__') return [];
    if (statSync(path).isDirectory()) return sources(path);
    return /\.ts$/.test(name) && !/\.test\.ts$/.test(name) ? [path] : [];
  });
}

/** Function-level chunks: from a line starting a (async) function declaration to the next one. */
function chunks(text: string): Array<{ name: string; body: string }> {
  const starts = [...text.matchAll(/^(?:export\s+)?(?:async\s+)?function\s+(\w+)/gm)];
  return starts.map((m, i) => ({ name: m[1], body: text.slice(m.index!, i + 1 < starts.length ? starts[i + 1].index! : text.length) }));
}


describe('category writers take the category lock', () => {
  const root = join(process.cwd(), 'src');
  const found: Array<{ key: string; locked: boolean }> = [];
  for (const file of sources(root)) {
    const text = readFileSync(file, 'utf8');
    if (!/categoryName/.test(text)) continue;
    for (const chunk of chunks(text)) {
      // only the part of the chunk around each write call counts as the "call": 600 chars after the opening brace
      const hasWriter = [...chunk.body.matchAll(/\.(?:create|createMany|update|updateMany|upsert)\(\s*\{/g)].some((m) => {
        const call = chunk.body.slice(m.index!, m.index! + 700);
        return /\bcategoryName\b/.test(call.split(/\n\s*\}\);/)[0]);
      });
      if (hasWriter) found.push({ key: `${relative(root, file).split(sep).join('/')}::${chunk.name}`, locked: /lockCustomCategory\(/.test(chunk.body) });
    }
  }

  it('finds the known writers (the scan itself works)', () => {
    const keys = found.map((f) => f.key);
    for (const expected of [
      'modules/transactions/transactions.service.ts::createTransaction',
      'modules/transactions/transactions.service.ts::batchCreateTransactions',
      'modules/recurring-transactions/recurring-transactions.service.ts::createRecurringTransaction',
      'modules/recurring-transactions/recurring-transactions.service.ts::executeRecurringTransaction',
      'modules/recurring-transactions/recurring-detect.service.ts::applyDetectedRecurrences',
      'modules/budgets/budgets.service.ts::createBudget',
    ]) expect(keys).toContain(expected);
  });

  it('every writer locks the category or is a justified exception', () => {
    const offenders = found.filter((f) => !f.locked && !(f.key in EXCEPTIONS)).map((f) => f.key);
    expect(offenders).toEqual([]);
  });

  it('exceptions are still real writers (no stale entries)', () => {
    const keys = found.map((f) => f.key);
    expect(Object.keys(EXCEPTIONS).filter((k) => !keys.includes(k))).toEqual([]);
  });

  it('updateTransactionOnce locks the new category inside its $transaction', () => {
    const text = readFileSync(join(root, 'modules/transactions/transactions.service.ts'), 'utf8');
    expect(text).toMatch(/if \(input\.categoryName\) await lockCustomCategory\(tx, householdId, input\.categoryName\)/);
  });
});
