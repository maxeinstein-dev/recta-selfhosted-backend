/**
 * Forward-only scanner over the markup of one XML part of a workbook (no DOM, no backtracking regex).
 *
 * Each call to next() moves to the next tag, comment, processing instruction or CDATA section. It never looks back
 * and never searches for a matching closing tag, so any part is scanned in linear time with no allocation per tag:
 * the caller keeps whatever nesting state it needs. Anything the scanner cannot finish (a tag, a quoted value, a
 * comment) and anything no workbook part holds (a '<' inside a tag, a DOCTYPE) makes the part damaged: the caller
 * gets a 400 at that point instead of a search through the rest of the part.
 */
import { BadRequestError } from '../errors/app-error.js';

export type XmlTokenKind = 'open' | 'close' | 'empty' | 'cdata' | 'other';

/** Longest attribute value read; none of the attributes a reader asks for (references, ids, names, format codes) comes close. */
const MAX_ATTRIBUTE_VALUE = 32_767;

const LESS_THAN = 60;
const GREATER_THAN = 62;
const SLASH = 47;
const EQUALS = 61;
const COLON = 58;
const DOUBLE_QUOTE = 34;
const SINGLE_QUOTE = 39;
const EXCLAMATION = 33;
const QUESTION = 63;

/** The part is not well-formed enough to be read (truncated, or holding what no workbook part holds). */
export function damagedPart(part: string): BadRequestError {
  return new BadRequestError(`Could not read the .xlsx file (damaged XML in ${part}).`);
}

function isSpace(code: number): boolean {
  return code === 32 || code === 9 || code === 10 || code === 13;
}

