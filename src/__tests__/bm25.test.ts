/**
 * Plan 5.2: BM25 over the workspace — Hebrew tokens and the index, updated
 * one note at a time.
 */
import { describe, it, expect, vi } from "vitest";
import { Bm25Index } from "../search/bm25";
import { documentTerms, queryTerms, stemTerms, surfaceTokens } from "../text/searchTokens";

describe("Hebrew search tokens", () => {
  it("strip niqqud and fold final letters, keeping the word's own form", () => {
    expect(surfaceTokens("שָׁלוֹם עוֹלָם")).toEqual(["שלומ", "עולמ"]);
    expect(surfaceTokens("צה״ל וצה\"ל")).toEqual(["צהל", "וצהל"]);
    expect(surfaceTokens("Hello, World")).toEqual(["hello", "world"]);
  });

  it("add prefix-less stems beside the exact form, without stripping below three letters", () => {
    expect(documentTerms("והבית")).toEqual(["והבית", "~והבית", "~הבית", "~בית"]);
    // ש is a prefix letter, but "לומ" keeps three letters and is only a weaker stem; "שלומ" itself stays exact.
    expect(documentTerms("שלום")).toEqual(["שלומ", "~שלומ", "~לומ"]);
    expect(stemTerms("בית")).toEqual(["~בית"]); // three letters: nothing stripped
    expect(stemTerms("hello")).toEqual([]);
  });

  it("split hyphenated words into their parts as extra forms", () => {
    expect(stemTerms("מ-100")).toEqual(["~מ-100", "~100"]);
    expect(stemTerms("מזאל-שחר")).toEqual(expect.arrayContaining(["~מזאל", "~שחר"]));
  });

  it("drop question words and prepositions from queries, unless nothing else is left", () => {
    expect(queryTerms("מתי נוסדה העיר?").filter((t) => t.weight === 1).map((t) => t.term)).toEqual(["נוסדה", "העיר"]);
    expect(queryTerms("למי שייך המוצר").filter((t) => t.weight === 1).map((t) => t.term)).toEqual(["שייכ", "המוצר"]);
    expect(queryTerms("מה").map((t) => t.term)).toEqual(["מה", "~מה"]);
  });
});

describe("Bm25Index", () => {
  const notes = {
    "a.md": "הלכנו אל הַבַּיִת הישן בבוקר",
    "b.md": "בית ספר חדש נפתח בעיר",
    "c.md": "שלום לכולם, ברוכים הבאים",
    "d.md": "Notes about the garden and the house",
  };
  const index = () => {
    const ix = new Bm25Index();
    for (const [id, text] of Object.entries(notes)) ix.set(id, text, id.replace(".md", ""));
    return ix;
  };

  it("finds a word with or without its prefix letters, the exact form first", () => {
    const ix = index();
    expect(ix.search("בבית").map((h) => h.id)).toEqual(expect.arrayContaining(["a.md", "b.md"]));
    // "הבית" is written in a.md (with niqqud): it ranks above b.md's bare "בית".
    expect(ix.search("הבית")[0].id).toBe("a.md");
    expect(ix.search("בית")[0].id).toBe("b.md");
    expect(ix.search("garden").map((h) => h.id)).toEqual(["d.md"]);
  });

  it("does not let an over-stripped stem beat the exact word", () => {
    const ix = index();
    ix.set("e.md", "לום לום לום", "e");
    // "שלום" exact in c.md; e.md only shares the weaker stem "~לום".
    expect(ix.search("שלום")[0].id).toBe("c.md");
  });

  it("scores the name as a boosted field and reports what matched", () => {
    const ix = new Bm25Index();
    ix.set("x.md", "some text about budgets", "planning");
    ix.set("y.md", "planning is mentioned once here among many other words in this note", "other");
    const [top] = ix.search("planning");
    expect(top.id).toBe("x.md");
    expect(top.matched).toEqual(["planning"]);
  });

  it("is updated one note at a time: replace, remove, and skip an unchanged note", () => {
    const ix = index();
    expect(ix.size).toBe(4);
    ix.set("b.md", "גינה ופרחים", "b");
    expect(ix.search("ספר")).toEqual([]);
    expect(ix.search("גינה").map((h) => h.id)).toEqual(["b.md"]);
    ix.remove("a.md");
    expect(ix.size).toBe(3);
    expect(ix.search("הבית").map((h) => h.id)).not.toContain("a.md");
    // The same text again is not re-tokenised.
    const before = ix.isCurrent("c.md", notes["c.md"], "c");
    expect(before).toBe(true);
    const spy = vi.spyOn(Map.prototype, "set");
    ix.set("c.md", notes["c.md"], "c");
    expect(spy).not.toHaveBeenCalled();
    spy.mockRestore();
    // An index built note by note equals one built at once.
    const fresh = new Bm25Index();
    fresh.set("b.md", "גינה ופרחים", "b");
    fresh.set("c.md", notes["c.md"], "c");
    fresh.set("d.md", notes["d.md"], "d");
    for (const q of ["גינה", "שלום", "house", "בית"]) expect(ix.search(q)).toEqual(fresh.search(q));
  });

  it("matches the parts of hyphenated words both ways (review: #232)", () => {
    const ix = new Bm25Index();
    ix.set("e.md", "send me an e-mail tomorrow", "e");
    ix.set("h.md", "התאוצה מ-100 קמ״ש", "h");
    ix.set("m.md", "the mail came late", "m");
    expect(ix.search("mail").map((h) => h.id)).toEqual(expect.arrayContaining(["e.md", "m.md"]));
    expect(ix.search("100").map((h) => h.id)).toEqual(["h.md"]);
    // The hyphenated form itself ranks the note that has it first.
    expect(ix.search("e-mail")[0].id).toBe("e.md");
    expect(ix.search("e-mail").map((h) => h.id)).toContain("m.md");
  });

  it("filters before the limit", () => {
    const ix = index();
    expect(ix.search("בית", { filter: (id) => id !== "b.md" }).map((h) => h.id)).toEqual(["a.md"]);
    expect(ix.search("בית", { limit: 1 })).toHaveLength(1);
  });
});
