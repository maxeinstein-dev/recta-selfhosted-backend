import { BRL, cleanMerchant, money, parsePositiveCents } from './amount.js';
import type { AppParser } from './types.js';

/** Senders (the notification title) whose e-mails are read. Same list the server uses to refuse other Gmail titles. */
export const GMAIL_SENDERS = ['Mercado Pago'] as const;

const PIX_SENT = new RegExp(String.raw`^Seu Pix de ${BRL} foi enviado\s*$`);
const DATE_LINE = /, às \d{1,2}:\d{2}(?::\d{2})?\.?\s*$/;

/**
 * Mercado Pago Pix sent: the app does not notify it, but the e-mail does (Gmail). The receiver name is the line after
 * the date; the CPF/CNPJ line that follows is never read. A text cut before the name falls back to "Pix enviado".
 */
function parseMercadoPagoPixSent(text: string) {
  const lines = text.split(/\r?\n/).map((l) => l.trim());
  const at = lines.findIndex((l) => PIX_SENT.test(l));
  if (at < 0) return null;
  const cents = parsePositiveCents(PIX_SENT.exec(lines[at]!)![1]!);
  if (cents === null) return null;
  let description = 'Pix enviado';
  if (DATE_LINE.test(lines[at + 1] ?? '')) {
    const name = cleanMerchant(lines[at + 2] ?? '');
    if (name && !/^(CPF\/CNPJ|Mercado Pago)/i.test(name)) description = name;
  }
  return { kind: 'PIX_OUT' as const, type: 'EXPENSE' as const, ...money(cents), method: 'PIX' as const, description };
}

export const parseGmail: AppParser = ({ title, text }) => {
  const sender = (title ?? '').trim();
  if (!GMAIL_SENDERS.some((s) => s === sender)) return null;
  return sender === 'Mercado Pago' ? parseMercadoPagoPixSent(text) : null;
};
