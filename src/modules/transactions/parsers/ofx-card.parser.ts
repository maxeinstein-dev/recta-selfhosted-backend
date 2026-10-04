/**
 * Parser for credit card invoices in OFX (the `CREDITCARDMSGSRSV1/CCSTMTRS` statement): OFX 1.x (SGML, with or
 * without closing tags on the elements) and 2.x (XML). Pure: no I/O, no database.
 *
 * Each `STMTTRN` becomes a line with a stable reference, its kind and the installment written in the memo. The
 * special memos ("Parcela N/M", "NuPay", "Desconto Antecipação", "Pagamento recebido") are Nubank's; any other
 * bank's card statement still parses, its lines being plain purchases (negative) and credits (positive).
 */
import { createHash } from 'node:crypto';

import { decodeCsvBuffer } from '../../../shared/csv/grid.js';
import { BadRequestError } from '../../../shared/errors/app-error.js';
import { OFX_DEFAULT_DESCRIPTION, parseOfxDate } from './ofx.parser.js';

/** purchase: negative amount; refund: positive credit; discount: "Desconto Antecipação"; payment: "Pagamento recebido". */
export type CardOfxKind = 'purchase' | 'refund' | 'discount' | 'payment';

export interface CardOfxInstallment {
  number: number;
  total: number;
}

export interface CardOfxStatementLine {
  /** `ofx:<FITID>:<first 8 hex of sha1(memo|signed amount|date)>`, see cardOfxRef. */
  ref: string;
  fitid: string;
  /** YYYY-MM-DD: the day DTPOSTED prints, in the statement's own clock. */
  date: string;
  /** Absolute value, > 0. */
  amount: number;
  /** purchase = EXPENSE; refund, discount and payment = INCOME. */
  type: 'INCOME' | 'EXPENSE';
  kind: CardOfxKind;
  memo: string;
  /** The memo without " - Parcela N/M" and " - NuPay". */
  merchant: string;
  installment: CardOfxInstallment | null;
}

export interface CardOfxStatement {
  /** DTSTART / DTEND of the transaction list (YYYY-MM-DD), null when absent. */
  period: { start: string | null; end: string | null };
  /** LEDGERBAL/BALAMT (signed, as the bank wrote it), null when absent. */
  balance: number | null;
  lines: CardOfxStatementLine[];
  /** Transactions that could not be read (1-based position in the list and why). */
  skipped: Array<{ position: number; reason: string }>;
  warnings: string[];
}

/** Installment plans longer than this are not installments (the importer's own cap, as in the monthly sheet). */
export const MAX_CARD_INSTALLMENTS = 99;
/** A FITID longer than this (or with characters outside [A-Za-z0-9._-]) is hashed in refs and plan ids. */
const MAX_FITID_TOKEN = 64;
const MAX_MEMO_LENGTH = 255;

const CARD_STATEMENT_REGEX = /<CCSTMTRS>/i;
const INSTALLMENT_IN_MEMO = /\bparcela\s+(\d{1,3})\s*\/\s*(\d{1,3})\b/i;

/** True when the text holds a credit card statement (`CCSTMTRS`), whatever else it holds. */
export function isCardStatementOfx(text: string): boolean {
  return CARD_STATEMENT_REGEX.test(text);
}

function sha1Hex(text: string): string {
  return createHash('sha1').update(text, 'utf8').digest('hex');
}

function stripAccents(text: string): string {
  return text.normalize('NFD').replace(/\p{M}/gu, '');
}

/**
 * The FITID as it goes into refs and plan ids: as is when it is short and made of [A-Za-z0-9._-] (Nubank uses
 * UUIDs), otherwise `h` + 32 hex of its sha1, so a ref never holds a separator and never passes 120 characters.
 */
export function fitidToken(fitid: string): string {
  const trimmed = fitid.trim();
  if (trimmed.length > 0 && trimmed.length <= MAX_FITID_TOKEN && /^[A-Za-z0-9._-]+$/.test(trimmed)) return trimmed;
  return `h${sha1Hex(trimmed).slice(0, 32)}`;
}

/** Signed amount with two decimals, the way it enters the ref hash ("-100.00"). */
function signedAmountText(signedAmount: number): string {
  const cents = Math.round(signedAmount * 100);
  return (cents / 100).toFixed(2);
}

