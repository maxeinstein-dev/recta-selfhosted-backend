import { BRL, parsePositiveAmount } from './amount.js';
import type { AppParser } from './types.js';

const PIX_DEPOSIT = new RegExp(String.raw`^Você depositou ${BRL} via Pix e o valor já está rendendo na sua conta\.?$`);

export const parseMercadoPago: AppParser = ({ text }) => {
  const m = PIX_DEPOSIT.exec(text.trim());
  if (!m) return null;
  const amount = parsePositiveAmount(m[1]!);
  if (amount === null) return null;
  return { kind: 'OWN_TRANSFER_IN', type: null, amount, description: 'Depósito via Pix' };
};
