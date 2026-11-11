/**
 * Fixtures for the "shifted rows" tests: a monthly sheet built from short row lists (invented values) and a small
 * in-memory stand-in for the prisma tables the importer reads and the realignment writes.
 */
import { AccountType } from '../../../shared/enums/index.js';
import type { MaxFinAccountsResolved, ResolvedAccount } from '../maxfin-import.service.js';
import type { MaxFinAccountsInput } from '../maxfin-import.types.js';
import type { MaxFinSectionKey } from '../parsers/maxfin.types.js';

export const HOUSEHOLD = 'hh-1';

/** `[description, amount]` (a leading "-" on the amount makes it a credit); income rows are received amounts. */
export type SheetRow = [description: string, amount: number];

export interface SheetSpec {
  income?: SheetRow[];
  bills?: SheetRow[];
  credit?: SheetRow[];
  debit?: SheetRow[];
}

const money = (value: number): string => {
  const abs = Math.abs(value).toFixed(2);
  const [int, cents] = abs.split('.') as [string, string];
  return `${value < 0 ? '-' : ''}R$ ${int.replace(/\B(?=(\d{3})+(?!\d))/g, '.')},${cents}`;
};

const q = (value: string): string => `"${value}"`;

/**
 * CSV of one monthly tab (title in rows 1-2, header in row 5, the four blocks, the footer), laid out like the real
 * export so that the line numbers (the `sourceRef` suffix) behave like the real ones: the income block starts at
 * line 7, every other block starts after one blank line and ends with a "Total" row.
 */
export function sheetCsv(spec: SheetSpec, monthName = 'outubro de 2026'): Buffer {
  const lines: string[] = [];
  lines.push(`"Finanças Teste\nMês de ${monthName}",,,,,,,,,`);
  lines.push(',,,,,,,,,');
  lines.push('');
  lines.push(',,,,,,,,,');
  lines.push(',Descrição,Categoria,Entrada - Previsto ,Recebido ,À receber,Saída - Previsto,Realizado ,Saldo,');
  lines.push(',Mês anterior,,"R$ 250,00","R$ 250,00",,,,"R$ 250,00",');
  for (const [description, amount] of spec.income ?? []) {
    lines.push(`,${description},Salário,${q(money(amount))},${q(money(amount))},,,,"R$ 1,00",`);
  }
  lines.push(',,,,,,,,,');
  lines.push(',,,,,,,,,');
  const expense = (rows: SheetRow[]) => {
    for (const [description, amount] of rows) {
      lines.push(`,${description},Compras,,,,${q(money(amount))},${q(money(amount))},,`);
    }
    lines.push(`,Total,,,,,${q(money(rows.reduce((sum, [, a]) => sum + a, 0)))},${q(money(rows.reduce((sum, [, a]) => sum + a, 0)))},,`);
  };
  expense(spec.bills ?? []);
  lines.push(',,,,,,,,,');
  expense(spec.credit ?? []);
  lines.push(',,,,,,,,,');
  expense(spec.debit ?? []);
  lines.push(',,,,,,,,,');
  lines.push(',,,"R$ 1,00","R$ 1,00",,"R$ 1,00","R$ 1,00","R$ 1,00",');
  lines.push(',,,Economia Prevista,,,"R$ 1,00",,,');
  lines.push(',,,Saldo,,,"R$ 1,00",,,');
  return Buffer.from(lines.join('\n'), 'utf8');
}

export function makeAccounts(): MaxFinAccountsResolved {
  const account = (key: MaxFinSectionKey, extra: Partial<ResolvedAccount> = {}): ResolvedAccount => ({
    id: `acc-${key}`,
    name: `Conta ${key}`,
    type: AccountType.CHECKING,
    householdId: HOUSEHOLD,
    dueDay: null,
    closingDay: null,
    ...extra,
  });
  return {
    householdId: HOUSEHOLD,
    income: account('income'),
    bills: account('bills'),
    credit: account('credit', { name: 'Cartão Teste', type: AccountType.CREDIT, dueDay: 9, closingDay: 2 }),
    debit: account('debit'),
  };
}

