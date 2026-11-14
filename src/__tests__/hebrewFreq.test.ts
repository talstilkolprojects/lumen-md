// @vitest-environment node
/**
 * Plan 9.2 — Hebrew spelling without the network: the bundled FrequencyWords
 * he_50k list (CC BY-SA 4.0) for suggestion-only hints, the two rules T28
 * listed (the article after ב/כ/ל, "את" before an indefinite noun), a
 * detached prefix letter, and the 7.1 acceptance numbers on the dev split.
 * Tests run against the real list, not a fixture.
 */
import { describe, it, expect, beforeAll } from "vitest";
import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import {
  HEBREW_FREQ_PATH,
  frequencyKnown,
  frequencyRules,
  frequencySpelling,
  frequencySuggestions,
  lonePrefixRule,
  offlineHebrewChecks,
  parseFrequencyList,
  type FrequencyList,
} from "../ai/hebrewFreq";
import { hebrewRules } from "../ai/hebrewSpell";

const LIST_FILE = `public/${HEBREW_FREQ_PATH}`;
let list: FrequencyList;
beforeAll(() => {
  list = parseFrequencyList(readFileSync(LIST_FILE, "utf8"));
});
const ids = (text: string) => offlineHebrewChecks(list, text, hebrewRules).map((m) => [m.rule.id, text.slice(m.offset, m.offset + m.length), m.replacements[0]]);

describe("the bundled list", () => {
  it("is FrequencyWords he_50k, unmodified, with its licence beside it and a registry entry", () => {
    const bytes = readFileSync(LIST_FILE);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe("0069e931eb1ca0aaf638ea806b0d9d5810d787c51ada944da564a2fb213af41d");
    expect(list.counts.size).toBe(50000);
    expect(list.counts.get("את")).toBeGreaterThan(1_000_000);
    const licence = readFileSync("public/dict/LICENSE.md", "utf8");
    expect(licence).toMatch(/CC BY-SA 4\.0/);
    expect(licence).toMatch(/Hermit Dave/);
    const entry = JSON.parse(readFileSync("models/registry.json", "utf8")).models.find((m: { id: string }) => m.id === "frequencywords-he-50k");
    expect(entry).toMatchObject({ license: "CC-BY-SA-4.0", delivery: "bundled" });
    expect(entry.match).toContain(HEBREW_FREQ_PATH);
  });

  it("works offline from install: the PWA precaches it, and Hspell is still never bundled", () => {
    const vite = readFileSync("vite.config.ts", "utf8");
    expect(vite).toMatch(/globPatterns:\s*\[[^\]]*"dict\/\*\.txt"/);
    expect(existsSync("public/dict/index.dic")).toBe(false);
    const hspell = JSON.parse(readFileSync("models/registry.json", "utf8")).models.find((m: { id: string }) => m.id === "hspell-he-dictionary");
    expect(hspell).toMatchObject({ class: "forbidden", delivery: "user-download" });
  });
});

describe("layer 1: the browser / OS spellchecker", () => {
  it("is on in the source editor and the WYSIWYG editor alike, following the same setting", () => {
    expect(readFileSync("src/editor/Editor.tsx", "utf8")).toMatch(/spellcheck: spellCheck \? "true" : "false"/);
    expect(readFileSync("src/editor/WysiwygEditor.tsx", "utf8")).toMatch(/attributes: \(\) => \(\{ spellcheck: spellCheckRef\.current \? "true" : "false" \}\)/);
    expect(readFileSync("src/layouts/EditorLayout.tsx", "utf8")).toContain("<WysiwygEditor value={docContent} onChange={setContent} spellCheck={spellCheck} />");
  });
});

describe("known words", () => {
  it("peels prefix letters to a stem of three or more letters", () => {
    for (const w of ["בבית", "שהמחשב", "כשהלכתי", "ולממשלה"]) expect(frequencyKnown(list, w), w).toBe(true);
  });
  it("does not peel away a doubled article", () => {
    expect(frequencyKnown(list, "ההיום")).toBe(false);
    expect(frequencyKnown(list, "בהבית")).toBe(false);
  });
});

