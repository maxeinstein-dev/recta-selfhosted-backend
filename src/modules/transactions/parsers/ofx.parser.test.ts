import { describe, expect, it } from 'vitest';

import { parseOfx } from './ofx.parser.js';

const OFX_TWO_ENTRIES = `OFXHEADER:100
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
<STMTTRN>
<TRNTYPE>DEBIT
<DTPOSTED>20240116
<TRNAMT>-89.90
</STMTTRN>
</BANKTRANLIST>
</STMTRS>
</STMTTRNRS>
</BANKMSGSRSV1>
</OFX>
`;

describe('parseOfx', () => {
  it('parses two entries, one with MEMO and one without (default description)', () => {
    const rows = parseOfx(OFX_TWO_ENTRIES);

    expect(rows).toHaveLength(2);

    expect(rows[0]?.description).toBe('Salario mensal');
    expect(rows[0]?.amount).toBe(2500);
    expect(rows[0]?.type).toBe('INCOME');

    // No MEMO -> default description, negative value -> EXPENSE with positive amount
    expect(rows[1]?.description).toBe('Importação OFX');
    expect(rows[1]?.amount).toBe(89.9);
    expect(rows[1]?.type).toBe('EXPENSE');
  });

  it('parses full timestamp YYYYMMDDHHMMSS', () => {
    const rows = parseOfx(OFX_TWO_ENTRIES);

    expect(rows[0]?.date.getFullYear()).toBe(2024);
    expect(rows[0]?.date.getMonth()).toBe(0); // January
    expect(rows[0]?.date.getDate()).toBe(15);
    expect(rows[0]?.date.getHours()).toBe(12);
  });

  it('parses short date YYYYMMDD at start of day', () => {
    const rows = parseOfx(OFX_TWO_ENTRIES);

    expect(rows[1]?.date.getFullYear()).toBe(2024);
    expect(rows[1]?.date.getMonth()).toBe(0);
    expect(rows[1]?.date.getDate()).toBe(16);
    expect(rows[1]?.date.getHours()).toBe(0);
    expect(rows[1]?.date.getMinutes()).toBe(0);
  });

  it('discards entries without a valid date instead of falling back to now()', () => {
    const text = `<STMTTRN>
<DTPOSTED>not-a-date
<TRNAMT>100.00
<MEMO>Bad date
</STMTTRN>
<STMTTRN>
<DTPOSTED>20240301
<TRNAMT>50.00
<MEMO>Good entry
</STMTTRN>
`;
    const rows = parseOfx(text);

    expect(rows).toHaveLength(1);
    expect(rows[0]?.description).toBe('Good entry');
  });

  it('skips blocks missing TRNAMT', () => {
    const text = `<STMTTRN>
<DTPOSTED>20240301
<MEMO>No amount
</STMTTRN>
`;
    expect(parseOfx(text)).toHaveLength(0);
  });

  it('returns empty array for content without transactions', () => {
    expect(parseOfx('OFXHEADER:100\nno transactions here')).toEqual([]);
  });
});
