// Response shapes of the people module (the HTTP contract of phase 4). Amounts are reais with 2 decimals.
import type { SettlementDirection, ShareDirection } from './balance.js';

export type { SettlementDirection, ShareDirection };

export interface PersonDto {
  id: string;
  householdId: string;
  name: string;
  aliases: string[];
  userId: string | null;
  isActive: boolean;
}

export interface PersonBalanceDto {
  person: PersonDto;
  owedToMe: number;
  iOwe: number;
  received: number;
  paid: number;
  /** owedToMe - iOwe - received + paid ; > 0 = the person owes me */
  balance: number;
  openShares: number;
}

export interface LedgerEntryDto {
  kind: 'share' | 'settlement';
  id: string;
  date: string;
  description: string;
  direction: ShareDirection | SettlementDirection;
  amount: number;
  signed: number;
  balanceAfter: number;
  transactionId: string | null;
  transactionAmount: number | null;
  note: string | null;
  source: 'manual' | 'import' | null;
}

export interface LedgerPage {
  data: LedgerEntryDto[];
  pagination: { nextCursor: string | null; hasMore: boolean; total: number };
}

export interface TransactionShareDto {
  id: string;
  transactionId: string;
  personId: string;
  personName: string;
  direction: ShareDirection;
  amount: number;
  note: string | null;
  source: 'manual' | 'import';
}

export interface TransactionSharesResponse {
  transactionId: string;
  transactionAmount: number;
  shares: TransactionShareDto[];
  /** Transaction amount minus the shares THEY_OWE_ME */
  myPart: number;
}

export interface SharePreviewResponse {
  shares: Array<{ personId: string; amount: number }>;
  myPart: number;
}

export interface SettlementDto {
  id: string;
  personId: string;
  direction: SettlementDirection;
  amount: number;
  date: string;
  transactionId: string | null;
  note: string | null;
}

// ---- Organize ----

export interface ShareProposal {
  /** Deterministic: transaction + person (as written in the note) + direction */
  id: string;
  transactionId: string;
  description: string;
  date: string;
  transactionAmount: number;
  /** The note that originated it */
  note: string;
  /** id null = a person to create */
  person: { id: string | null; name: string };
  direction: ShareDirection;
  amount: number;
  percent: number | null;
  defaultSelected: boolean;
}

export interface ReviewLine {
  transactionId: string;
  description: string;
  date: string;
  transactionAmount: number;
  note: string;
  reason: string;
  suggestedPersonId: string | null;
}

export interface SettlementProposal {
  id: string;
  transactionId: string;
  description: string;
  date: string;
  amount: number;
  person: { id: string | null; name: string };
  direction: SettlementDirection;
  defaultSelected: boolean;
}

export interface OrganizePreview {
  proposals: ShareProposal[];
  review: ReviewLine[];
  settlements: SettlementProposal[];
  newPeople: Array<{ name: string; aliases: string[] }>;
  alreadyDone: number;
  warnings: string[];
}

export interface OrganizeApplyResult {
  peopleCreated: number;
  sharesCreated: number;
  settlementsCreated: number;
  skipped: number;
  warnings: string[];
}