export function idsOf(accounts: MaxFinAccountsResolved): MaxFinAccountsInput {
  return { income: accounts.income.id, bills: accounts.bills.id, credit: accounts.credit.id, debit: accounts.debit.id };
}

// ---------------------------------------------------------------------------
// In-memory tables
// ---------------------------------------------------------------------------

export interface FakeTx {
  id: string;
  householdId: string;
  accountId: string | null;
  sourceRef: string | null;
  type: 'INCOME' | 'EXPENSE';
  amount: number;
  paid: boolean;
  description: string | null;
  notes: string | null;
  date: Date;
  installmentId: string | null;
  installmentNumber: number | null;
  totalInstallments: number | null;
  recurringTransactionId: string | null;
  competenceMonth: string | null;
  categoryName: string;
  updatedAt: number;
}

export interface FakeExternalRef {
  id: string;
  householdId: string;
  transactionId: string;
  ref: string;
}

type Where = Record<string, any>;

const textMatch = (value: string | null, cond: unknown): boolean => {
  if (cond === null) return value === null;
  if (typeof cond === 'string') return value === cond;
  if (value === null) return false;
  const c = cond as { in?: string[]; contains?: string; startsWith?: string };
  if (c.in && !c.in.includes(value)) return false;
  if (c.contains !== undefined && !value.includes(c.contains)) return false;
  if (c.startsWith !== undefined && !value.startsWith(c.startsWith)) return false;
  return true;
};

/**
 * Tables with the same unique constraints as the database: (householdId, sourceRef) on transactions and
 * (householdId, ref) on the external references. A write that breaks one throws the Prisma P2002 error.
 */
export class FakeTables {
  txs: FakeTx[] = [];
  refs: FakeExternalRef[] = [];
  /** SQL fragments seen by $queryRaw/$executeRaw, in order. */
  rawLog: string[] = [];
  /** Every sourceRef update, in order: `${id}:${ref}`. */
  updateLog: string[] = [];
  private seq = 0;

  addTx(input: Partial<FakeTx> & { id: string }): FakeTx {
    const tx: FakeTx = {
      householdId: HOUSEHOLD,
      accountId: 'acc-credit',
      sourceRef: null,
      type: 'EXPENSE',
      amount: 0,
      paid: true,
      description: null,
      notes: null,
      date: new Date('2026-10-01T00:00:00.000Z'),
      installmentId: null,
      installmentNumber: null,
      totalInstallments: null,
      recurringTransactionId: null,
      competenceMonth: null,
      categoryName: 'OTHER_EXPENSES',
      updatedAt: 0,
      ...input,
    };
    this.txs.push(tx);
    return tx;
  }

  addRef(transactionId: string, ref: string): void {
    this.refs.push({ id: `ref-${++this.seq}`, householdId: HOUSEHOLD, transactionId, ref });
  }

  private view(tx: FakeTx) {
    return { ...tx, amount: { toNumber: () => tx.amount } };
  }

  private matchTx(tx: FakeTx, where: Where): boolean {
    if (where.id !== undefined && !(typeof where.id === 'string' ? tx.id === where.id : where.id.in.includes(tx.id))) return false;
    if (where.householdId !== undefined && tx.householdId !== where.householdId) return false;
    if (where.accountId !== undefined) {
      const allowed = typeof where.accountId === 'string' ? [where.accountId] : where.accountId.in;
      if (tx.accountId === null || !allowed.includes(tx.accountId)) return false;
    }
    if (where.sourceRef !== undefined && !textMatch(tx.sourceRef, where.sourceRef)) return false;
    if (where.installmentId !== undefined) {
      const allowed = typeof where.installmentId === 'string' ? [where.installmentId] : where.installmentId.in;
      if (tx.installmentId === null || !allowed.includes(tx.installmentId)) return false;
    }
    if (where.installmentNumber !== undefined) {
      if (tx.installmentNumber === null || !where.installmentNumber.in.includes(tx.installmentNumber)) return false;
    }
    return true;
  }

