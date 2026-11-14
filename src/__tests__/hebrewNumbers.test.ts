/**
 * Plan W2.6 — numbers read out for the neural Hebrew voice, and the G2P's
 * phoneme inventory a voice must cover. A digit isn't a letter, so without
 * this a voice would skip "15" or "3.5%" silently.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { cardinal, expandNumbers, numberWords } from "../ai/tts/hebrewNumbers";
import { G2P_PHONEMES, sentenceToIpa, wordToIpa } from "../ai/tts/hebrewG2P";
import { prepareSentence } from "../ai/tts/neuralReader";
import { voiceCoverage, type PiperConfig } from "../ai/tts/voices";

const strip = (s: string) => s.normalize("NFD").replace(/[֑-ׇ]/g, "");
const PAUSES = new Set([" ", ",", ".", "?", "!", ";", ":", "-", "…", "\"", "(", ")"]);
const outside = (ipa: string) => Array.from(ipa.normalize("NFD")).filter((c) => !G2P_PHONEMES.includes(c) && !PAUSES.has(c));

describe("W2.6 numbers in words", () => {
  it("says whole numbers as Modern Hebrew counts them", () => {
    const cases: Array<[number, string]> = [
      [0, "אפס"],
      [3, "שלוש"],
      [12, "שתים עשרה"],
      [21, "עשרים ואחת"],
      [38, "שלושים ושמונה"],
      [110, "מאה ועשר"],
      [200, "מאתים"],
      [999, "תשע מאות תשעים ותשע"],
      [2000, "אלפים"],
      [2025, "אלפים עשרים וחמש"],
      [3000, "שלושת אלפים"],
      [21500, "עשרים ואחת אלף וחמש מאות"],
      [1_000_000, "מיליון"],
      [2_000_000, "שני מיליון"],
      [1_250_000, "מיליון מאתים וחמשים אלף"],
      [1_234_567, "מיליון מאתים שלושים וארבע אלף חמש מאות ששים ושבע"],
    ];
    for (const [n, words] of cases) expect(strip(cardinal(n)), String(n)).toBe(words);
    expect(() => cardinal(1_000_000_000)).toThrow(RangeError);
    expect(() => cardinal(-1)).toThrow(RangeError);
  });

  it("reads decimals, percent, minus, times, and long digit strings one by one", () => {
    expect(strip(numberWords("3.5")!)).toBe("שלוש נקדה חמש");
    expect(strip(numberWords("0.25")!)).toBe("אפס נקדה עשרים וחמש");
    expect(strip(numberWords("15%")!)).toBe("חמש עשרה אחוז");
    expect(strip(numberWords("-7")!)).toBe("מינוס שבע");
    expect(strip(numberWords("14:30")!)).toBe("ארבע עשרה שלושים");
    expect(strip(numberWords("9:05")!)).toBe("תשע אפס חמש");
    expect(strip(numberWords("9:00")!)).toBe("תשע");
    expect(numberWords("25:00")).toBeNull();
    expect(strip(numberWords("052")!)).toBe("אפס חמש שתים");
    expect(strip(numberWords("12345678901")!).split(" ")).toHaveLength(11);
    expect(numberWords("abc")).toBeNull();
  });

  it("finds numbers in a sentence, with a prefix said before them, and tells a minus from a joining hyphen", () => {
    expect(strip(expandNumbers("יש לי 3 תפוחים."))).toBe("יש לי שלוש תפוחים.");
    expect(strip(expandNumbers("ב-2025 עברנו"))).toBe("באלפים עשרים וחמש עברנו");
    expect(strip(expandNumbers("וב2025"))).toBe("ובאלפים עשרים וחמש");
    expect(strip(expandNumbers("ל־3 ימים"))).toBe("לשלוש ימים");
    expect(strip(expandNumbers("הטמפרטורה -7 מעלות"))).toBe("הטמפרטורה מינוס שבע מעלות");
    expect(strip(expandNumbers("בשעה 14:30, בחדר 12."))).toBe("בשעה ארבע עשרה שלושים, בחדר שתים עשרה.");
    // Not a number between word boundaries: left as it is.
    expect(expandNumbers("v2.0 abc3")).toBe("v2.0 abc3");
    expect(expandNumbers("שלום")).toBe("שלום");
  });

  it("leaves no digit for the G2P, and every sound it writes is one a voice must cover", () => {
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let i = 0; i < 400; i++) {
      const n = Math.floor(rnd() ** 3 * 999_999_999);
      const ipa = sentenceToIpa(expandNumbers(`ב-${n} ו-${(rnd() * 100).toFixed(2)}% ב-${Math.floor(rnd() * 24)}:${String(Math.floor(rnd() * 60)).padStart(2, "0")}.`));
      expect(/\d/.test(ipa), `${n}: ${ipa}`).toBe(false);
      expect(outside(ipa), `${n}: ${ipa}`).toEqual([]);
    }
  });

  it("the neural voice's sentence keeps one timing entry per written word, a number included", () => {
    const { ipa, words } = prepareSentence("שָׁלוֹם 21 לָכֶם");
    expect(words).toHaveLength(3);
    expect(words[1]).toBe(sentenceToIpa(expandNumbers("21")));
    expect(ipa).not.toMatch(/\d/);
  });
});

describe("W2.6 the G2P's phoneme inventory", () => {
  it("is every sound the G2P writes, over pointed syllables of every letter, vowel and mark", () => {
    const letters = Array.from("אבגדהוזחטיכלמנסעפצקרשתךםןףץ");
    const vowels = ["", "ְ", "ֱ", "ֲ", "ֳ", "ִ", "ֵ", "ֶ", "ַ", "ָ", "ֹ", "ֺ", "ֻ", "ׇ"];
    const marks = ["", "ּ", "ׁ", "ׂ", "׳", "֫"];
    const syl: string[] = [];
    for (const l of letters) for (const v of vowels) for (const m of marks) syl.push(l + m + v);
    const seen = new Set<string>();
    for (let i = 0; i < syl.length; i++) {
      const w = syl[i] + syl[(i * 31 + 7) % syl.length] + syl[(i * 17 + 3) % syl.length];
      for (const c of Array.from(wordToIpa(w).normalize("NFD"))) seen.add(c);
    }
    expect([...seen].filter((c) => !G2P_PHONEMES.includes(c))).toEqual([]);
    // And the inventory isn't padded: every listed phoneme is written by some syllable.
    expect(G2P_PHONEMES.filter((p) => !seen.has(p))).toEqual([]);
  });

  it("a voice config is checked against it, pauses included", () => {
    const full: PiperConfig = { audio: { sample_rate: 22050 }, phoneme_id_map: Object.fromEntries(["^", "$", "_", " ", ",", ".", "?", "!", ...G2P_PHONEMES].map((p, i) => [p, [i]])) };
    expect(voiceCoverage(full, G2P_PHONEMES)).toEqual({ missing: [], missingPauses: [] });
    const { χ: _drop, "?": _q, ...rest } = full.phoneme_id_map;
    void _drop;
    void _q;
    expect(voiceCoverage({ ...full, phoneme_id_map: rest }, G2P_PHONEMES)).toEqual({ missing: ["χ"], missingPauses: ["?"] });
  });
});
