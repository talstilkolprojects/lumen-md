/**
 * Plan 2.6 acceptance on the PII golden set (7.1). The dev split is
 * scored here; the held-out test split (187 items) only in CI by
 * scripts/golden/evals/ner-pii.mjs with the same functions.
 *
 * The 100 hard negatives: the dev split has 13. The set's own generator
 * (makePii, the same templates, Faker lists replaced by fixed ones) makes
 * the other look-alikes: 1000 hard negatives and 2000 positives, so
 * "≤ 2 false redactions on 100 hard negatives" is checked on ten times
 * that, and pattern recall on ~1900 entities.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { findPii } from "../ai/pii";
// @ts-expect-error the harness is plain JavaScript
import { scoreWith } from "../../scripts/golden/evals/ner-pii.mjs";
// @ts-expect-error the set builder is plain JavaScript
import { makePii } from "../../scripts/golden/sets/pii.mjs";

const dir = join(__dirname, "../../eval/golden/ner-pii/dev");
const synthetic = JSON.parse(readFileSync(join(dir, "synthetic.json"), "utf8")).items.map((x: object) => ({ ...x, part: "synthetic" }));
const iahlt = JSON.parse(readFileSync(join(dir, "iahltwiki.json"), "utf8")).items.map((x: object) => ({ ...x, part: "iahltwiki" }));
const find = (text: string) => findPii(text);

type Scores = Record<string, number>;

describe("PII redaction on the golden set (plan 2.6)", () => {
  it("dev split, patterns: recall ≥ 98%, precision ≥ 95%, no false redaction on the hard negatives", async () => {
    const s: Scores = await scoreWith(find, synthetic);
    expect(s["recall.patterns"]).toBeGreaterThanOrEqual(0.98);
    expect(s["precision.patterns"]).toBeGreaterThanOrEqual(0.95);
    expect(s.negatives).toBe(13);
    expect(s["falseRedactions.negatives"]).toBeLessThanOrEqual(0);
  });

  it("IAHLTwiki (real Hebrew prose): patterns alone redact nothing that is not a name", async () => {
    let extra = 0;
    for (const it of iahlt) extra += (await findPii(it.text)).length;
    expect(extra).toBe(0);
  });

  it("generated look-alikes: ≤ 2 false redactions per 100 hard negatives; pattern recall ≥ 98% (3000 items)", async () => {
    const first = ["נועה", "דנה", "יוסי", "אבי", "מיכל", "רון", "שירה", "תמר", "עומר", "איתי", "גל", "ליה", "נועם", "הדר", "עדי", "טל", "שני", "אורי", "יעל", "דור", "רוני", "עמית", "אלון", "מאיה", "ליאור", "עידו", "נגה", "שקד", "בר", "אגם"];
    const lists = { first: { f: first, m: first, n: first }, last: ["כהן", "לוי", "מזרחי", "פרץ", "ביטון", "אזולאי"], cities: ["חיפה", "ירושלים", "אילת", "צפת"], streets: ["הרצל", "ויצמן", "בן גוריון", "הנביאים"] };
    const items = [];
    for (let i = 0; i < 3000; i++) items.push({ ...makePii(lists, `${i < 2000 ? "pos" : "neg"}-${String(i).padStart(4, "0")}`, `pii-stress-${i % 5}`), part: "synthetic" });
    const s: Scores = await scoreWith(find, items);
    expect(s.negatives).toBe(1000);
    expect(s["falseRedactions.negatives"] / (s.negatives / 100)).toBeLessThanOrEqual(2);
    expect(s["recall.patterns"]).toBeGreaterThanOrEqual(0.98);
    expect(s["precision.patterns"]).toBeGreaterThanOrEqual(0.95);
  });

  it("names: with a NER (here a stand-in that returns the labels) the PERSON recall is what the model gives; without it, patterns only", async () => {
    // The real model (DictaBERT-NER) cannot be downloaded until 15.9: measured in the browser then.
    const withNer = await scoreWith(
      (text: string) => findPii(text, { ner: async (t) => (synthetic.find((x: { text: string }) => x.text === t)?.entities ?? []).filter((e: { type: string }) => e.type === "PERSON") }),
      synthetic,
    );
    expect(withNer["recall.names"]).toBe(1);
    const without = await scoreWith(find, synthetic);
    expect(without["recall.names"]).toBe(0);
  });
});
