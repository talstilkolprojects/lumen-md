/**
 * Plan W2.11 — light Hebrew morphology for search (src/text/hebrewMorph.ts)
 * and how its terms enter BM25 (src/text/searchTokens.ts).
 */
import { describe, it, expect } from "vitest";
import { englishOf, ktivKey, lemmaKeys, synonymsOf } from "../text/hebrewMorph";
import { KTIV, KTIV_WEIGHT, LEMMA, LEMMA_WEIGHT, documentTerms, morphTerms, queryTerms } from "../text/searchTokens";
import { normalizeForMatch } from "../text/hebrew";
import { Bm25Index } from "../search/bm25";

const n = (w: string) => normalizeForMatch(w);

describe("ktivKey: full and defective spelling meet", () => {
  it.each([
    ["תוכנית", "תכנית"],
    ["צהריים", "צהרים"],
    ["ריאיון", "ראיון"],
    ["אווירה", "אוירה"],
    ["ייצור", "יצור"],
    ["שולחן", "שלחן"],
  ])("%s = %s", (a, b) => {
    expect(ktivKey(n(a))).toBe(ktivKey(n(b)));
    expect(ktivKey(n(a))).not.toBeNull();
  });

  it("keeps the first letter and refuses non-Hebrew or too short words", () => {
    expect(ktivKey("ילד")).toBe("ילד");
    expect(ktivKey("abc")).toBeNull();
    expect(ktivKey("של")).toBeNull();
  });
});

describe("lemmaKeys: one inflection off", () => {
  it("joins plural, feminine and possessive forms of a word", () => {
    const shared = (a: string, b: string) => lemmaKeys(n(a)).some((k) => lemmaKeys(n(b)).includes(k) || k === ktivKey(n(b)));
    expect(shared("אבודות", "אבודה")).toBe(true);
    expect(shared("מזרחנים", "מזורחן")).toBe(true);
    expect(shared("אהבות", "אהבה")).toBe(true);
  });

  it("never leaves fewer than three letters before the key", () => {
    expect(lemmaKeys("בית")).toEqual([]);
    for (const k of lemmaKeys(n("ספרים"))) expect(k.length).toBeGreaterThanOrEqual(2);
  });
});

describe("lexicon", () => {
  it("synonyms both ways, English for common words", () => {
    expect(synonymsOf(n("סמארטפון"))).toContain(n("טלפון"));
    expect(synonymsOf(n("טלפון"))).toContain(n("סמארטפון"));
    expect(englishOf(n("מתכון"))).toEqual(["recipe"]);
    expect(englishOf("xyz")).toEqual([]);
  });
});

describe("search terms", () => {
  it("documents carry ktiv and lemma keys for Hebrew words and their prefix-less forms; Latin words none", () => {
    const terms = documentTerms("והתוכנית החדשה");
    expect(terms).toContain(KTIV + ktivKey("תכנית"));
    expect(terms.some((t) => t.startsWith(LEMMA))).toBe(true);
    expect(morphTerms("garden")).toEqual([]);
  });

  it("a query word's exact form outweighs its ktiv key, which outweighs its lemma keys; each term once", () => {
    const q = queryTerms("תכנית");
    const w = (prefix: string) => Math.max(...q.filter((t) => t.term.startsWith(prefix)).map((t) => t.weight));
    expect(q.find((t) => t.term === "תכנית")?.weight).toBe(1);
    expect(w(KTIV)).toBe(KTIV_WEIGHT);
    expect(KTIV_WEIGHT).toBeLessThan(1);
    expect(LEMMA_WEIGHT).toBeLessThan(KTIV_WEIGHT);
    expect(new Set(q.map((t) => t.term)).size).toBe(q.length);
  });

  it("ranks the exact spelling first, the other spelling next, and finds English notes from Hebrew", () => {
    const idx = new Bm25Index();
    idx.set("exact", "פגישה על התכנית החדשה");
    idx.set("other", "פגישה על התוכנית החדשה");
    idx.set("none", "פגישה על התקציב");
    expect(idx.search("תכנית").map((h) => h.id)).toEqual(["exact", "other"]);
    idx.set("en", "Chocolate cake recipe with butter and eggs");
    expect(idx.search("מתכון לעוגת שוקולד")[0].id).toBe("en");
  });
});
