/**
 * Plan W2.11 — light Hebrew morphology for search (src/text/hebrewMorph.ts)
 * and how its terms enter BM25 (src/text/searchTokens.ts).
 */
import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { englishOf, ktivKey, lemmaKeys, synonymsOf } from "../text/hebrewMorph";
import { ENGLISH_WEIGHT, KTIV, KTIV_WEIGHT, LEMMA, LEMMA_WEIGHT, documentTerms, morphTerms, queryTerms } from "../text/searchTokens";
// @ts-expect-error plain JavaScript
import { scoreHeldOut } from "../../scripts/search/hebrew-probe.mjs";
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
    expect(englishOf(n("כלב"))).toEqual(["dog"]);
    expect(englishOf("xyz")).toEqual([]);
  });
});

describe("Hebrew → English: held-out probe (W10.B6, audit W2.11)", () => {
  const FILE = "eval/probes/crosslingual-heldout-he-en.json";
  /** Frozen 15.11.2026. A change to the file (queries, notes or englishAtFreeze) fails here. */
  const SHA256 = "110649b7cf61fd479bd07f1ea0d11963cb3bbdd58244c288e54dfd1f60828b72";
  const raw = readFileSync(FILE, "utf8");
  const held = JSON.parse(raw) as { kind: string; items: Array<{ id: string; query: string; relevant: string[]; doc: { id: string; text: string } }>; englishAtFreeze: Record<string, string[]> };
  const english = (q: string) => [...new Set(queryTerms(q).filter((t) => t.weight === ENGLISH_WEIGHT).map((t) => t.term))].sort();

  it("is frozen: 30 queries, sha256 pinned", () => {
    expect(createHash("sha256").update(raw).digest("hex")).toBe(SHA256);
    expect(held.kind).toBe("held-out");
    expect(held.items).toHaveLength(30);
  });

  it("fails when the lexicon gains (or loses) an English term for a held-out query", () => {
    for (const it of held.items) expect(english(it.query), `${it.id} ${it.query}`).toEqual(held.englishAtFreeze[it.id]);
  });

  it("the dev probe's query words are not in the lexicon any more", () => {
    const dev = JSON.parse(readFileSync("eval/probes/hebrew-search.json", "utf8")) as { crosslingual: Array<{ query: string }> };
    for (const c of dev.crosslingual) expect(english(c.query), c.query).toEqual([]);
  });

  it("reports the held-out result, however low", () => {
    const heq = (JSON.parse(readFileSync("eval/golden/retrieval/dev/heq.json", "utf8")) as { corpus: Array<{ id: string; text: string }> }).corpus;
    const r = scoreHeldOut(Bm25Index, held, heq) as { top10: number; top1: number; total: number; missed: string[] };
    console.info(`held-out Hebrew → English: ${r.top10}/${r.total} in the top 10, ${r.top1}/${r.total} at rank 1`);
    expect(r.total).toBe(30);
    // Measured 15.11.2026: 0/30, with the old lexicon as well. A query
    // finds an English note only when every one of its words is in the
    // lexicon, which held for the dev probe because the lexicon was written
    // from it. A ratchet, not a target: this may only go up.
    expect(r.top10).toBeGreaterThanOrEqual(0);
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
    // A word of the general lexicon (the dev-probe rows are gone, W10.B6).
    idx.set("en", "The cat sleeps on the sofa all afternoon");
    expect(idx.search("חתול")[0].id).toBe("en");
  });
});
