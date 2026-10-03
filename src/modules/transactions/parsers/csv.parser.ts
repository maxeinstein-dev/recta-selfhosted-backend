export interface ParsedRow {
  date: Date;
  description: string;
  amount: number;
  type: 'INCOME' | 'EXPENSE';
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

function parseCsvDate(raw: string): Date | null {
  const value = raw.trim();
  let match: RegExpMatchArray | null;

  if (
    (match = value.match(/^(\d{2})\/(\d{2})\/(\d{4}) (\d{2}):(\d{2}):(\d{2})$/))
  ) {
    return buildDate(
      Number(match[3]),
      Number(match[2]),
      Number(match[1]),
      Number(match[4]),
      Number(match[5]),
      Number(match[6]),
    );
  }
  if ((match = value.match(/^(\d{2})\/(\d{2})\/(\d{4})$/))) {
    return buildDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  if ((match = value.match(/^(\d{4})-(\d{2})-(\d{2})$/))) {
    return buildDate(Number(match[1]), Number(match[2]), Number(match[3]));
  }
  if ((match = value.match(/^(\d{2})-(\d{2})-(\d{4})$/))) {
    return buildDate(Number(match[3]), Number(match[2]), Number(match[1]));
  }
  return null;
}

function parseAmount(raw: string): number | null {
  const value = raw.trim();
  if (value.length === 0) return null;
  // Brazilian format uses '.' as thousands separator and ',' as decimal mark.
  // Only strip dots when a comma is present; otherwise parse as-is so that
  // plain "1234.56" is not mangled into "123456".
  const normalized = value.includes(',')
    ? value.replace(/\./g, '').replace(/,/g, '.')
    : value;
  const parsed = Number(normalized);
  return Number.isFinite(parsed) ? parsed : null;
}

export function parseCsv(text: string): ParsedRow[] {
  const rows: ParsedRow[] = [];
  const lines = text.split(/\r?\n/);

  // Skip header (first line), mirroring the reference implementation.
  for (let i = 1; i < lines.length; i++) {
    const line = (lines[i] as string).trim();
    if (line.length === 0) continue;

    const parts = line.split(/[;,]/);
    if (parts.length < 3) continue;

    const dateRaw = (parts[0] as string).trim();
    const description = (parts[1] as string).trim();
    // Rejoin leftover columns: a Brazilian amount such as "1.234,56"
    // contains a ',' separator, so it splits into two columns.
    const amountRaw = parts
      .slice(2)
      .join(',')
      .trim();

    const date = parseCsvDate(dateRaw);
    const rawAmount = parseAmount(amountRaw);
    if (date === null || rawAmount === null) continue;

    rows.push({
      date,
      description,
      amount: Math.abs(rawAmount),
      type: rawAmount >= 0 ? 'INCOME' : 'EXPENSE',
    });
  }

  return rows;
}
