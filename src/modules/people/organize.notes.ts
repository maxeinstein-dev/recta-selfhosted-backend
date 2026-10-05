import { parseShareHint } from '../transactions/parsers/maxfin.parser.js';
import type { ShareHint } from '../transactions/parsers/maxfin.types.js';
import { cleanPersonName, labelKey } from './people.common.js';

/**
 * What a transaction note says about sharing. The vocabulary is the MaxFin sheet's, read by the importer's own
 * parser (`parseShareHint`); this adds only what the stored text needs on top of it:
 *
 * - the importer joins the raw note with generated remarks by " · ", so each segment is tried;
 * - the common typo "Divivir" is read as "Dividir";
 * - a leading "*" inside a name ("*Dividir com *Ana") is not part of the name;
 * - "*Dividir" / "*Reembolsar" without a name are not read as a person called "Dividir".
 */
export type NoteClass =
  | { kind: 'hint'; hint: Exclude<ShareHint, { kind: 'reimbursable' }>; person: string; segment: string }
  | { kind: 'reimbursable'; segment: string }
  | { kind: 'free'; text: string }
  | { kind: 'none' };

const SEGMENT_SEPARATOR = ' · ';
/** Words that mean "this was shared" in free text; matched on accent-free lower case, as substrings. */
const SHARING_WORDS = [
  { match: 'dividid', display: 'dividido' },
  { match: 'dividir', display: 'dividir' },
  { match: 'divivir', display: 'divivir' },
  { match: 'reembols', display: 'reembolso' },
  { match: 'pagar', display: 'pagar' },
] as const;
/** After the leading "*", a name that is really a sharing word means the note has no person. */
const NOT_A_NAME = /^(dividir|divivir|dividido|dividida|reembols\w*|pagar)\b/;

function fixTypos(segment: string): string {
  return segment.replace(/^(\*\s*)divivir\b/i, '$1Dividir');
}

export function classifyNote(note: string | null | undefined): NoteClass {
  const text = (note ?? '').trim();
  if (text === '') return { kind: 'none' };

  for (const raw of text.split(SEGMENT_SEPARATOR)) {
    const segment = fixTypos(raw.trim());
    const hint = parseShareHint(segment);
    if (!hint) continue;
    if (hint.kind === 'reimbursable') return { kind: 'reimbursable', segment: raw.trim() };
    const person = cleanPersonName(hint.person);
    if (person === '' || NOT_A_NAME.test(labelKey(person))) {
      // "*Dividir" alone: it asks to split, but says with whom nowhere: a person has to be picked by hand.
      return { kind: 'free', text };
    }
    return { kind: 'hint', hint, person, segment: raw.trim() };
  }
  return { kind: 'free', text };
}

/** Lower case, no accents, every run of non-alphanumerics as one space, padded so whole words can be searched. */
function paddedWords(text: string): string {
  return ` ${labelKey(text).replace(/[^a-z0-9]+/g, ' ').trim()} `;
}

export interface FreeTextReading {
  /** Keys (normalized names/aliases) of known people the text mentions as whole words. */
  mentionedKeys: string[];
  /** The first sharing word found, spelled for display. */
  sharingWord: string | null;
}

/** What a free-text note mentions: known people (by name or alias) and words that talk about sharing. */
export function readFreeText(text: string, knownKeys: Iterable<string>): FreeTextReading {
  const padded = paddedWords(text);
  const mentionedKeys: string[] = [];
  for (const key of knownKeys) {
    const words = paddedWords(key);
    if (words.trim() !== '' && padded.includes(words)) mentionedKeys.push(key);
  }
  const sharingWord = SHARING_WORDS.find((word) => padded.includes(word.match))?.display ?? null;
  return { mentionedKeys, sharingWord };
}

/**
 * "Reembolso - Ana" (also with an en dash or a colon): the name after the separator, as written; null otherwise.
 */
export function reimbursementName(description: string): string | null {
  const match = /^\s*reembolso\s*[-–—:]\s*(.+?)\s*$/i.exec(description);
  if (!match?.[1]) return null;
  const name = cleanPersonName(match[1]);
  return name === '' ? null : name;
}