const NAMED_ENTITIES: Record<string, string> = { lt: '<', gt: '>', amp: '&', quot: '"', apos: "'" };
/** Linear: each attempt starts at an "&" and only walks the digits that follow it. */
const ENTITY = /&(?:#(\d+)|#[xX]([0-9A-Fa-f]+)|(lt|gt|amp|quot|apos));/g;

/** The five predefined entities and numeric character references; anything else is left as written. */
export function decodeEntities(text: string): string {
  if (!text.includes('&')) return text;
  return text.replace(ENTITY, (whole, decimal?: string, hex?: string, name?: string) => {
    if (name) return NAMED_ENTITIES[name] ?? whole;
    const code = decimal !== undefined ? Number.parseInt(decimal, 10) : Number.parseInt(hex ?? '', 16);
    return Number.isInteger(code) && code <= 0x10ffff ? String.fromCodePoint(code) : whole;
  });
}

export class XmlScanner {
  /** Kind of the current token; null before the first one and after the last one. */
  kind: XmlTokenKind | null = null;
  /** Index of the current token's '<' (the end of the scanned range once next() returned false). */
  start: number;
  /** Index right after the current token's '>'. */
  end: number;
  /** Where the text before the current token starts (right after the previous token). */
  textStart: number;
  private localStart = 0;
  private nameEnd = 0;
  private attributesEnd = 0;
  private contentStart = 0;
  private contentEnd = 0;

  constructor(
    readonly xml: string,
    /** Part name, for error messages. */
    readonly part: string,
    from = 0,
    readonly limit = xml.length,
  ) {
    this.start = from;
    this.end = from;
    this.textStart = from;
  }

  /** Moves to the next token; false at the end of the range. */
  next(): boolean {
    const { xml, limit } = this;
    this.textStart = this.end;
    const open = xml.indexOf('<', this.end);
    if (open < 0 || open >= limit) {
      this.kind = null;
      this.start = limit;
      return false;
    }
    this.start = open;
    const first = xml.charCodeAt(open + 1);
    if (first === EXCLAMATION) return this.declaration(open);
    if (first === QUESTION) return this.skipTo('?>', open + 2);

    const closing = first === SLASH;
    let i = closing ? open + 2 : open + 1;
    const nameStart = i;
    let localStart = i;
    for (; i < limit; i++) {
      const code = xml.charCodeAt(i);
      if (code === GREATER_THAN || code === SLASH || isSpace(code)) break;
      if (code === LESS_THAN || code === DOUBLE_QUOTE || code === SINGLE_QUOTE || code === EQUALS) {
        throw damagedPart(this.part);
      }
      if (code === COLON) localStart = i + 1;
    }
    if (i >= limit || i === nameStart || localStart === i) throw damagedPart(this.part);
    this.localStart = localStart;
    this.nameEnd = i;

    if (closing) {
      while (i < limit && isSpace(xml.charCodeAt(i))) i++;
      if (i >= limit || xml.charCodeAt(i) !== GREATER_THAN) throw damagedPart(this.part);
      this.kind = 'close';
      this.attributesEnd = i;
      this.end = i + 1;
      return true;
    }

    for (; i < limit; i++) {
      const code = xml.charCodeAt(i);
      if (code === GREATER_THAN) {
        const empty = xml.charCodeAt(i - 1) === SLASH;
        this.kind = empty ? 'empty' : 'open';
        this.attributesEnd = empty ? i - 1 : i;
        this.end = i + 1;
        return true;
      }
      if (code === DOUBLE_QUOTE || code === SINGLE_QUOTE) {
        const close = xml.indexOf(code === DOUBLE_QUOTE ? '"' : "'", i + 1);
        if (close < 0 || close >= limit) throw damagedPart(this.part);
        i = close;
      } else if (code === LESS_THAN) {
        throw damagedPart(this.part);
      }
    }
    throw damagedPart(this.part);
  }

  /** True when the current token is a tag (start, end or empty) with this local name (any prefix). */
  is(localName: string): boolean {
    const kind = this.kind;
    return (
      (kind === 'open' || kind === 'close' || kind === 'empty') &&
      this.nameEnd - this.localStart === localName.length &&
      this.xml.startsWith(localName, this.localStart)
    );
  }

  /** Raw text between the previous token and the current one (or the end of the range). */
  text(): string {
    return this.xml.slice(this.textStart, this.start);
  }

  /** Content of the current CDATA section, as written. */
  cdata(): string {
    return this.xml.slice(this.contentStart, this.contentEnd);
  }

  /**
   * Values of the wanted attributes of the current start tag, entities decoded, in the order asked (undefined when
   * absent; the first occurrence wins). "*:id" matches any prefixed attribute whose local name is "id" (r:id).
   */
  attributes(wanted: readonly string[]): Array<string | undefined> {
    const { xml } = this;
    const values = new Array<string | undefined>(wanted.length);
    const end = this.attributesEnd;
    let i = this.nameEnd;
    while (i < end) {
      if (isSpace(xml.charCodeAt(i))) {
        i++;
        continue;
      }
      const nameStart = i;
      let colon = -1;
      for (; i < end; i++) {
        const code = xml.charCodeAt(i);
        if (code === EQUALS || isSpace(code)) break;
        if (code === COLON) colon = i;
      }
      const nameEnd = i;
      while (i < end && isSpace(xml.charCodeAt(i))) i++;
      if (i >= end || xml.charCodeAt(i) !== EQUALS) throw damagedPart(this.part);
      i++;
      while (i < end && isSpace(xml.charCodeAt(i))) i++;
      const quote = xml.charCodeAt(i);
      if (i >= end || (quote !== DOUBLE_QUOTE && quote !== SINGLE_QUOTE)) throw damagedPart(this.part);
      const valueStart = i + 1;
      const valueEnd = xml.indexOf(quote === DOUBLE_QUOTE ? '"' : "'", valueStart);
      if (valueEnd < 0 || valueEnd >= end) throw damagedPart(this.part);
      i = valueEnd + 1;

      for (let w = 0; w < wanted.length; w++) {
        if (values[w] !== undefined || !nameMatches(xml, nameStart, nameEnd, colon, wanted[w]!)) continue;
        if (valueEnd - valueStart > MAX_ATTRIBUTE_VALUE) throw damagedPart(this.part);
        values[w] = decodeEntities(xml.slice(valueStart, valueEnd));
      }
    }
    return values;
  }

  private declaration(open: number): boolean {
    const { xml } = this;
    if (xml.startsWith('!--', open + 1)) return this.skipTo('-->', open + 4);
    if (xml.startsWith('![CDATA[', open + 1)) {
      const close = xml.indexOf(']]>', open + 9);
      if (close < 0 || close + 3 > this.limit) throw damagedPart(this.part);
      this.kind = 'cdata';
      this.contentStart = open + 9;
      this.contentEnd = close;
      this.end = close + 3;
      return true;
    }
    // DOCTYPE and other declarations: no workbook part has them.
    throw damagedPart(this.part);
  }

  private skipTo(terminator: string, from: number): boolean {
    const close = this.xml.indexOf(terminator, from);
    if (close < 0 || close + terminator.length > this.limit) throw damagedPart(this.part);
    this.kind = 'other';
    this.end = close + terminator.length;
    return true;
  }
}

function nameMatches(xml: string, start: number, end: number, colon: number, wanted: string): boolean {
  if (wanted.startsWith('*:')) {
    const length = wanted.length - 2;
    if (colon < 0 || end - (colon + 1) !== length) return false;
    for (let k = 0; k < length; k++) {
      if (xml.charCodeAt(colon + 1 + k) !== wanted.charCodeAt(2 + k)) return false;
    }
    return true;
  }
  return end - start === wanted.length && xml.startsWith(wanted, start);
}