/**
 * Stable reference of a line: `ofx:<FITID>:<8 hex>`, the hex being the start of sha1("memo|signed amount|date").
 * The FITID repeats across the installments of one purchase (and its discount), the hash tells them apart. Two
 * lines identical in all four fields get `|#2`, `|#3`... appended to the hashed text, in file order.
 */
export function cardOfxRef(fitid: string, memo: string, signedAmount: number, date: string, occurrence = 1): string {
  const suffix = occurrence > 1 ? `|#${occurrence}` : '';
  const hash = sha1Hex(`${memo}|${signedAmountText(signedAmount)}|${date}${suffix}`).slice(0, 8);
  return `ofx:${fitidToken(fitid)}:${hash}`;
}

/** Key of the lines that share one ref sequence (the occurrence counter of cardOfxRef). */
export function cardOfxContentKey(fitid: string, memo: string, signedAmount: number, date: string): string {
  return `${fitid}|${memo}|${signedAmountText(signedAmount)}|${date}`;
}

/** Kind of a line from its memo and signed amount (Nubank's texts, accents and case ignored). */
export function classifyCardOfxLine(memo: string, signedAmount: number): CardOfxKind {
  if (signedAmount < 0) return 'purchase';
  const text = stripAccents(memo).toLowerCase().replace(/\s+/g, ' ').trim();
  if (text.startsWith('pagamento recebido')) return 'payment';
  if (text.startsWith('desconto antecipa')) return 'discount';
  return 'refund';
}

/** "Loja - Parcela 3/10" -> { number: 3, total: 10 }; null when absent or not a real plan (N > M, M > 99). */
export function installmentFromMemo(memo: string): CardOfxInstallment | null {
  const match = INSTALLMENT_IN_MEMO.exec(memo);
  if (!match) return null;
  const number = Number(match[1]);
  const total = Number(match[2]);
  if (number < 1 || number > total || total > MAX_CARD_INSTALLMENTS) return null;
  return { number, total };
}

/** The memo without " - Parcela N/M" and " - NuPay" (the memo itself when nothing else is left). */
export function merchantFromMemo(memo: string): string {
  const stripped = memo
    .replace(/\s*-\s*parcela\s+\d+\s*\/\s*\d+/gi, '')
    .replace(/\s*-\s*nupay\b/gi, '')
    .replace(/\s+/g, ' ')
    .trim();
  return stripped.length > 0 ? stripped : memo.trim();
}

/** Line type from its kind: only purchases are expenses. */
export function cardOfxLineType(kind: CardOfxKind): 'INCOME' | 'EXPENSE' {
  return kind === 'purchase' ? 'EXPENSE' : 'INCOME';
}

const NAMED_ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

/** Decodes the character references OFX uses in SGML and XML alike (&amp; &lt; &#233; &#xE9; ...). */
function decodeEntities(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body: string) => {
    if (body[0] === '#') {
      const code = body[1] === 'x' || body[1] === 'X' ? parseInt(body.slice(2), 16) : parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? whole;
  });
}

/**
 * Value of the first `<TAG>` in the text: up to the next tag or line break, so it reads SGML elements without
 * closing tags as well as XML ones. Null when absent or blank.
 */
