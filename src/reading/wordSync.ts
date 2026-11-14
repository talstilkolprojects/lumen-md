/**
 * Word-by-word highlight for read-aloud (plan W5.6). The Web Speech API
 * reports a `boundary` event with a `charIndex` into the text it speaks.
 * That text is the sentence with its Markdown removed (src/ai/tts.ts,
 * speakableSentences), so an index into it is not an offset in the note.
 * This maps each spoken word back to its range in the note's source, in
 * order, so the editor can mark the word being read.
 *
 * Pure: no DOM, no speech engine.
 */

export interface SpokenWord {
  /** Offsets in the spoken text. */
  start: number;
  end: number;
  /** Offsets in the note's source. */
  from: number;
  to: number;
}

/**
 * A word: letters, digits and combining marks (niqqud and cantillation are
 * marks), with inner apostrophes, geresh / gershayim and hyphens / maqaf
 * kept inside it (צ'יפס, צה"ל, בית־ספר, don't).
 */
const WORD = /[\p{L}\p{N}\p{M}]+(?:['"׳״\-־’][\p{L}\p{N}\p{M}]+)*/gu;

/** The words of `text` with their offsets. */
export function wordsOf(text: string): Array<{ word: string; start: number; end: number }> {
  return [...text.matchAll(WORD)].map((m) => ({ word: m[0], start: m.index!, end: m.index! + m[0].length }));
}

/**
 * Each word of `spoken` with its range in `source`, where `source` is the
 * Markdown the sentence came from and `base` its offset in the note. Words
 * are found in order; one the source does not contain as is (it should not
 * happen — the spoken text is the source with syntax removed) is skipped,
 * and the search goes on from where the last word was found.
 */
export function mapSpokenWords(spoken: string, source: string, base = 0): SpokenWord[] {
  const out: SpokenWord[] = [];
  let cursor = 0;
  for (const w of wordsOf(spoken)) {
    const found = findWord(source, w.word, cursor);
    if (!found) continue;
    out.push({ start: w.start, end: w.end, from: base + found[0], to: base + found[1] });
    cursor = found[1];
  }
  return out;
}

/** Inline Markdown that can sit inside a spoken word: emphasis marks and link brackets (ו[קישור](…) is spoken "וקישור"). */
const INLINE_SYNTAX = "[*_~`\\[\\]]*";

/** [from, to) of `word` in `source` at or after `cursor`: as is, or with inline syntax between its letters. */
function findWord(source: string, word: string, cursor: number): [number, number] | null {
  const at = source.indexOf(word, cursor);
  // why: an exact hit before any syntax-spanning one is the word itself
  const re = new RegExp([...word].map((c) => c.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join(INLINE_SYNTAX), "gu");
  re.lastIndex = cursor;
  const m = re.exec(source);
  if (at >= 0 && (!m || at <= m.index)) return [at, at + word.length];
  return m ? [m.index, m.index + m[0].length] : null;
}

/**
 * The word a `boundary` event at `charIndex` starts: the word that contains
 * the index, or else the first one after it (engines report the index of
 * the space before a word too). Null past the last word.
 */
export function wordAtChar(words: readonly SpokenWord[], charIndex: number): SpokenWord | null {
  for (const w of words) {
    if (charIndex < w.end) return w;
  }
  return null;
}
