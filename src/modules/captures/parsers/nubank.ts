import { BRL, cleanMerchant, money, normalizeText, parsePositiveCents } from './amount.js';
import { isNotice, noticeReading } from './notice.js';
import type { AppParser } from './types.js';

// Matched on the normalized text (single spaces), case-insensitive; the merchant keeps the case it came with.
const CARD_PURCHASE = new RegExp(String.raw`^Compra de ${BRL} APROVADA em (.+?) para o cartão com final (\d{4})\.?$`, 'i');
const NUPAY = new RegExp(String.raw`^${BRL} em (\d{1,2})x no crédito sem juros com NuPay APROVADO em (.+?)\.?$`, 'i');
const REFUND = new RegExp(String.raw`^A compra em (.+?) no valor de ${BRL} foi estornada\.?$`, 'i');
const NUPAY_REFUND = /^NuPay: estorno recebido de compra no crédito (?:na|no|em|de) (.+)$/i;
const TRANSFER_IN = new RegExp(String.raw`^Recebemos sua transferência de ${BRL}\.?$`, 'i');

export const parseNubank: AppParser = ({ text }) => {
  const body = normalizeText(text);

  let m = CARD_PURCHASE.exec(body);
  if (m) {
    const cents = parsePositiveCents(m[1]!);
    const merchant = cleanMerchant(m[2]!);
    if (cents === null || !merchant) return null;
    return { kind: 'CARD_PURCHASE', type: 'EXPENSE', ...money(cents), method: 'CREDIT', merchant, description: merchant, cardLast4: m[3]! };
  }

  m = NUPAY.exec(body);
  if (m) {
    const cents = parsePositiveCents(m[1]!);
    const merchant = cleanMerchant(m[3]!);
    if (cents === null || !merchant) return null;
    return { kind: 'CARD_PURCHASE', type: 'EXPENSE', ...money(cents), method: 'NUPAY', merchant, description: merchant, installments: Number(m[2]) };
  }

  m = REFUND.exec(body);
  if (m) {
    const cents = parsePositiveCents(m[2]!);
    const merchant = cleanMerchant(m[1]!);
    if (cents === null || !merchant) return null;
    return { kind: 'REFUND', type: 'INCOME', ...money(cents), merchant, description: `Estorno: ${merchant}` };
  }

  m = NUPAY_REFUND.exec(body);
  if (m) {
    // The text seen so far is cut by Android before any amount: take it when present, else leave it for the user.
    const rest = m[1]!;
    const merchant = cleanMerchant(rest.split(/\s+(?:no valor|com valor|de R\$|R\$)|[.…]/i)[0]!);
    if (!merchant) return null;
    const amountMatch = new RegExp(BRL).exec(rest);
    const cents = amountMatch ? parsePositiveCents(amountMatch[1]!) : null;
    return { kind: 'REFUND', type: 'INCOME', ...money(cents), merchant, description: `Estorno: ${merchant}` };
  }

  m = TRANSFER_IN.exec(body);
  if (m) {
    // "sua transferência": money the user sent in. Decided 13/11/2026: income of the Nubank account (by account
    // rule), flagged so the user can tell it from a salary or a payment received.
    const cents = parsePositiveCents(m[1]!);
    if (cents === null) return null;
    return { kind: 'PIX_IN', type: 'INCOME', ...money(cents), method: 'TRANSFER', description: 'Transferência recebida', warning: 'POSSIBLE_OWN_TRANSFER' };
  }

  return body && isNotice(body) ? noticeReading() : null;
};
