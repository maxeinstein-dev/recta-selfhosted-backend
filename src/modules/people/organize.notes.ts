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
 * - "*Dividir" / "*Reembolsar" without a name are not read as a person called "Dividir";
 * - what follows the star is only a person when it looks like one: a group ("todo mundo", "galera"), several
 *   people ("Ana e Bia", "Ana, Bia") or a phrase that is not a name ("Parcela 3/10", "Pagar a conta de luz") goes
 *   to review as free text, with the reason, never to a new person.
 */
export type NoteClass =
  | { kind: 'hint'; hint: Exclude<ShareHint, { kind: 'reimbursable' }>; person: string; segment: string }
  | { kind: 'reimbursable'; segment: string }
  /** `reason` is set when the note had the shape of a share but not a usable person. */
  | { kind: 'free'; text: string; reason?: string }
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

/** Collective words (accent-free lower case, whole words). */
const COLLECTIVES = ['todo mundo', 'todos', 'todas', 'galera', 'turma'];
/** First words of phrases that name a bill or an item, not a person. */
const NON_PERSON_FIRST_WORDS = [
  'parcela', 'parcelas', 'conta', 'contas', 'fatura', 'boleto', 'mensalidade', 'aluguel', 'condominio',
  'cartao', 'luz', 'agua', 'internet', 'imposto', 'taxa', 'compra', 'pedido',
];
/** More words than any real name, however long. */
const MAX_NAME_WORDS = 4;

function wordsOf(text: string): string[] {
  return labelKey(text).split(/[^\p{L}\p{N}]+/u).filter(Boolean);
}

/** Why a text after the star cannot be a single person, or null when it can. */
function notAPerson(person: string): string | null {
  const words = wordsOf(person);
  const padded = ` ${words.join(' ')} `;
  if (COLLECTIVES.some((word) => padded.includes(` ${word} `))) {
    return `"${person}" parece um grupo, não uma pessoa: escolha as pessoas à mão`;
  }
  if (/\d/.test(person) || NON_PERSON_FIRST_WORDS.includes(words[0] ?? '')) {
    return `"${person}" não parece o nome de uma pessoa`;
  }
  if (padded.includes(' e ') || /[,&+/]/.test(person)) {
    return `"${person}" cita mais de uma pessoa: escolha as pessoas à mão`;
  }
  if (words.length > MAX_NAME_WORDS) {
    return `"${person}" não parece o nome de uma pessoa`;
  }
  return null;
}

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
    const why = notAPerson(person);
    if (why) return { kind: 'free', text, reason: why };
    return { kind: 'hint', hint, person, segment: raw.trim() };
  }
  return { kind: 'free', text };
}

export interface FreeTextReading {
  /** Keys (normalized names/aliases) of known people the text mentions as whole words, in order of appearance. */
  mentionedKeys: string[];
  /** The first sharing word found, spelled for display. */
  sharingWord: string | null;
}

export interface FreeTextMatcher {
  read(text: string): FreeTextReading;
}

/** Longest name, in words, the matcher looks for (a key with more words is matched by its first ones' prefix never). */
const MAX_KEY_WORDS = 8;

/**
 * Prepares the known names/aliases once, so reading a note costs its own length (a lookup of its word n-grams), not
 * the number of people. Matching is by whole words, ignoring case, accents and punctuation.
 */
export function buildFreeTextMatcher(knownKeys: Iterable<string>): FreeTextMatcher {
  const byWords = new Map<string, string[]>();
  let longest = 1;
  for (const key of knownKeys) {
    const words = wordsOf(key);
    if (words.length === 0 || words.length > MAX_KEY_WORDS) continue;
    longest = Math.max(longest, words.length);
    const joined = words.join(' ');
    const list = byWords.get(joined);
    if (list) list.push(key);
    else byWords.set(joined, [key]);
  }

  return {
    read(text: string): FreeTextReading {
      const words = wordsOf(text);
      const mentioned: string[] = [];
      const seen = new Set<string>();
      for (let i = 0; i < words.length; i++) {
        for (let n = 1; n <= longest && i + n <= words.length; n++) {
          const keys = byWords.get(words.slice(i, i + n).join(' '));
          if (!keys) continue;
          for (const key of keys) {
            if (!seen.has(key)) {
              seen.add(key);
              mentioned.push(key);
            }
          }
        }
      }
      const haystack = words.join(' ');
      const sharingWord = SHARING_WORDS.find((word) => haystack.includes(word.match))?.display ?? null;
      return { mentionedKeys: mentioned, sharingWord };
    },
  };
}

/** What a free-text note mentions: known people (by name or alias) and words that talk about sharing. */
export function readFreeText(text: string, knownKeys: Iterable<string>): FreeTextReading {
  return buildFreeTextMatcher(knownKeys).read(text);
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