  private matchRef(ref: FakeExternalRef, where: Where): boolean {
    if (where.OR) return where.OR.some((w: Where) => this.matchRef(ref, w));
    if (where.householdId !== undefined && ref.householdId !== where.householdId) return false;
    if (where.transactionId !== undefined) {
      const ok = typeof where.transactionId === 'string' ? ref.transactionId === where.transactionId : where.transactionId.in.includes(ref.transactionId);
      if (!ok) return false;
    }
    if (where.ref !== undefined && !textMatch(ref.ref, where.ref)) return false;
    return true;
  }

  private assertUnique(): void {
    const seen = new Set<string>();
    for (const tx of this.txs) {
      if (tx.sourceRef === null) continue;
      const key = `${tx.householdId}|${tx.sourceRef}`;
      if (seen.has(key)) throw Object.assign(new Error('Unique constraint failed on (household_id, source_ref)'), { code: 'P2002' });
      seen.add(key);
    }
    const seenRefs = new Set<string>();
    for (const ref of this.refs) {
      const key = `${ref.householdId}|${ref.ref}`;
      if (seenRefs.has(key)) throw Object.assign(new Error('Unique constraint failed on (household_id, ref)'), { code: 'P2002' });
      seenRefs.add(key);
    }
  }

  /** The surface of `prisma` (and of a transaction client) the importer and the realignment use. */
  client() {
    const self = this;
    const transaction = {
      findMany: async (args: { where: Where }) => self.txs.filter((tx) => self.matchTx(tx, args.where)).map((tx) => self.view(tx)),
      findFirst: async (args: { where: Where }) => {
        const found = self.txs.find((tx) => self.matchTx(tx, args.where));
        return found ? self.view(found) : null;
      },
      update: async (args: { where: { id: string }; data: Partial<FakeTx> }) => {
        const tx = self.txs.find((t) => t.id === args.where.id);
        if (!tx) throw Object.assign(new Error('not found'), { code: 'P2025' });
        const before = tx.sourceRef;
        Object.assign(tx, args.data);
        tx.updatedAt += 1;
        if (args.data.sourceRef !== undefined) self.updateLog.push(`${tx.id}:${tx.sourceRef}`);
        try {
          self.assertUnique();
        } catch (error) {
          tx.sourceRef = before;
          throw error;
        }
        return self.view(tx);
      },
    };
    const transactionExternalRef = {
      findMany: async (args: { where: Where }) => self.refs.filter((r) => self.matchRef(r, args.where)),
      update: async (args: { where: { id: string }; data: Partial<FakeExternalRef> }) => {
        const ref = self.refs.find((r) => r.id === args.where.id);
        if (!ref) throw Object.assign(new Error('not found'), { code: 'P2025' });
        const before = ref.ref;
        Object.assign(ref, args.data);
        try {
          self.assertUnique();
        } catch (error) {
          ref.ref = before;
          throw error;
        }
        return ref;
      },
    };
    const raw = async (strings: TemplateStringsArray | string[]) => {
      self.rawLog.push(Array.from(strings).join('?'));
      return [];
    };
    const client: Record<string, unknown> = {
      transaction,
      transactionExternalRef,
      $queryRaw: raw,
      $executeRaw: raw,
    };
    // An interactive transaction: all or nothing, like the database (snapshot and restore on error).
    client.$transaction = async (fn: (tx: unknown) => Promise<unknown>) => {
      const snapshot = JSON.stringify({ txs: self.txs, refs: self.refs });
      try {
        return await fn(client);
      } catch (error) {
        const restored = JSON.parse(snapshot) as { txs: FakeTx[]; refs: FakeExternalRef[] };
        self.txs = restored.txs.map((t) => ({ ...t, date: new Date(t.date) }));
        self.refs = restored.refs;
        throw error;
      }
    };
    return client;
  }

  refOf(id: string): string | null {
    return this.txs.find((tx) => tx.id === id)?.sourceRef ?? null;
  }

  /** `sourceRef -> description` of the stored sheet rows of a section (futures excluded). */
  bySection(monthKey: string, section: string): Record<string, string | null> {
    const out: Record<string, string | null> = {};
    const prefix = `maxfin:${monthKey}:${section}:`;
    for (const tx of this.txs) {
      if (tx.sourceRef?.startsWith(prefix) && /^\d+$/.test(tx.sourceRef.slice(prefix.length))) out[tx.sourceRef] = tx.description;
    }
    return out;
  }
}
