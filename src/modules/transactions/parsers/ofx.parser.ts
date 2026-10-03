export interface ParsedRow {
  date: Date;
  description: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
}

export const OFX_DEFAULT_DESCRIPTION = 'Importação OFX';

const TRNAMT_REGEX = /<TRNAMT>([^\r\n<]+)/;
const DTPOSTED_REGEX = /<DTPOSTED>([^\r\n<]+)/;
const MEMO_REGEX = /<MEMO>([^\r\n<]+)/;

function extract(regex: RegExp, block: string): string | null {
  const match = regex.exec(block);
  if (!match?.[1]) return null;
  const value = match[1].trim();
  return value.length > 0 ? value : null;
}

function buildDate(
  year: number,
  month: number,
  day: number,
  hour = 0,
  minute = 0,
  second = 0,
): Date | null {
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  if (hour > 23 || minute > 59 || second > 59) return null;
  const date = new Date(year, month - 1, day, hour, minute, second);
  if (
    date.getFullYear() !== year ||
    date.getMonth() !== month - 1 ||
    date.getDate() !== day
  ) {
    return null;
  }
  return date;
}

function parseOfxDate(raw: string): Date | null {
  const value = raw.trim();
  if (value.length >= 14 && /^\d{14}/.test(value)) {
    const chunk = value.slice(0, 14);
    return buildDate(
      Number(chunk.slice(0, 4)),
      Number(chunk.slice(4, 6)),
      Number(chunk.slice(6, 8)),
      Number(chunk.slice(8, 10)),
      Number(chunk.slice(10, 12)),
      Number(chunk.slice(12, 14)),
    );
  }
  if (value.length >= 8 && /^\d{8}/.test(value)) {
    const chunk = value.slice(0, 8);
    return buildDate(
      Number(chunk.slice(0, 4)),
      Number(chunk.slice(4, 6)),
      Number(chunk.slice(6, 8)),
    );
  }
  return null;
}

export function parseOfx(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const blocks = text.split('<STMTTRN>');

  for (let i = 1; i < blocks.length; i++) {
    const block = blocks[i] as string;

    const amountRaw = extract(TRNAMT_REGEX, block);
    const dateRaw = extract(DTPOSTED_REGEX, block);
    if (amountRaw === null || dateRaw === null) continue;

    const rawAmount = Number(amountRaw.replace(',', '.'));
    if (!Number.isFinite(rawAmount)) continue;

    const date = parseOfxDate(dateRaw);
    if (date === null) continue;

    const memo = extract(MEMO_REGEX, block);
    rows.push({
      date,
      description: memo ?? OFX_DEFAULT_DESCRIPTION,
      amount: Math.abs(rawAmount),
      type: rawAmount >= 0 ? 'INCOME' : 'EXPENSE',
    });
  }

  return rows;
}
