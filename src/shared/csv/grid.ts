/**
 * Zero-dependency RFC 4180 CSV tokenizer used by spreadsheet importers.
 *
 * The output is a raw grid: no trimming, no type coercion, and every logical
 * record (including blank lines) becomes exactly one row, so row indexes in
 * the grid match line numbers in the uploaded file.
 */

export type Grid = string[][];
export type CsvDelimiter = ',' | ';';
export type CsvEncoding = 'utf-8' | 'windows-1252';

const UTF8_BOM = [0xef, 0xbb, 0xbf] as const;

/**
 * Decodes an uploaded CSV buffer. Tries strict UTF-8 first and falls back to
 * windows-1252 (the usual encoding of Excel exports on pt-BR Windows).
 * A leading UTF-8 BOM is stripped and reported through `hadBom`.
 */
export function decodeCsvBuffer(buffer: Buffer): {
  text: string;
  encoding: CsvEncoding;
  hadBom: boolean;
} {
  const hadBom = hasUtf8Bom(buffer);
  const bytes = hadBom ? buffer.subarray(UTF8_BOM.length) : buffer;

  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
    return { text, encoding: 'utf-8', hadBom };
  } catch {
    return { text: decodeWindows1252(bytes), encoding: 'windows-1252', hadBom };
  }
}

function hasUtf8Bom(buffer: Buffer): boolean {
  return buffer.length >= UTF8_BOM.length && UTF8_BOM.every((byte, index) => buffer[index] === byte);
}

function decodeWindows1252(bytes: Buffer): string {
  try {
    return new TextDecoder('windows-1252').decode(bytes);
  } catch {
    // Node builds without ICU cannot construct this decoder. latin1 matches
    // cp1252 everywhere except the 0x80-0x9F range, which is close enough.
    return bytes.toString('latin1');
  }
}

/**
 * Picks the delimiter by counting ',' against ';' in the first non-blank
 * record. Characters inside double quotes are ignored, and the scan is
 * quote-aware so a quoted first cell spanning several lines does not cut it
 * short. A tie (or no delimiter at all) resolves to ','.
 */
export function detectDelimiter(text: string): CsvDelimiter {
  let commas = 0;
  let semicolons = 0;
  let inQuotes = false;
  let atFieldStart = true;
  let sawContent = false;

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') i++;
        else inQuotes = false;
      }
      continue;
    }

    if (ch === '\n' || ch === '\r') {
      if (sawContent) break;
      atFieldStart = true; // blank or whitespace-only line: the next line starts a fresh field
      continue;
    }

    if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      sawContent = true;
      continue;
    }

    if (ch === ',') commas++;
    else if (ch === ';') semicolons++;

    // Either candidate may end a field, so a quote right after one is an opening quote.
    atFieldStart = ch === ',' || ch === ';';
    if (ch !== ' ' && ch !== '\t') sawContent = true;
  }

  return semicolons > commas ? ';' : ',';
}

/**
 * Tokenizes CSV text into a grid of raw cells (RFC 4180, lenient).
 *
 * - CRLF, LF and a lone CR all end a record; a trailing terminator adds no record.
 * - A quoted cell may contain the delimiter, line breaks (normalized to '\n')
 *   and '""' escapes. Text after a closing quote is appended literally.
 * - A stray '"' inside an unquoted cell is kept literally.
 * - A blank line becomes [''] so downstream row numbers match the file.
 */
export function parseCsvGrid(text: string, delimiter: CsvDelimiter = detectDelimiter(text)): Grid {
  const grid: Grid = [];
  let row: string[] = [];
  let cell = '';
  let inQuotes = false;
  let atFieldStart = true;
  // Where the pending record starts; equals text.length when the text ended on a terminator.
  let recordStart = 0;

  const endRecord = (nextIndex: number): void => {
    row.push(cell);
    grid.push(row);
    row = [];
    cell = '';
    atFieldStart = true;
    recordStart = nextIndex;
  };

  let i = 0;
  while (i < text.length) {
    const ch = text[i];

    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          cell += '"';
          i += 2;
        } else {
          inQuotes = false;
          i += 1;
        }
      } else if (ch === '\r') {
        cell += '\n';
        i += text[i + 1] === '\n' ? 2 : 1;
      } else {
        cell += ch;
        i += 1;
      }
      continue;
    }

    if (ch === delimiter) {
      row.push(cell);
      cell = '';
      atFieldStart = true;
      i += 1;
    } else if (ch === '\n') {
      endRecord(i + 1);
      i += 1;
    } else if (ch === '\r') {
      const next = text[i + 1] === '\n' ? i + 2 : i + 1;
      endRecord(next);
      i = next;
    } else if (ch === '"' && atFieldStart) {
      inQuotes = true;
      atFieldStart = false;
      i += 1;
    } else {
      cell += ch;
      atFieldStart = false;
      i += 1;
    }
  }

  // Flush the last record unless the text ended exactly on a terminator (or was empty).
  if (recordStart < text.length) {
    row.push(cell);
    grid.push(row);
  }

  return grid;
}

/** Decodes, detects the delimiter and tokenizes an uploaded CSV buffer in one call. */
export function bufferToGrid(buffer: Buffer): {
  grid: Grid;
  delimiter: CsvDelimiter;
  encoding: CsvEncoding;
  hadBom: boolean;
} {
  const { text, encoding, hadBom } = decodeCsvBuffer(buffer);
  const delimiter = detectDelimiter(text);

  return { grid: parseCsvGrid(text, delimiter), delimiter, encoding, hadBom };
}
