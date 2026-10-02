import { describe, expect, it } from 'vitest';

import { BadRequestError } from '../../shared/errors/index.js';
import {
  amountsEqual,
  getDayRange,
  parseImportBuffer,
} from './import.service.js';

const CSV_VALID = `data;descricao;valor
15/01/2024;Salario;2500.00
16/01/2024;Café;-12.50
`;

const OFX_VALID = `OFXHEADER:100
DATA:OFXSGML
VERSION:102
<OFX>
<BANKMSGSRSV1>
<STMTTRNRS>
<STMTRS>
<BANKTRANLIST>
<STMTTRN>
<TRNTYPE>CREDIT
<DTPOSTED>20240115120000
<TRNAMT>2500.00
<MEMO>Salario mensal
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe('parseImportBuffer (pure, no DB)', () => {
  it('parses CSV content by .csv extension', () => {
    const rows = parseImportBuffer('extrato.csv', Buffer.from(CSV_VALID, 'utf-8'));

    expect(rows).toHaveLength(2);
    expect(rows[0]?.type).toBe('INCOME');
    expect(rows[1]?.type).toBe('EXPENSE');
  });

  it('parses OFX content by extension, case-insensitive', () => {
    const rows = parseImportBuffer('Extrato.OFX', Buffer.from(OFX_VALID, 'utf-8'));

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Salario mensal');
  });

  it('rejects unsupported extensions with 400', () => {
    // NOTE: asserted via statusCode/code, not instanceof: AppError's
    // constructor resets the prototype to AppError.prototype, so
    // `instanceof BadRequestError` is false for its own instances
    // (pre-existing quirk in shared/errors/app-error.ts, out of scope).
    try {
      parseImportBuffer('extrato.txt', Buffer.from(CSV_VALID, 'utf-8'));
      expect.unreachable('should have thrown');
    } catch (error) {
      expect((error as BadRequestError).statusCode).toBe(400);
      expect((error as BadRequestError).code).toBe('BAD_REQUEST');
    }
  });

  it('rejects empty/unreadable content with 400', () => {
    for (const [filename, body] of [
      ['vazio.csv', ''],
      ['lixo.ofx', 'no transactions here'],
    ] as const) {
      try {
        parseImportBuffer(filename, Buffer.from(body, 'utf-8'));
        expect.unreachable('should have thrown');
      } catch (error) {
        expect((error as BadRequestError).statusCode).toBe(400);
        expect((error as BadRequestError).code).toBe('BAD_REQUEST');
      }
    }
  });
});

describe('dedup pure helpers (DB-free)', () => {
  it('getDayRange covers exactly the calendar day of the row', () => {
    const { start, end } = getDayRange(new Date(2024, 0, 15, 14, 30, 0));

    expect(start.getFullYear()).toBe(2024);
    expect(start.getMonth()).toBe(0);
    expect(start.getDate()).toBe(15);
    expect(start.getHours()).toBe(0);
    expect(end.getHours()).toBe(23);
    expect(end.getMinutes()).toBe(59);
    // Same instant belongs to the range
    const instant = new Date(2024, 0, 15, 14, 30, 0).getTime();
    expect(start.getTime()).toBeLessThanOrEqual(instant);
    expect(end.getTime()).toBeGreaterThanOrEqual(instant);
  });

  it('amountsEqual tolerates float noise but not real cent differences', () => {
    expect(amountsEqual(89.9, 89.9)).toBe(true);
    expect(amountsEqual(0.1 + 0.2, 0.3)).toBe(true);
    expect(amountsEqual(100, 100.01)).toBe(false);
    expect(amountsEqual(100, 101)).toBe(false);
  });
});
