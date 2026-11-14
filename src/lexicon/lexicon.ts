/**
 * The offline Hebrew lexicon (plan W5.26): definitions, synonyms and the
 * pointed form of a word, from a pack built from Hebrew Wiktionary
 * (scripts/build-hebrew-lexicon.mjs, CC BY-SA 4.0). Pure: the index and the
 * lookup; downloading and storing the pack is ./store.ts.
 *
 * A lookup takes the word as written in a note — with or without niqqud,
 * with prefix letters (ו ה ב כ ל מ ש: "ובבית", "כשהלכתי") — and finds the
 * headword. Synonyms are symmetric: when A lists B, B's entry shows A too.
 */
import { PREFIX, PREFIX_NEXT, stripMarks } from "../ai/hebrewSpell";

/** [word, pointed, part of speech, definitions, synonyms] */
export type PackEntry = [string, string, string, string[], string[]];

export interface LexiconPack {
  format: "lumen-lexicon/1";
  source: string;
  built: string;
  license: string;
  attribution: string;
  count: number;
  words: number;
  entries: PackEntry[];
}

export interface Sense {
  word: string;
  pointed: string;
  pos: string;
  defs: string[];
}

export interface LookupResult {
  /** The headword found (the input without its prefix letters, when they were peeled). */
  word: string;
  /** The prefix letters peeled off the input ("וב" for "ובבית"). */
  prefix: string;
  senses: Sense[];
  /** Listed and reverse synonyms, without duplicates, in listed order first. */
  synonyms: string[];
}

export interface LexiconIndex {
  senses: Map<string, Sense[]>;
  synonyms: Map<string, string[]>;
  count: number;
  attribution: string;
}

/** Validate a downloaded pack's shape (the bytes are checked against the manifest first). */
export function isPack(v: unknown): v is LexiconPack {
  const p = v as Partial<LexiconPack> | null;
  return !!p && p.format === "lumen-lexicon/1" && Array.isArray(p.entries) && typeof p.attribution === "string";
}

const key = (w: string) => stripMarks(w).replace(/־/g, "-").trim();

export function buildIndex(pack: LexiconPack): LexiconIndex {
  const senses = new Map<string, Sense[]>();
  const syn = new Map<string, Set<string>>();
  const addSyn = (a: string, b: string) => {
    if (a === b) return;
    let s = syn.get(a);
    if (!s) syn.set(a, (s = new Set()));
    s.add(b);
  };
  for (const [word, pointed, pos, defs, syns] of pack.entries) {
    const k = key(word);
    let list = senses.get(k);
    if (!list) senses.set(k, (list = []));
    list.push({ word, pointed, pos, defs });
    for (const s of syns) {
      addSyn(k, key(s));
      addSyn(key(s), k);
    }
  }
  return { senses, synonyms: new Map([...syn].map(([k, v]) => [k, [...v]])), count: pack.count, attribution: pack.attribution };
}

/** The headwords a written word may be: as is, then with up to three valid prefix letters peeled. */
export function candidates(raw: string): Array<{ word: string; prefix: string }> {
  const word = key(raw).replace(/^["'׳״]+|["'׳״]+$/g, "");
  const out = [{ word, prefix: "" }];
  let rest = word;
  let prev: string | null = null;
  for (let i = 0; i < 3 && rest.length > 2 && PREFIX.has(rest[0]) && (prev === null || PREFIX_NEXT[prev].includes(rest[0])); i++) {
    prev = rest[0];
    rest = rest.slice(1);
    const prefix = word.slice(0, word.length - rest.length);
    out.push({ word: rest, prefix });
    // Full spelling doubles a ו after a prefix ("הוורד" for ה+ורד).
    if (rest.startsWith("וו")) out.push({ word: rest.slice(1), prefix });
  }
  return out;
}

/** Look a word up: the first candidate that is a headword, or that has synonyms. Null when none is. */
export function lookup(index: LexiconIndex, raw: string): LookupResult | null {
  for (const c of candidates(raw)) {
    const senses = index.senses.get(c.word);
    const synonyms = index.synonyms.get(c.word);
    if (senses || synonyms) return { word: c.word, prefix: c.prefix, senses: senses ?? [], synonyms: synonyms ?? [] };
  }
  return null;
}

/** A synonym written with the prefix the original word had: "ובבית" → "ובדירה". */
export function withPrefix(prefix: string, word: string): string {
  return prefix + word;
}
