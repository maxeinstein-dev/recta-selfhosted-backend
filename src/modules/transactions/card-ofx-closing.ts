/**
 * Statement closing delta: the OFX total against what the card stores in the statement period (DTSTART..DTEND),
 * as it will be after the proposals selected by default are applied. Pure: the service loads the stored rows.
 *
 * delta = OFX total - card total in the period (cents, purchases positive, credits negative). It is split into what
 * explains it, so a month that does not close can be read instead of guessed at:
 *  - uncreated:      lines of proposals that are not selected (new purchases, reversal pairs) and are therefore
 *                    missing from the card;
 *  - heldMatches:    lines of matches that are not selected, minus the sheet rows they would replace (those stay in
 *                    the card total at their sheet amount);
 *  - sheetOnlyIn:    sheet rows of the month with no bank line, dated inside the period (they inflate the card);
 *  - foreignIn:      other card rows dated inside the period that this statement does not account for (rows of a
 *                    neighbouring sheet month, manual entries);
 *  - residual:       what none of the above explains (cents of rounding, matched rows dated outside the period).
 *  - advancePayments: sheet credits paired with advance payment lines (the payment is not in the OFX total);
 * delta = uncreated + heldMatches - sheetOnlyIn - foreignIn - advancePayments + residual.
 */
import type { CardOfxClosing } from './card-ofx-import.types.js';
import { toCents, type ReconcileLine, type ReconcileResult, type StoredCardRow } from './ofx-reconcile.js';

/** The residual of a closing that is explained (the bank rounds, the card rows do not). */
export const CLOSING_TOLERANCE_CENTS = 5;

function signedCents(type: 'INCOME' | 'EXPENSE', amount: number): number {
  const cents = toCents(amount);
  return type === 'EXPENSE' ? cents : -cents;
}

export interface ClosingInput {
  period: { start: string; end: string };
  /**
   * DTEND itself belongs to the period only when the OFX lists lines dated on it. Card statements close on that day
   * and the purchases of the closing day go to the next statement (which starts on it), so by default it is out.
   */
  endInclusive: boolean;
  /** Purchases minus refunds and discounts of the OFX, in cents. */
  ofxTotalCents: number;
  /** The OFX lines, in file order (payments included: they are left out here). */
  lines: ReconcileLine[];
  result: ReconcileResult;
  /** Card rows that are not invoice payments and are dated inside the period, as stored now. */
  stored: StoredCardRow[];
}

export function computeClosing(input: ClosingInput): CardOfxClosing {
  const { period, result } = input;
  const inPeriod = (date: string) => date >= period.start && (input.endInclusive ? date <= period.end : date < period.end);
  const lineByRef = new Map(input.lines.map((line) => [line.ref, line]));
  const netOf = (refs: string[]) => refs.reduce((total, ref) => total + signedCents(lineByRef.get(ref)!.type, lineByRef.get(ref)!.amount), 0);

  // The card as it is now, then the selected proposals applied to it.
  const projected = new Map<string, { cents: number; date: string; ofSheetOnly: boolean }>();
  const sheetOnlyIds = new Set(result.sheetOnly.map((row) => row.id));
  for (const row of input.stored) {
    projected.set(row.id, { cents: signedCents(row.type, row.amount), date: row.date, ofSheetOnly: sheetOnlyIds.has(row.id) });
  }
  const members = new Set<string>();
  for (const line of result.lines) if (line.transactionId) members.add(line.transactionId);
  for (const proposal of result.proposals) {
    if (proposal.target) members.add(proposal.target.id);
    for (const row of proposal.absorbed) members.add(row.id);
  }

  let uncreated = 0;
  let heldMatches = 0;
  // Sheet credits tied to advance payment lines (already reconciled, or paired by a selected proposal).
  const advanceIds = new Set<string>();
  input.lines.forEach((line, i) => {
    const reconciled = result.lines[i];
    if (line.kind === 'payment' && reconciled?.status === 'reconciled' && reconciled.transactionId) advanceIds.add(reconciled.transactionId);
  });
  for (const proposal of result.proposals) {
    const lineNet = netOf(proposal.refs);
    if (!proposal.defaultSelected) {
      if (proposal.kind === 'create' || proposal.kind === 'reversal') {
        uncreated += lineNet;
      } else if (proposal.target) {
        const rows = [proposal.target, ...proposal.absorbed];
        const standing = rows.filter((row) => inPeriod(row.date)).reduce((total, row) => total + signedCents(row.type, row.amount), 0);
        heldMatches += lineNet - standing;
      }
      continue;
    }
    switch (proposal.kind) {
      case 'create':
        proposal.refs.forEach((ref, i) => {
          const line = lineByRef.get(ref)!;
          projected.set(`new:${proposal.group}:${i}`, { cents: signedCents(line.type, line.amount), date: line.date, ofSheetOnly: false });
        });
        break;
      case 'reversal':
        break;
      default: {
        const target = proposal.target!;
        // An advance payment line is not in the OFX total; the sheet credit it pairs with stays in the card total.
        if (proposal.refs.every((ref) => lineByRef.get(ref)!.kind === 'payment')) advanceIds.add(target.id);
        const cents =
          proposal.kind === 'enrich-merge' || proposal.kind === 'consume-future' || proposal.kind === 'enrich-near' ? lineNet : signedCents(target.type, target.amount);
        projected.set(target.id, { cents, date: proposal.result!.date, ofSheetOnly: false });
        for (const row of proposal.absorbed) projected.delete(row.id);
      }
    }
  }

  let advancePayments = 0;
  let recorded = 0;
  let sheetOnlyIn = 0;
  let foreignIn = 0;
  for (const [id, entry] of projected) {
    if (!inPeriod(entry.date)) continue;
    recorded += entry.cents;
    if (advanceIds.has(id)) advancePayments += entry.cents;
    if (entry.ofSheetOnly) sheetOnlyIn += entry.cents;
    else if (!id.startsWith('new:') && !members.has(id)) foreignIn += entry.cents;
  }
  const sheetOnlyOutside = result.sheetOnly
    .filter((row) => !inPeriod(row.date))
    .reduce((total, row) => total + signedCents(row.type, row.amount), 0);

  const delta = input.ofxTotalCents - recorded;
  const residual = delta - (uncreated + heldMatches - sheetOnlyIn - foreignIn - advancePayments);
  const to = (cents: number) => cents / 100;
  return {
    periodStart: period.start,
    periodEnd: period.end,
    endInclusive: input.endInclusive,
    ofxTotal: to(input.ofxTotalCents),
    recordedTotal: to(recorded),
    delta: to(delta),
    components: {
      uncreated: to(uncreated),
      heldMatches: to(heldMatches),
      sheetOnlyInPeriod: to(sheetOnlyIn),
      foreignInPeriod: to(foreignIn),
      advancePayments: to(advancePayments),
      residual: to(residual),
    },
    sheetOnlyOutsidePeriod: to(sheetOnlyOutside),
    explained: Math.abs(residual) <= CLOSING_TOLERANCE_CENTS,
  };
}
