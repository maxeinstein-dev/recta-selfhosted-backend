import { describe, expect, it } from 'vitest';

import { decodeEntities, XmlScanner, type XmlTokenKind } from './xml-scanner.js';

interface Token {
  kind: XmlTokenKind;
  name?: string;
  text: string;
}

/** Every token of a part with the text before it; tag names are recovered with is() over the given names. */
function tokens(xml: string, names: string[] = ['a', 'b', 'c', 't', 'v', 'row', 'sheet']): Token[] {
  const scanner = new XmlScanner(xml, 'test.xml');
  const result: Token[] = [];
  while (scanner.next()) {
    const name = names.find((candidate) => scanner.is(candidate));
    result.push({ kind: scanner.kind!, ...(name ? { name } : {}), text: scanner.text() });
  }
  return result;
}

function damaged() {
  return expect.objectContaining({ statusCode: 400, message: 'Could not read the .xlsx file (damaged XML in test.xml).' });
}

function scanAll(xml: string): void {
  const scanner = new XmlScanner(xml, 'test.xml');
  while (scanner.next()) {
    // drain
  }
}

describe('XmlScanner tokens', () => {
  it('reports start, end and empty tags with the text before each one', () => {
    expect(tokens('<a>x<b/>y</a>z')).toEqual([
      { kind: 'open', name: 'a', text: '' },
      { kind: 'empty', name: 'b', text: 'x' },
      { kind: 'close', name: 'a', text: 'y' },
    ]);
  });

  it('matches local names whatever the prefix, and only whole names', () => {
    expect(tokens('<x:row><rows/><x:c/></x:row>')).toEqual([
      { kind: 'open', name: 'row', text: '' },
      { kind: 'empty', text: '' },
      { kind: 'empty', name: 'c', text: '' },
      { kind: 'close', name: 'row', text: '' },
    ]);
  });

  it('skips the declaration, comments and processing instructions, and keeps CDATA apart', () => {
    const scanner = new XmlScanner('<?xml version="1.0"?><t>a<!-- <b> -->b<![CDATA[<c> & d]]>e</t>', 'test.xml');
    const seen: string[] = [];
    while (scanner.next()) {
      seen.push(`${scanner.kind}:${scanner.text()}${scanner.kind === 'cdata' ? `|${scanner.cdata()}` : ''}`);
    }

    expect(seen).toEqual(['other:', 'open:', 'other:a', 'cdata:b|<c> & d', 'close:e']);
  });

  it('keeps a ">" inside a quoted value within its tag', () => {
    const scanner = new XmlScanner('<numFmt formatCode="[>=100]0" id=\'a>b\'/><t/>', 'test.xml');

    expect(scanner.next()).toBe(true);
    expect(scanner.kind).toBe('empty');
    expect(scanner.attributes(['formatCode', 'id'])).toEqual(['[>=100]0', 'a>b']);
    expect(scanner.next() && scanner.is('t')).toBe(true);
  });

  it('reads only the range it was given', () => {
    const xml = '<a><t>um</t></a><t>dois</t>';
    const scanner = new XmlScanner(xml, 'test.xml', 3, xml.indexOf('</a>'));
    const names: string[] = [];
    while (scanner.next()) names.push(`${scanner.kind}`);

    expect(names).toEqual(['open', 'close']);
  });
});

describe('XmlScanner attributes', () => {
  function attributesOf(tag: string, wanted: string[]): Array<string | undefined> {
    const scanner = new XmlScanner(tag, 'test.xml');
    scanner.next();
    return scanner.attributes(wanted);
  }

  it('reads the wanted attributes in the order asked, decoding entities, undefined when absent', () => {
    expect(attributesOf('<c r="B2" s = \'3\' t="s" extra="1">', ['t', 'r', 'missing', 's'])).toEqual(['s', 'B2', undefined, '3']);
    expect(attributesOf('<sheet name="A &amp; B &#233;"/>', ['name'])).toEqual(['A & B é']);
  });

  it('matches "*:id" against any prefixed id, never the unprefixed one', () => {
    expect(attributesOf('<sheet id="plain" r:id="rId7"/>', ['*:id'])).toEqual(['rId7']);
    expect(attributesOf('<sheet x:id="rId9"/>', ['*:id'])).toEqual(['rId9']);
    expect(attributesOf('<sheet id="plain"/>', ['*:id'])).toEqual([undefined]);
  });

  it('keeps the first of two equal attribute names', () => {
    expect(attributesOf('<c r="A1" r="B2"/>', ['r'])).toEqual(['A1']);
  });

  it('rejects an attribute without a quoted value, and an over-long value it is asked for', () => {
    expect(() => attributesOf('<c r=A1>', ['r'])).toThrow(damaged());
    expect(() => attributesOf('<c r>', ['r'])).toThrow(damaged());
    expect(() => attributesOf(`<c r="${'A'.repeat(40_000)}"/>`, ['r'])).toThrow(damaged());
    // A long value nobody asks for costs nothing.
    expect(attributesOf(`<c note="${'A'.repeat(40_000)}" r="A1"/>`, ['r'])).toEqual(['A1']);
  });
});

describe('XmlScanner damaged parts', () => {
  it.each([
    ['an unterminated tag', '<a><b'],
    ['an unterminated quoted value', '<a b="1>'],
    ['a "<" inside a tag', '<a <b>'],
    ['a start tag without a name', '<>'],
    ['an end tag with attributes', '</a b="1">'],
    ['a name ending in a colon', '<a:>'],
    ['an unterminated comment', '<a><!-- x'],
    ['an unterminated CDATA section', '<a><![CDATA[x'],
    ['an unterminated processing instruction', '<?xml version="1.0"'],
    ['a DOCTYPE', '<!DOCTYPE a [<!ENTITY x "y">]><a/>'],
  ])('rejects %s', (_label, xml) => {
    expect(() => scanAll(xml)).toThrow(damaged());
  });

  it('stops at the first bad tag instead of searching the rest of the part', () => {
    const hostile = '<sheetData '.repeat(200_000);
    const started = performance.now();

    expect(() => scanAll(hostile)).toThrow(damaged());
    expect(performance.now() - started).toBeLessThan(200);
  });

  it('scans a large part in linear time', () => {
    const xml = `<sheetData>${'<row><c r="A1" t="s"><v>1</v></c></row>'.repeat(100_000)}</sheetData>`;
    const started = performance.now();
    scanAll(xml);

    expect(performance.now() - started).toBeLessThan(1000);
  });
});

describe('decodeEntities', () => {
  it('decodes the predefined entities and character references, and leaves anything else as written', () => {
    expect(decodeEntities('&lt;&gt;&amp;&quot;&apos; &#65;&#x42; &#x1F600;')).toBe('<>&"\' AB \u{1F600}');
    expect(decodeEntities('&nbsp; &#99999999; &amp')).toBe('&nbsp; &#99999999; &amp');
  });
});