describe("spelling hints (suggestion-only)", () => {
  it("flags a word one edit from a frequent word, as a HINT naming the list", () => {
    const [m] = frequencySpelling(list, "ללא חקיאה");
    expect(m).toMatchObject({ rule: { id: "HE_SPELLING_HINT", category: "HINT" } });
    expect(m.replacements[0]).toBe("חקירה");
    expect(m.message).toMatch(/FrequencyWords.*CC BY-SA 4\.0/);
  });
  it("a frequent neighbour is found even behind many rare ones (#257 review)", () => {
    // "יודן" has a dozen rare one-edit neighbours in the list; "יודע" (count 621k) must still come up.
    expect(frequencySuggestions(list, "יודן")).toContain("יודע");
  });
  it("leaves names and rare forms with no frequent neighbour alone", () => {
    expect(frequencySpelling(list, "קאוורדרקוב")).toEqual([]);
  });
});

describe("the two rules (9.2.2)", () => {
  it("HE_ARTICLE_AFTER_PREPOSITION: ב/כ/ל swallow the article", () => {
    expect(ids("הלכתי בהבית של אמא")).toEqual([["HE_ARTICLE_AFTER_PREPOSITION", "בהבית", "בבית"]]);
    expect(ids("זה בהחלט נכון")).toEqual([]);
  });
  it("HE_ET_INDEFINITE: את before an indefinite common noun", () => {
    expect(frequencyRules(list, "ראיתי את ילד ברחוב").map((m) => m.rule.id)).toEqual(["HE_ET_INDEFINITE"]);
    expect(ids("קראתי את ספר")[0]).toEqual(["HE_ET_INDEFINITE", "את ספר", "את הספר"]);
  });
  it("HE_ET_INDEFINITE stays quiet on definite objects, constructs, names and the pronoun", () => {
    for (const t of ["ראיתי את הילד ברחוב", "ראיתי את ספר הילד", "פגשתי את דני אתמול", "את יודעת מה קרה", "אמרתי לה: את צודקת", "ראיתי את זה", "הבאתי את כל הספרים"]) {
      expect(frequencyRules(list, t), t).toEqual([]);
    }
  });
  it("a detached prefix letter is joined back, but a letter with a geresh is not", () => {
    expect(lonePrefixRule("ב זכות זה הצלחנו").map((m) => m.replacements[0])).toEqual(["בזכות"]);
    expect(lonePrefixRule("סעיף ב' לחוק")).toEqual([]);
  });
});

describe("7.1 acceptance on the dev split (the CI test split is scored by the same harness)", () => {
  it("recall ≥ 70% on non-word errors, false positives ≤ 5% on clean text", async () => {
    // @ts-expect-error — plain .mjs harness without type declarations
    const { score } = await import("../../scripts/golden/evals/typos-he.mjs");
    const items = JSON.parse(readFileSync("eval/golden/typos-he/dev/synthetic.json", "utf8")).items;
    const s = await score({ items });
    expect(s.errors).toBeGreaterThan(40);
    expect(s.recall_nonword).toBeGreaterThanOrEqual(0.7);
    expect(s.fp_per_token).toBeLessThanOrEqual(0.05);
  }, 60_000);
});

describe("the worker never waits for the list (#257 review)", () => {
  it("answers a check before the list arrives, then announces the list", async () => {
    const src = readFileSync("src/ai/hebrewSpell.worker.ts", "utf8");
    expect(src).not.toMatch(/await freqLoad/);
    expect(src).toMatch(/type: "freq-loaded"/);
    expect(readFileSync("src/ai/hebrewSpellService.ts", "utf8")).toMatch(/"freq-loaded"[\s\S]*announceDictionaryChange\(\)/);
  });
});
