/** Plan W5.6: the word being read aloud, mapped from the speech engine's index back to the note. */
import { describe, it, expect } from "vitest";
import { mapSpokenWords, wordAtChar, wordsOf } from "../reading/wordSync";
import { speakableSentences } from "../ai/tts";

describe("read-aloud word sync", () => {
  it("keeps Hebrew words whole: niqqud, geresh, gershayim and maqaf stay inside the word", () => {
    expect(wordsOf("שָׁלוֹם צ'יפס, צה\"ל בית־ספר don't 3.5").map((w) => w.word)).toEqual(["שָׁלוֹם", "צ'יפס", "צה\"ל", "בית־ספר", "don't", "3", "5"]);
  });

  it("maps each spoken word to its range in the Markdown source", () => {
    const md = "שלום **עולם** ו[קישור](https://example.com) [[פתק|כינוי]].";
    const [s] = speakableSentences(md);
    const words = mapSpokenWords(s.text, md.slice(s.from, s.to), s.from);
    // A prefix letter before a link is one spoken word ("וקישור"): its range spans the bracket.
    expect(words.map((w) => md.slice(w.from, w.to))).toEqual(["שלום", "עולם", "ו[קישור", "כינוי"]);
    for (const w of words) expect(s.text.slice(w.start, w.end)).toBe(md.slice(w.from, w.to).replace(/[[\]*]/g, ""));
  });

  it("offsets the ranges by the sentence's place in the note", () => {
    const md = "First sentence. Second **bold** one.";
    const s = speakableSentences(md)[1];
    const words = mapSpokenWords(s.text, md.slice(s.from, s.to), s.from);
    expect(words.map((w) => md.slice(w.from, w.to))).toEqual(["Second", "bold", "one"]);
  });

  it("a boundary index on a word, or on the space before it, selects that word; past the end, none", () => {
    const words = mapSpokenWords("אחת שתיים", "אחת שתיים", 10);
    expect(wordAtChar(words, 0)).toMatchObject({ from: 10, to: 13 });
    expect(wordAtChar(words, 3)).toMatchObject({ from: 14, to: 19 });
    expect(wordAtChar(words, 5)).toMatchObject({ from: 14, to: 19 });
    expect(wordAtChar(words, 9)).toBeNull();
  });

  it("a word missing from the source is skipped, and the next one is still found in order", () => {
    const words = mapSpokenWords("a b c", "a c", 0);
    expect(words.map((w) => [w.from, w.to])).toEqual([
      [0, 1],
      [2, 3],
    ]);
  });
});
