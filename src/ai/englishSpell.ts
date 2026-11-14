/**
 * English spelling on this device (plan 6.10): Hunspell's en-US word list
 * (dictionary-en 4.0 — SCOWL, MIT AND BSD) through nspell (MIT), in a
 * worker. This module is the pure part: which words of a Markdown note are
 * prose, and how an unknown one becomes a match. The worker and the
 * routing live in englishSpellService.ts.
 *
 * Not checked: code (fenced, indented, inline), front matter, URLs and
 * e-mail addresses, link destinations, wiki links, HTML tags, footnote
 * labels, #tags, words with digits or underscores, ALL-CAPS acronyms and
 * camelCase identifiers. A note full of code would otherwise be all red.
 */
import type { GrammarMatch } from "./grammar";

export const EN_SPELL_RULE = "EN_SPELL";
/** The worker sends this key; the service turns it into the UI string. */
export const EN_SPELL_MESSAGE_KEY = "spell.en.unknown";

/** What nspell gives us (and what a test double must provide). */
export interface SpellChecker {
  correct(word: string): boolean;
  suggest(word: string): string[];
}

export interface WordToken {
  word: string;
  /** UTF-16 offset of the first letter in the input. */
  offset: number;
}

/** Spans that are never prose, in the order they are blanked. */
const MASKS: RegExp[] = [
  /^---\r?\n[\s\S]*?\r?\n(?:---|\.\.\.)[ \t]*(?:\r?\n|$)/, // front matter (start of note only)
  /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?(?:\n {0,3}\2[`~]*[ \t]*(?=\n|$)|$)/gm, // fenced code
  /^(?: {4}|\t)(?![ \t]*(?:[-*+]|\d+[.)])\s)[^\n]*/gm, // indented code (not a nested list item)
  /(`+)[^`\n]*?\1/g, // inline code
  /<[A-Za-z/!][^>\n]*>/g, // HTML tags and comments on one line
  /\[\[[^\]\n]*\]\]/g, // wiki links
  /\]\([^)\n]*\)/g, // link destinations
  /^\s{0,3}\[[^\]\n]+\]:[^\n]*$/gm, // link reference definitions
  /\[\^[^\]\n]*\]/g, // footnote labels
  /\b(?:[a-z][a-z0-9+.-]*:\/\/|www\.)[^\s<>()]+/gi, // URLs
  /[\w.+-]+@[\w-]+(?:\.[\w-]+)+/g, // e-mail addresses
  /(^|\s)#[\p{L}\p{N}_/-]+/gu, // #tags
  /&#?[A-Za-z0-9]+;/g, // HTML entities
  /:[a-z0-9_+-]+:/g, // emoji shortcodes
];

/** The text with every non-prose span replaced by spaces (same length, same offsets). */
export function maskNonProse(text: string): string {
  let out = text;
  for (const re of MASKS) out = out.replace(re, (m) => m.replace(/[^\n]/g, " "));
  return out;
}

// A run of letters, digits, underscores and inner apostrophes / hyphens.
const RUN = /[\p{L}\p{N}_]+(?:['’][\p{L}]+)*/gu;

/** Should this run be looked up at all? */
export function isCheckable(word: string): boolean {
  if (!/^[A-Za-z]+(?:['’][A-Za-z]+)*$/.test(word)) return false; // digits, _, non-Latin letters
  if (word.length < 2) return false;
  if (word.length > 1 && word === word.toUpperCase()) return false; // NASA, HTTP
  if (/[a-z][A-Z]/.test(word)) return false; // camelCase, iPhone
  return true;
}

/** The prose words of a Markdown text, with their offsets. */
export function spellWords(text: string): WordToken[] {
  const masked = maskNonProse(text);
  const out: WordToken[] = [];
  for (const m of masked.matchAll(RUN)) {
    if (isCheckable(m[0])) out.push({ word: m[0], offset: m.index! });
  }
  return out;
}

/** Possessive and contraction forms the word list leaves out: "whale's", "whales'". */
function lookupForms(word: string): string[] {
  const forms = [word];
  const poss = /^(.+?)['’]s$/i.exec(word);
  if (poss) forms.push(poss[1]);
  return forms;
}

export function isKnownWord(spell: SpellChecker, word: string): boolean {
  for (const form of lookupForms(word)) {
    if (spell.correct(form)) return true;
    const plain = form.replace(/’/g, "'");
    if (plain !== form && spell.correct(plain)) return true;
    // Sentence-initial capital on a lower-case entry ("Teh" is still wrong).
    if (/^[A-Z][a-z']+$/.test(plain) && spell.correct(plain.toLowerCase())) return true;
  }
  return false;
}

export interface SpellOptions {
  /** Words the user added; matched case-insensitively. */
  personal?: ReadonlySet<string>;
  /** Suggestions are slow (≈ 40 ms a word): only the first this many unknown words get them. */
  maxSuggest?: number;
  /** Shared across calls so a word typed wrong twice is suggested once. */
  suggestCache?: Map<string, string[]>;
}

/** Unknown words as LanguageTool-shaped matches (message = i18n key). */
export function englishSpelling(spell: SpellChecker, text: string, opts: SpellOptions = {}): GrammarMatch[] {
  const maxSuggest = opts.maxSuggest ?? 25;
  const cache = opts.suggestCache ?? new Map<string, string[]>();
  const out: GrammarMatch[] = [];
  let suggested = 0;
  for (const tok of spellWords(text)) {
    if (opts.personal?.has(tok.word.toLowerCase())) continue;
    if (isKnownWord(spell, tok.word)) continue;
    let replacements = cache.get(tok.word);
    if (!replacements && suggested < maxSuggest) {
      suggested++;
      replacements = spell.suggest(tok.word).slice(0, 5);
      cache.set(tok.word, replacements);
    }
    out.push({
      offset: tok.offset,
      length: tok.word.length,
      message: EN_SPELL_MESSAGE_KEY,
      replacements: replacements ?? [],
      rule: { id: EN_SPELL_RULE, category: "TYPOS" },
    });
  }
  return out;
}
