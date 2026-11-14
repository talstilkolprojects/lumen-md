/**
 * Hebrew spelling hints from a bundled word-frequency list (plan 9.2).
 *
 * The list is FrequencyWords `he_50k` (Hermit Dave, from OpenSubtitles 2018,
 * CC BY-SA 4.0): the 50 000 most frequent Hebrew words in subtitles, with
 * their counts. It ships with the app (public/dict/, fetched lazily by the
 * spelling worker, precached for offline use), so it works from install
 * with no network. It is built from subtitles and has typos and gaps of its
 * own, so what it finds is a **suggestion** (category HINT), never an error:
 *
 * - a word is "known" if it is in the list, as is or with its prefix letters
 *   (ו ה ב כ ל מ ש) peeled down to a stem of at least three letters;
 * - an unknown word is flagged only when a *frequent* word (count ≥
 *   SUGGEST_MIN_COUNT) is one edit away — that is the frequency threshold:
 *   rare names and inflections the list lacks have no such neighbour and
 *   stay unflagged.
 *
 * Hspell (AGPL-3.0) stays an optional, user-initiated download
 * (decision 15.10); when it is installed it does the spelling and this list
 * only backs the two rules below.
 */
import type { GrammarMatch } from "./grammar";
import { PREFIX, PREFIX_NEXT, stripMarks, suggest } from "./hebrewSpell";
import { HEBREW_MARK_CHARS as M } from "../text/hebrew";

/** Served from public/dict/ (see LICENSE.md there); the worker fetches it relative to the app. */
export const HEBREW_FREQ_PATH = "dict/he_50k.txt";
export const HEBREW_FREQ_LICENSE = "CC BY-SA 4.0 (FrequencyWords he_50k, Hermit Dave, from OpenSubtitles 2018)";
/** The attribution each hint carries (CC BY-SA 4.0 asks for it where the list is used). */
export const HEBREW_FREQ_CREDIT = "FrequencyWords של Hermit Dave, CC BY-SA 4.0";

/** A suggestion must be at least this frequent (tuned on the 7.1 dev split; see scripts/golden/evals/typos-he.mjs). */
export const SUGGEST_MIN_COUNT = 2000;
/** Prefix letters are peeled only down to a stem of this many letters (2-letter stems in subtitles are mostly noise). */
const MIN_STEM = 3;

export interface FrequencyList {
  counts: Map<string, number>;
  /** Every word in the list (the counts' keys), for `suggest`. */
  words: Set<string>;
}

/** Parse `word count` lines. */
export function parseFrequencyList(text: string): FrequencyList {
  const counts = new Map<string, number>();
  for (const line of text.split(/\r?\n/)) {
    const i = line.lastIndexOf(" ");
    if (i <= 0) continue;
    const n = Number(line.slice(i + 1));
    if (Number.isFinite(n)) counts.set(line.slice(0, i), n);
  }
  return { counts, words: new Set(counts.keys()) };
}

const count = (list: FrequencyList, w: string) => list.counts.get(w) ?? 0;

/**
 * Is the word in the list, as is or with valid prefix letters peeled (to a
 * stem of ≥ 3 letters)? An article on a word that already has one
 * ("ההיום", "בההסופה") is not peeled away.
 */
export function frequencyKnown(list: FrequencyList, raw: string): boolean {
  const word = stripMarks(raw);
  if (list.words.has(word)) return true;
  let rest = word;
  let prev: string | null = null;
  for (let i = 0; i < 3 && rest.length > MIN_STEM && PREFIX.has(rest[0]) && (prev === null || PREFIX_NEXT[prev].includes(rest[0])); i++) {
    prev = rest[0];
    rest = rest.slice(1);
    // An article (or ב/כ/ל, which swallow it) before a word that already has one: "ההיום", "בהבית".
    if ("הבכל".includes(prev) && rest[0] === "ה" && rest.length > 3 && list.words.has(rest.slice(1))) return false;
    if (list.words.has(rest) || (rest.startsWith("ו") && list.words.has(rest.slice(1))) || list.words.has("ו" + rest)) return true;
  }
  return false;
}

/**
 * Frequent words one edit away, by edit cost and then by frequency. Every
 * one-edit neighbour is considered before the threshold cuts (a rare
 * neighbour must not crowd out a frequent one: "יודן" → "יודע").
 */
export function frequencySuggestions(list: FrequencyList, raw: string, max = 5): string[] {
  const ranked = suggest(list.words, raw, Number.POSITIVE_INFINITY);
  return ranked
    .map((w, rank) => ({ w, rank, n: count(list, w) }))
    .filter((x) => x.n >= SUGGEST_MIN_COUNT)
    .sort((a, b) => a.rank - b.rank || b.n - a.n)
    .slice(0, max)
    .map((x) => x.w);
}

const HEB_WORD = new RegExp(`[א-ת${M}]+(?:["״'׳][א-ת]+)?`, "g");

