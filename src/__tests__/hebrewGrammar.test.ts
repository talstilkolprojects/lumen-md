/**
 * Plan W5.3 — the local Hebrew grammar and style checker: each rule, the
 * levels, the merge with spelling, the model seam, and the probe of 200
 * marked errors (recall, false positives on the corrected sentences and on
 * real prose, latency, no network).
 * @vitest-environment node
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { applyFirst, hebrewGrammar, mergeGrammar, pluralGender } from "../ai/hebrewGrammar";
import { ollamaGrammarRanker, rankFindings } from "../ai/grammarRanker";
// @ts-expect-error the harness is plain JavaScript
import { scoreGrammar } from "../../scripts/grammar/score-probe.mjs";

const ids = (t: string, level?: "everyday" | "academic" | "legal") => hebrewGrammar(t, level).map((m) => m.rule.id);
const fix = (t: string, level?: "everyday" | "academic" | "legal") => applyFirst(t, hebrewGrammar(t, level));
const probe = JSON.parse(readFileSync(join(__dirname, "../../eval/probes/hebrew-grammar.json"), "utf8"));
const heq = (JSON.parse(readFileSync(join(__dirname, "../../eval/golden/retrieval/dev/heq.json"), "utf8")) as { corpus: Array<{ text: string }> }).corpus.map((d) => d.text);

describe("rules", () => {
  it("numbers 3–10 agree with the noun (the form that looks like the other gender)", () => {
    expect(fix("יש לי שלוש ילדים.")).toBe("יש לי שלושה ילדים.");
    expect(fix("קראתי חמישה מילים.")).toBe("קראתי חמש מילים.");
    expect(fix("עברו ארבע שבועות.")).toBe("עברו ארבעה שבועות."); // -ות but masculine
    expect(fix("עברו עשרה שנים.")).toBe("עברו עשר שנים."); // -ים but feminine
    expect(ids("שלושה ילדים ושלוש בנות")).toEqual([]);
    expect(ids("שלוש עשרה בנות ושלושה עשר ילדים")).toEqual([]); // teens
    expect(ids("בשעה שלוש אנשים יצאו")).toEqual([]);
    expect(ids("שלוש מים")).toEqual([]); // unknown gender: left alone
  });

  it("two: שני / שתי before a noun", () => {
    expect(fix("קנינו שתי ספרים.")).toBe("קנינו שני ספרים.");
    expect(fix("יש שניים ילדים.")).toBe("יש שני ילדים.");
    expect(fix("ראיתי שני בנות.")).toBe("ראיתי שתי בנות.");
    expect(ids("ביום שני ילדים באים")).toEqual([]);
  });

  it("הכי … ביותר", () => {
    expect(fix("זה הכי טוב ביותר.")).toBe("זה טוב ביותר.");
    expect(ids("זה הכי טוב")).toEqual([]);
  });

  it("verbs of meeting and talking take עם", () => {
    expect(fix("נפגשתי את דני אתמול.")).toBe("נפגשתי עם דני אתמול.");
    expect(fix("דיברתי אותו בבוקר.")).toBe("דיברתי איתו בבוקר.");
    expect(ids("ראיתי את דני")).toEqual([]);
    expect(ids("השלמתי את העבודה")).toEqual([]);
  });

  it("the article goes on the last noun of a construct pair", () => {
    expect(fix("הבית ספר סגור.")).toBe("בית הספר סגור.");
    expect(fix("שמעתי שהבית חולים מלא.")).toBe("שמעתי שבית החולים מלא.");
    expect(ids("בית הספר סגור")).toEqual([]);
  });

  it("אני + future starts with א; pleonasms", () => {
    expect(fix("מחר אני ילך הביתה.")).toBe("מחר אני אלך הביתה.");
    expect(fix("הוא חזר שוב הביתה.")).toBe("הוא חזר הביתה.");
    expect(fix("הגיעו בערך כמאה אנשים.")).toBe("הגיעו כמאה אנשים.");
    expect(ids("אני יודע")).toEqual([]);
  });

  it("levels: academic and legal flag spoken Hebrew, everyday does not", () => {
    expect(ids("זה הכי חשוב")).toEqual([]);
    expect(ids("זה הכי חשוב", "academic")).toEqual(["HE_REGISTER_HACHI"]);
    expect(fix("עזבתי בגלל שהוא איחר.", "legal")).toBe("עזבתי מכיוון שהוא איחר.");
    expect(ids("בגלל שדרוג התוכנה", "academic")).toEqual([]);
  });

  it("every finding has an i18n message, an explanation and a replacement", () => {
    for (const it of probe.items) {
      for (const m of hebrewGrammar(it.text)) {
        expect(m.messageKey).toMatch(/^grammar\.he\.[A-Z_]+$/);
        expect(m.explainKey).toBe(`${m.messageKey}.why`);
        expect(m.replacements.length).toBeGreaterThan(0);
      }
    }
  });

  it("noun gender from the plural, with the exceptions", () => {
    expect([pluralGender("ילדים"), pluralGender("בנות"), pluralGender("נשים"), pluralGender("חלונות"), pluralGender("ידיים"), pluralGender("משקפיים")]).toEqual(["masc", "fem", "fem", "masc", "fem", null]);
  });

  it("a grammar finding replaces a spelling finding on the same words", () => {
    const text = "שלוש ילדים";
    const spelling = [{ offset: 0, length: 4, message: "x", replacements: [], rule: { id: "HE_SPELLING", category: "TYPOS" } }];
    expect(mergeGrammar(spelling, text, "everyday").map((m) => m.rule.id)).toEqual(["HE_NUM_GENDER"]);
  });
});

describe("probe: 200 sentences with a marked error", () => {
  it("recall ≥ 70%, false positives ≤ 5% (corrected sentences and real prose), ≤ 300 ms a paragraph, no network", () => {
    const calls: string[] = [];
    const saved = globalThis.fetch;
    globalThis.fetch = (async (u: string) => (calls.push(String(u)), new Response(""))) as typeof fetch;
    let r;
    try {
      r = scoreGrammar((t: string) => hebrewGrammar(t), probe, heq);
    } finally {
      globalThis.fetch = saved;
    }
    expect(r.items).toBe(200);
    expect(r.recall).toBeGreaterThanOrEqual(0.7);
    expect(r.fpCorrected).toBeLessThanOrEqual(0.05);
    expect(r.realSentences).toBeGreaterThan(1000);
    expect(r.fpRealText).toBeLessThanOrEqual(0.05);
    expect(r.msPerParagraphP95).toBeLessThan(300);
    expect(calls).toEqual([]);
  });
});

describe("the model seam", () => {
  const text = "נפגשתי את דני. קנינו שתי ספרים.";
  const found = () => hebrewGrammar(text);

  it("without a ranker every finding stays; a ranker drops what it rejects", async () => {
    expect(await rankFindings(text, found(), null)).toHaveLength(2);
    const seen: string[] = [];
    const kept = await rankFindings(text, found(), async (o, c) => (seen.push(`${o} → ${c}`), c.includes("עם") ? 0.9 : 0.1));
    expect(kept.map((m) => m.rule.id)).toEqual(["HE_ET_IM"]);
    expect(seen).toEqual(["נפגשתי את דני. → נפגשתי עם דני.", "קנינו שתי ספרים. → קנינו שני ספרים."]);
  });

  it("a failing ranker keeps the finding", async () => {
    expect(await rankFindings(text, found(), async () => Promise.reject(new Error("down")))).toHaveLength(2);
  });

  it("the Ollama ranker talks to this computer only", async () => {
    expect(() => ollamaGrammarRanker("http://192.168.1.5:11434", "dictalm")).toThrow(/this computer/);
    const req: Array<{ url: string; body: { model: string; prompt: string } }> = [];
    const r = ollamaGrammarRanker("http://127.0.0.1:11434", "hf.co/dicta-il/DictaLM-3.0-1.7B-Thinking-GGUF", (async (url: string, init: RequestInit) => {
      req.push({ url, body: JSON.parse(String(init.body)) });
      return new Response(JSON.stringify({ response: "B" }));
    }) as unknown as typeof fetch);
    expect(await r("א", "ב")).toBe(0.9);
    expect(req[0].url).toBe("http://127.0.0.1:11434/api/generate");
    expect(req[0].body.model).toMatch(/DictaLM/);
  });
});