function tagValue(text: string, tag: string): string | null {
  const match = new RegExp(`<${tag}>[ \\t]*([^<\\r\\n]+)`, 'i').exec(text);
  if (!match?.[1]) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

/** 'YYYY-MM-DD' of an OFX date-time, null when it is not a real day. */
function ofxDay(raw: string | null): string | null {
  if (raw === null) return null;
  const date = parseOfxDate(raw);
  if (date === null) return null;
  const y = String(date.getFullYear()).padStart(4, '0');
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

/** OFX amounts use '.' or ',' as the decimal mark and no grouping. */
function parseOfxAmount(raw: string | null): number | null {
  if (raw === null) return null;
  const value = Number(raw.replace(/\s+/g, '').replace(',', '.'));
  return Number.isFinite(value) ? value : null;
}

/** Text between `<TAG>` and `</TAG>` (or the end when the closing tag is missing); null when the tag is absent. */
function section(text: string, tag: string): string | null {
  const open = new RegExp(`<${tag}>`, 'i').exec(text);
  if (!open) return null;
  const start = open.index + open[0].length;
  const close = new RegExp(`</${tag}>`, 'i').exec(text.slice(start));
  return close ? text.slice(start, start + close.index) : text.slice(start);
}

function cutMemo(memo: string): string {
  if (memo.length <= MAX_MEMO_LENGTH) return memo;
  const cut = memo.slice(0, MAX_MEMO_LENGTH);
  const last = cut.charCodeAt(cut.length - 1);
  return last >= 0xd800 && last <= 0xdbff ? cut.slice(0, -1) : cut;
}

/**
 * Parse a credit card invoice in OFX. The buffer is read as UTF-8 and, when it is not valid UTF-8, as windows-1252
 * (the CHARSET header is not trusted: Nubank declares 1252 and writes UTF-8).
 * @throws BadRequestError (400) when the file holds no credit card statement (`CCSTMTRS`).
 */
export function parseCardOfx(input: Buffer | string): CardOfxStatement {
  const text = typeof input === 'string' ? input : decodeCsvBuffer(input).text;
  const statement = section(text, 'CCSTMTRS');
  if (statement === null) {
    throw new BadRequestError(
      'Not a credit card invoice: the OFX has no credit card statement (CCSTMTRS). Bank account statements go to POST /transactions/import/preview.',
    );
  }

  const warnings: string[] = [];
  if ((text.match(/<CCSTMTRS>/gi) ?? []).length > 1) {
    warnings.push('O arquivo tem mais de uma fatura de cartão; só a primeira foi lida.');
  }

  const list = section(statement, 'BANKTRANLIST') ?? '';
  const blocks = list.split(/<STMTTRN>/i);
  const header = blocks[0] ?? '';
  const period = { start: ofxDay(tagValue(header, 'DTSTART')), end: ofxDay(tagValue(header, 'DTEND')) };
  const ledger = section(statement, 'LEDGERBAL');
  const balance = ledger === null ? null : parseOfxAmount(tagValue(ledger, 'BALAMT'));

  const lines: CardOfxStatementLine[] = [];
  const skipped: CardOfxStatement['skipped'] = [];
  const occurrences = new Map<string, number>();

  for (let i = 1; i < blocks.length; i++) {
    const raw = blocks[i] as string;
    const end = /<\/STMTTRN>/i.exec(raw);
    const block = end ? raw.slice(0, end.index) : raw;

    const signed = parseOfxAmount(tagValue(block, 'TRNAMT'));
    const date = ofxDay(tagValue(block, 'DTPOSTED'));
    const fitid = tagValue(block, 'FITID');
    if (signed === null) {
      skipped.push({ position: i, reason: 'valor (TRNAMT) ausente ou ilegível' });
      continue;
    }
    if (date === null) {
      skipped.push({ position: i, reason: 'data (DTPOSTED) ausente ou inválida' });
      continue;
    }
    if (fitid === null) {
      skipped.push({ position: i, reason: 'identificador (FITID) ausente' });
      continue;
    }
    const roundedCents = Math.round(signed * 100);
    if (roundedCents === 0) {
      skipped.push({ position: i, reason: 'valor zero' });
      continue;
    }

    const memoRaw = tagValue(block, 'MEMO') ?? tagValue(block, 'NAME');
    const memoText = memoRaw === null ? '' : cutMemo(decodeEntities(memoRaw).replace(/\s+/g, ' ').trim());
    const memo = memoText.length > 0 ? memoText : OFX_DEFAULT_DESCRIPTION;
    const signedAmount = roundedCents / 100;
    const kind = classifyCardOfxLine(memo, signedAmount);
    const fitidValue = decodeEntities(fitid);

    const contentKey = cardOfxContentKey(fitidValue, memo, signedAmount, date);
    const occurrence = (occurrences.get(contentKey) ?? 0) + 1;
    occurrences.set(contentKey, occurrence);

    lines.push({
      ref: cardOfxRef(fitidValue, memo, signedAmount, date, occurrence),
      fitid: fitidValue,
      date,
      amount: Math.abs(signedAmount),
      type: cardOfxLineType(kind),
      kind,
      memo,
      merchant: merchantFromMemo(memo),
      installment: installmentFromMemo(memo),
    });
  }

  return { period, balance, lines, skipped, warnings };
}