/** Spelling hints against the frequency list. Offsets are into `text`. */
export function frequencySpelling(list: FrequencyList, text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(HEB_WORD)) {
    const w = m[0];
    if ([...stripMarks(w)].length < 2 || /["״'׳]/.test(w)) continue; // acronyms and abbreviations
    if (frequencyKnown(list, w)) continue;
    const replacements = frequencySuggestions(list, w);
    if (!replacements.length) continue; // no frequent neighbour: probably a name or a rare form
    out.push({ offset: m.index!, length: w.length, message: `אולי שגיאת כתיב (הצעה מרשימת המילים ${HEBREW_FREQ_CREDIT})`, replacements, rule: { id: "HE_SPELLING_HINT", category: "HINT" } });
  }
  return out;
}

/* ─── Rules that need the list's counts ─────────────────────────────── */

/** Words after "את" that make the object definite (or are not a noun). */
const ET_OK = new Set(
  "זה זו זאת זהו אלה אלו כל כולם כולן כולו כולה מה מי עצמו עצמה עצמי עצמך עצמם עצמן עצמנו עצמכם אחד אחת שני שתי שלושת ארבעת חמשת ששת שבעת שמונת תשעת עשרת שניהם שתיהן שנינו אותו אותה אותם אותן ההוא ההיא אשר".split(" "),
);
/** Pronoun "את" (you, f.) is followed by these as often as not. */
const ET_PRONOUN_NEXT = new Set("לא יודעת רוצה צריכה חושבת יכולה בסדר כאן פה עדיין באמת גם רק תמיד אף".split(" "));

/**
 * The two rules T28 listed that the first round lacked (plan 9.2.2):
 *
 * - HE_ARTICLE_AFTER_PREPOSITION — after ב / כ / ל the article ה is
 *   swallowed: "בהבית" → "בבית". Flagged when the word is not in the list
 *   but the form without the ה is, frequently.
 * - HE_ET_INDEFINITE — "את" marks a *definite* object: "ראיתי את ילד" →
 *   "את הילד" (or no "את"). Flagged only when the next word is a common
 *   noun whose definite form is frequent, is not itself definite or in a
 *   construct ("את ספר הילד"), and "את" is not the pronoun "you".
 */
export function frequencyRules(list: FrequencyList, text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(HEB_WORD)) {
    const w = stripMarks(m[0]);
    const pre = /^[וש]?[בכל]ה/.exec(w);
    if (!pre || w.length < 5 || list.words.has(w)) continue;
    const fixed = w.slice(0, pre[0].length - 1) + w.slice(pre[0].length);
    const stem = w.slice(pre[0].length);
    if (count(list, "ה" + stem) >= SUGGEST_MIN_COUNT && frequencyKnown(list, fixed)) {
      out.push({ offset: m.index!, length: m[0].length, message: "אחרי ב/כ/ל ה׳ הידיעה נבלעת", replacements: [fixed], rule: { id: "HE_ARTICLE_AFTER_PREPOSITION", category: "GRAMMAR" } });
    }
  }
  const tokens = [...text.matchAll(HEB_WORD)];
  for (let i = 0; i < tokens.length - 1; i++) {
    if (stripMarks(tokens[i][0]) !== "את") continue;
    const next = stripMarks(tokens[i + 1][0]);
    const between = text.slice(tokens[i].index! + tokens[i][0].length, tokens[i + 1].index!);
    if (!/^ +$/.test(between)) continue; // "את" before punctuation, a number or a name in quotes
    if (next.startsWith("ה") || ET_OK.has(next) || ET_PRONOUN_NEXT.has(next)) continue;
    // Sentence-initial "את" is mostly the pronoun ("את יודעת…").
    const before = text.slice(0, tokens[i].index!).trimEnd();
    if (!before || /[.!?:;\n"״„“]$/.test(before)) continue;
    // Construct state: "את ספר הילד", "את בית הספר".
    const after = tokens[i + 2];
    if (after && stripMarks(after[0]).startsWith("ה") && /^ +$/.test(text.slice(tokens[i + 1].index! + tokens[i + 1][0].length, after.index!))) continue;
    if (count(list, next) < SUGGEST_MIN_COUNT || count(list, "ה" + next) < SUGGEST_MIN_COUNT) continue;
    const at = tokens[i].index!;
    const end = tokens[i + 1].index! + tokens[i + 1][0].length;
    out.push({ offset: at, length: end - at, message: "״את״ באה לפני מושא מיודע", replacements: [`את ה${next}`, next], rule: { id: "HE_ET_INDEFINITE", category: "GRAMMAR" } });
  }
  return out;
}

/** A single prefix letter cut off from its word ("ב זכות" → "בזכות"). Needs no list. */
export function lonePrefixRule(text: string): GrammarMatch[] {
  const out: GrammarMatch[] = [];
  for (const m of text.matchAll(/(?<![\p{L}\p{M}'"׳״\-־])([בכלמשהו]) ([א-ת]{2,})/gu)) {
    out.push({ offset: m.index!, length: m[0].length, message: "אות שימוש מנותקת מהמילה", replacements: [m[1] + m[2]], rule: { id: "HE_DETACHED_PREFIX", category: "TYPOS" } });
  }
  return out;
}

/**
 * Everything the offline Hebrew checker finds without Hspell: the
 * dictionary-free rules, the detached prefix letter, and — with the list —
 * its two rules and its spelling hints. Sorted by offset.
 */
export function offlineHebrewChecks(
  list: FrequencyList | null,
  text: string,
  rules: (text: string) => GrammarMatch[],
  /** Hspell's spelling, when the user installed it: replaces the list's hints. */
  spelling?: (text: string) => GrammarMatch[],
): GrammarMatch[] {
  const out = [...rules(text), ...lonePrefixRule(text)];
  if (list) out.push(...frequencyRules(list, text));
  // One finding per word: a rule's specific message wins over a spelling finding.
  const taken = (m: GrammarMatch) => out.some((o) => o.offset < m.offset + m.length && m.offset < o.offset + o.length);
  const spelled = spelling ? spelling(text) : list ? frequencySpelling(list, text) : [];
  for (const m of spelled) if (!taken(m)) out.push(m);
  return out.sort((a, b) => a.offset - b.offset);
}
