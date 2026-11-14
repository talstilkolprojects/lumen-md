/**
 * Plan 0.15 — text/hebrew without mocks, so mutation testing can run it
 * anywhere: detection, niqqud, folding, prefixes, word counts, the offset
 * map and the search that uses it, and the Hebrew share of a text.
 */
import { describe, expect, it } from "vitest";
import { countWords, hasHebrew, hebrewFind, hebrewRatio, normalizeForMatch, normalizeWithMap, prefixVariants, stripNiqqud, words } from "../text/hebrew";

describe("text/hebrew", () => {
  it("detects Hebrew letters, not marks alone or other scripts", () => {
    expect(hasHebrew("שלום")).toBe(true);
    expect(hasHebrew("abc")).toBe(false);
    expect(hasHebrew("مرحبا")).toBe(false);
    expect(hasHebrew("")).toBe(false);
  });

  it("strips niqqud and cantillation but keeps letters and Latin accents", () => {
    expect(stripNiqqud("שָׁלוֹם")).toBe("שלום");
    expect(stripNiqqud("בְּרֵאשִׁית֑")).toBe("בראשית");
    expect(stripNiqqud("café")).toBe("café");
  });

  it("folds finals, quotes, maqaf and case", () => {
    expect(normalizeForMatch("שלום")).toBe("שלומ");
    expect(normalizeForMatch("ךםןףץ")).toBe("כמנפצ");
    expect(normalizeForMatch("צה״ל ג׳ירפה “x” ‘y’ תל־אביב ABC")).toBe('צה"ל ג\'ירפה "x" \'y\' תל-אביב abc');
  });

  it("gives up to three prefix-less forms, keeping at least three letters", () => {
    expect(prefixVariants("והבית")).toEqual(["והבית", "הבית", "בית"]);
    expect(prefixVariants("ומהשבית")).toEqual(["ומהשבית", "מהשבית", "השבית", "שבית"]);
    expect(prefixVariants("ובית")).toEqual(["ובית", "בית"]);
    expect(prefixVariants("בית")).toEqual(["בית"]);
    expect(prefixVariants("דבר")).toEqual(["דבר"]);
    expect(prefixVariants("hello")).toEqual(["hello"]);
  });

  it("counts words with geresh, gershayim, apostrophes and maqaf inside them", () => {
    expect(words("צה״ל, ג'ירפה ו-tel־aviv 2026 it’s.")).toEqual(["צה״ל", "ג'ירפה", "ו-tel־aviv", "2026", "it’s"]);
    expect(words("ג׳")).toEqual(["ג׳"]);
    expect(countWords("  ")).toBe(0);
    expect(countWords("אחת שתיים three")).toBe(3);
  });

  it("maps each folded character back to the original offset", () => {
    const r = normalizeWithMap("שָׁלוֹם a");
    expect(r.text).toBe("שלומ a");
    expect(r.map).toEqual([0, 3, 4, 6, 7, 8, 9]);
    expect(normalizeWithMap("").map).toEqual([0]);
    const astral = normalizeWithMap("😀x");
    expect(astral.map).toEqual([0, 2, 3]);
  });

  it("finds a folded, prefix-free match and returns original offsets", () => {
    expect(hebrewFind("הלכנו לבַּיִת הגדול", "בית")).toEqual({ start: 7, end: 13 });
    expect(hebrewFind("הלכנו לבית", "ולבית")).toEqual({ start: 6, end: 10 });
    expect(hebrewFind("abc", "  ")).toBe(null);
    expect(hebrewFind("abc", "zz")).toBe(null);
    expect(hebrewFind("one בית two", "בית two")).toEqual({ start: 4, end: 11 });
    expect(hebrewFind("one ביתtwo", "ובית two")).toBe(null);
  });

  it("measures the Hebrew share of the letters", () => {
    expect(hebrewRatio("שלום abcd")).toBe(0.5);
    expect(hebrewRatio("123 !")).toBe(0);
    expect(hebrewRatio("שלום")).toBe(1);
  });
});
