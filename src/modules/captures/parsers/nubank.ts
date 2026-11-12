import { BRL, cleanMerchant, parsePositiveAmount } from './amount.js';
import type { AppParser, ParsedCapture } from './types.js';

const CARD_PURCHASE = new RegExp(String.raw`^Compra de ${BRL} APROVADA em (.+?) para o cartão com final (\d{4})\.?$`, 's');
const NUPAY = new RegExp(String.raw`^${BRL} em (\d{1,2})x no crédito sem juros com NuPay APROVADO em (.+?)\.?$`, 's');
const REFUND = new RegExp(String.raw`^A compra em (.+?) no valor de ${BRL} foi estornada\.?$`, 's');
const NUPAY_REFUND = /^NuPay: estorno recebido de compra no crédito (?:na|no|em|de) (.+)$/s;
const TRANSFER_IN = new RegExp(String.raw`^Recebemos sua transferência de ${BRL}\.?$`);
const LIMIT_NOTICE = /^Agora você pode enviar até R\$\s*[\d.,]+ via Pix, TED e boleto/;

const ignored: ParsedCapture = { kind: 'IGNORE', type: null, amount: null, description: null, ignore: true };

export const parseNubank: AppParser = ({ text }) => {
  const body = text.trim();

  let m = CARD_PURCHASE.exec(body);
  if (m) {
    const amount = parsePositiveAmount(m[1]!);
    const merchant = cleanMerchant(m[2]!);
    if (amount === null || !merchant) return null;
    return { kind: 'CARD_PURCHASE', type: 'EXPENSE', amount, description: merchant, cardLast4: m[3]! };
  }

  m = NUPAY.exec(body);
  if (m) {
    const amount = parsePositiveAmount(m[1]!);
    const merchant = cleanMerchant(m[3]!);
    if (amount === null || !merchant) return null;
    return { kind: 'CARD_PURCHASE', type: 'EXPENSE', amount, description: merchant, installments: Number(m[2]) };
  }

  m = REFUND.exec(body);
  if (m) {
    const amount = parsePositiveAmount(m[2]!);
    const merchant = cleanMerchant(m[1]!);
    if (amount === null || !merchant) return null;
    return { kind: 'REFUND', type: 'INCOME', amount, description: `Estorno: ${merchant}` };
  }

  m = NUPAY_REFUND.exec(body);
  if (m) {
    // The text seen so far is cut by Android before any amount: take it when present, else leave it for the user.
    const rest = m[1]!;
    const merchant = cleanMerchant(rest.split(/\s+(?:no valor|com valor|de R\$|R\$)|[.…]/)[0]!);
    if (!merchant) return null;
    const amountMatch = new RegExp(BRL).exec(rest);
    const amount = amountMatch ? parsePositiveAmount(amountMatch[1]!) : null;
    return { kind: 'REFUND', type: 'INCOME', amount, description: `Estorno: ${merchant}` };
  }

  m = TRANSFER_IN.exec(body);
  if (m) {
    const amount = parsePositiveAmount(m[1]!);
    if (amount === null) return null;
    return { kind: 'OWN_TRANSFER_IN', type: null, amount, description: 'Transferência recebida' };
  }

  if (LIMIT_NOTICE.test(body)) return { ...ignored };
  return null;
};
