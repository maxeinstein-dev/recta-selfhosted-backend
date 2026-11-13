import type { ParsedCapture } from './types.js';

/**
 * Notices a bank sends that are never a transaction: offers and limits written with "até R$", the FGTS anticipation,
 * and any text without an amount that names no transaction (advertising, "seu limite aumentou"). Only consulted after
 * every transaction format failed; an unknown text WITH an amount is not a notice (it stays for the user).
 */
const UP_TO_AMOUNT = /\baté R\$/i;
const FGTS = /\bFGTS\b/i;
const ANY_AMOUNT = /R\$\s*\d/;
// Words of a transaction: a text cut before its amount that carries one of these is left for the user, never dismissed.
const TRANSACTION_WORD = /(compra|pix|transfer[êe]ncia|pagamento|pago|estorn|boleto|d[ée]bito|dep[óo]sit|recebid|enviad|saque|fatura)/i;

export function isNotice(text: string): boolean {
  if (UP_TO_AMOUNT.test(text) || FGTS.test(text)) return true;
  return !ANY_AMOUNT.test(text) && !TRANSACTION_WORD.test(text);
}

/** The reading of a notice: the capture is dismissed on intake (and can be restored by the user). */
export function noticeReading(): ParsedCapture {
  return { kind: 'IGNORE', type: null, amountCents: null, amount: null, description: null, ignore: true };
}
