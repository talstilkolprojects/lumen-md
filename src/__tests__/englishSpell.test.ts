import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { englishSpelling, isCheckable, maskNonProse, spellWords, type SpellChecker } from "../ai/englishSpell";
import { __resetEnglishSpell, checkEnglish, checkEnglishParagraphs, englishOnly } from "../ai/englishSpellService";
import { checkGrammar, clearGrammarCache, mergeMatches } from "../ai/grammar";

/** A tiny dictionary double: lower-case words, plus a fixed suggestion. */
function fake(words: string[]): SpellChecker & { suggested: string[] } {
  const set = new Set(words);
  const suggested: string[] = [];
  return {
    suggested,
    correct: (w) => set.has(w),
    suggest: (w) => {
      suggested.push(w);
      return ["fixed"];
    },
  };
}

describe("englishSpell — what counts as prose", () => {
  it("never checks code, front matter, links, URLs, tags or identifiers", () => {
    const text = [
      "---",
      "titel: frontmater",
      "---",
      "Prose wurd here, `inlne` code and [[Wikki Paige]].",
      "",
      "```js",
      "const fooo = barr;",
      "```",
      "",
      "    indentd code",
      "",
      "See [the docz](https://exmple.com/pathh) or www.exampl.org, mail me@exmaple.com, #tagg, HTTPZ, iPhonee, abc123, snake_casee &nbsp; :smilee:",
      "[^nott]: A footnote wurd2.",
      "[reff]: https://exampel.com",
      "<span clas=\"x\">tagged</span>",
    ].join("\n");
    const words = spellWords(text).map((w) => w.word);
    expect(words).toContain("wurd");
    expect(words).toContain("docz"); // link text is prose
    expect(words).toContain("tagged");
    for (const hidden of ["titel", "frontmater", "inlne", "Wikki", "fooo", "barr", "indentd", "exmple", "pathh", "exampl", "exmaple", "tagg", "HTTPZ", "iPhonee", "abc123", "snake_casee", "nbsp", "smilee", "nott", "reff", "exampel", "clas"]) {
      expect(words, hidden).not.toContain(hidden);
    }
  });

  it("keeps offsets: masking never changes the length", () => {
    const text = "Some `code` and https://x.y/z here.";
    expect(maskNonProse(text)).toHaveLength(text.length);
    const tok = spellWords(text).find((w) => w.word === "here")!;
    expect(text.slice(tok.offset, tok.offset + 4)).toBe("here");
  });

  it("nested list items are prose, not indented code", () => {
    expect(spellWords("- top\n    - nestd item").map((w) => w.word)).toContain("nestd");
  });

  it("checks plain words only", () => {
    expect(isCheckable("whale")).toBe(true);
    expect(isCheckable("whale's")).toBe(true);
    expect(isCheckable("NASA")).toBe(false);
    expect(isCheckable("useState")).toBe(false);
    expect(isCheckable("a")).toBe(false);
    expect(isCheckable("שלום")).toBe(false);
  });
});

describe("englishSpell — matches", () => {
  it("flags unknown words with offsets, suggestions and the i18n key; possessives and capitals are known", () => {
    const sp = fake(["the", "whale", "swims", "far"]);
    const text = "The whale's sweems far.";
    const m = englishSpelling(sp, text);
    expect(m).toEqual([{ offset: 12, length: 6, message: "spell.en.unknown", replacements: ["fixed"], rule: { id: "EN_SPELL", category: "TYPOS" } }]);
  });

  it("caps suggestion work and reuses the cache; the personal list is skipped", () => {
    const sp = fake([]);
    const cache = new Map<string, string[]>();
    const m = englishSpelling(sp, "aaa bbb ccc aaa ddd", { maxSuggest: 2, suggestCache: cache, personal: new Set(["ddd"]) });
    expect(m.map((x) => x.replacements.length)).toEqual([1, 1, 0, 1]);
    expect(sp.suggested).toEqual(["aaa", "bbb"]);
  });

  it("mergeMatches keeps the first list and adds only non-overlapping matches", () => {
    const a = { offset: 5, length: 4, message: "a", replacements: [], rule: { id: "A" } };
    const b = { offset: 7, length: 3, message: "b", replacements: [], rule: { id: "B" } };
    const c = { offset: 0, length: 3, message: "c", replacements: [], rule: { id: "C" } };
    expect(mergeMatches([a], [b, c]).map((m) => m.rule.id)).toEqual(["C", "A"]);
  });
});

describe("englishSpell — the real dictionary (main-thread fallback, no Worker in jsdom)", () => {
  beforeEach(() => __resetEnglishSpell());

  it("finds real typos and suggests the fix; clean English passes", async () => {
    const m = await checkEnglish("The quick brown fox jumps over the lazy dgo, and then it was no lnoger hungry.");
    expect(m.map((x) => x.length)).toEqual([3, 6]);
    expect(m[1].replacements).toContain("longer");
    expect(m[0].message).not.toBe("spell.en.unknown"); // translated in the service
    expect(await checkEnglish("It was the best of times, it was the worst of times, it was the age of wisdom.")).toEqual([]);
  }, 20_000);

  it("routes by paragraph language: a French paragraph is not checked as English", async () => {
    const text = "This paragraph is written in English and has one mistaek in it for the test.\n\nCe paragraphe est écrit en français et il ne faut pas le vérifier comme de l'anglais du tout.";
    const english = await englishOnly(text);
    expect(english).toHaveLength(text.length);
    expect(english).toContain("mistaek");
    expect(english).not.toContain("paragraphe");
    const m = await checkEnglishParagraphs(text);
    expect(m.map((x) => text.slice(x.offset, x.offset + x.length))).toEqual(["mistaek"]);
  }, 20_000);
});

describe("englishSpell — local-only sends nothing", () => {
  const fetchSpy = vi.fn(async () => new Response("{}", { status: 200 }));
  beforeEach(() => {
    __resetEnglishSpell();
    clearGrammarCache();
    localStorage.clear();
    localStorage.setItem("lumen.ai.policy", "local-only");
    vi.stubGlobal("fetch", fetchSpy);
    fetchSpy.mockClear();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("background checks spell English on this device: 0 requests to api.languagetool.org", async () => {
    const text = "This note has enough words to be checked, and one of them is mispeled on purpose.";
    const m = await checkGrammar(text);
    expect(m.map((x) => text.slice(x.offset, x.offset + x.length))).toEqual(["mispeled"]);
    expect(m[0].rule.id).toBe("EN_SPELL");
    expect(fetchSpy).not.toHaveBeenCalled();
  }, 20_000);

  it("under the cloud policy the public LanguageTool API is still used (the user chose it)", async () => {
    localStorage.setItem("lumen.ai.policy", "cloud");
    fetchSpy.mockResolvedValueOnce(new Response(JSON.stringify({ matches: [] }), { status: 200 }));
    await checkGrammar("This note has enough words to be checked by the public service.");
    expect(String((fetchSpy.mock.calls[0] as unknown[])[0])).toContain("api.languagetool.org");
  });
});
