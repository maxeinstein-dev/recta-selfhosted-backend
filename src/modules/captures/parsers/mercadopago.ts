import { BRL, money, normalizeText, parsePositiveCents } from './amount.js';
import { isNotice, noticeReading } from './notice.js';
import type { AppParser } from './types.js';

const PIX_DEPOSIT = new RegExp(String.raw`^Você depositou ${BRL} via Pix e o valor já está rendendo na sua conta\.?$`, 'i');

export const parseMercadoPago: AppParser = ({ text }) => {
  const body = normalizeText(text);
  const m = PIX_DEPOSIT.exec(body);
  if (m) {
    // Decided 13/11/2026: income with a warning, no pairing with an outflow of another account.
    const cents = parsePositiveCents(m[1]!);
    if (cents === null) return null;
    return { kind: 'PIX_IN', type: 'INCOME', ...money(cents), method: 'PIX', description: 'Depósito via Pix', warning: 'POSSIBLE_OWN_TRANSFER' };
  }
  return body && isNotice(body) ? noticeReading() : null;
};
