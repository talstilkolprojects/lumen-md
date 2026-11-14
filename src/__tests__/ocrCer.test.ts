/**
 * Plan 7.5 — the CER computation behind the OCR measurement in CI
 * (e2e/ocr-cer.spec.ts). Grapheme clusters, Hebrew final letters, nikud
 * removed for the gated metric and kept for the reported one, Hebrew and
 * English separately.
 */
import { describe, it, expect } from "vitest";
import {
  OCR_CER_GATES,
  type CerItemInput,
  alignEdits,
  buildReport,
  cer,
  checkGates,
  formatReport,
  graphemes,
  heldOutGaps,
  levenshtein,
  measureItem,
  normalizeForCer,
  scriptOf,
} from "../ai/ocrCer";

const SHALOM = "שָׁלוֹם"; // ש + qamats + shin dot, ל, ו + holam, ם

describe("graphemes and Levenshtein", () => {
  it("a letter with its points is one grapheme", () => {
    expect(graphemes(SHALOM)).toHaveLength(4);
    expect(graphemes("שלום")).toEqual(["ש", "ל", "ו", "ם"]);
  });

  it("counts insertions, deletions and substitutions", () => {
    expect(levenshtein([..."kitten"], [..."sitting"])).toBe(3);
    expect(levenshtein([], [..."abc"])).toBe(3);
    expect(levenshtein([..."abc"], [])).toBe(3);
    expect(levenshtein([..."abc"], [..."abc"])).toBe(0);
  });

  it("works on graphemes, not code points: a wrong point is one substitution", () => {
    expect(levenshtein(graphemes("בַּיִת"), graphemes("בָּיִת"))).toBe(1);
    // a missing point: still one grapheme substituted
    expect(levenshtein(graphemes("בַּיִת"), graphemes("ביִת"))).toBe(1);
  });

  it("alignEdits finds as many edits as levenshtein", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    const alphabet = ["א", "ב", "ם", "מ", "a", "b", " ", "1"];
    const word = () => Array.from({ length: Math.floor(rnd() * 12) }, () => alphabet[Math.floor(rnd() * alphabet.length)] ?? "א");
    for (let k = 0; k < 200; k++) {
      const a = word();
      const b = word();
      expect(alignEdits(a, b)).toHaveLength(levenshtein(a, b));
    }
  });
});

describe("normalizeForCer", () => {
  it("keeps Hebrew final letters distinct from their medial forms", () => {
    expect(normalizeForCer("שלום")).not.toBe(normalizeForCer("שלומ"));
    const m = measureItem("שלום", "שלומ");
    expect(m.he).toEqual({ edits: 1, length: 4, items: 1 });
    for (const [fin, med] of [["ך", "כ"], ["ם", "מ"], ["ן", "נ"], ["ף", "פ"], ["ץ", "צ"]] as const) {
      expect(measureItem(`א${fin}`, `א${med}`).he.edits).toBe(1);
    }
  });

  it("strips nikud and cantillation only when asked", () => {
    expect(normalizeForCer(SHALOM, { stripNikud: true })).toBe("שלום");
    expect(normalizeForCer(SHALOM)).not.toBe("שלום");
    expect(normalizeForCer("בְּרֵאשִׁ֖ית", { stripNikud: true })).toBe("בראשית");
    // maqaf is punctuation, not a point: folded to "-", never dropped
    expect(normalizeForCer("אחד־העם", { stripNikud: true })).toBe("אחד-העם");
  });

  it("ignores the order of points and precomposed presentation forms", () => {
    const qamatsFirst = "שָׁ";
    const shinDotFirst = "שָׁ";
    expect(normalizeForCer(qamatsFirst)).toBe(normalizeForCer(shinDotFirst));
    expect(normalizeForCer("שׁ")).toBe(normalizeForCer("שׁ"));
  });

  it("removes bidi controls and collapses white space and line breaks", () => {
    expect(normalizeForCer("‏קובץ ‎PDF‏  מצורף\n\nגרסה ")).toBe("קובץ PDF מצורף גרסה");
  });

  it("folds typographic variants of quotes and dashes", () => {
    expect(normalizeForCer("סה״כ מס׳ “x” – y")).toBe(normalizeForCer('סה"כ מס\' "x" - y'));
  });
});

describe("measureItem", () => {
  it("the gated metrics ignore nikud; the nikud metric counts each pointed letter", () => {
    const m = measureItem("שָׁלוֹם עוֹלָם", "שלום עולם");
    expect(m.all.edits).toBe(0);
    expect(m.he).toEqual({ edits: 0, length: 8, items: 1 });
    expect(m.allNikud).toEqual({ edits: 4, length: 9, items: 1 });
  });

  it("charges an English word read as Hebrew shapes to English", () => {
    const m = measureItem("בדיקת Bluetooth", "בדיקת ח01סז6טו8");
    expect(m.en).toEqual({ edits: 9, length: 9, items: 1 });
    expect(m.he).toEqual({ edits: 0, length: 5, items: 1 });
  });

  it("charges Latin noise inside a Hebrew sentence to Hebrew, and English does not count the item", () => {
    const m = measureItem("שלום עולם", "שלום OY עולם");
    expect(m.he).toEqual({ edits: 3, length: 8, items: 1 });
    expect(m.en).toEqual({ edits: 0, length: 0, items: 0 });
  });

  it("digits and punctuation belong to neither script", () => {
    const m = measureItem("טלפון 02-5509979", "טלפון 02-5509970");
    expect(m.he.edits).toBe(0);
    expect(m.en.items).toBe(0);
    expect(m.all.edits).toBe(1);
    expect(scriptOf("7")).toBeNull();
    expect(scriptOf("א")).toBe("he");
    expect(scriptOf("Q")).toBe("en");
  });

  it("an empty OCR result is every reference grapheme deleted", () => {
    const m = measureItem("שלום world", "");
    expect(m.he).toEqual({ edits: 4, length: 4, items: 1 });
    expect(m.en).toEqual({ edits: 5, length: 5, items: 1 });
    expect(m.all).toEqual({ edits: 10, length: 10, items: 1 });
  });
});

describe("report and gates", () => {
  it("corpus CER is total edits over total reference length, not a mean of rates", () => {
    const r = buildReport([
      { id: "a", condition: "clean", reference: "אבגדהוזחטי", hypothesis: "אבגדהוזחטי" },
      { id: "b", condition: "clean", reference: "אב", hypothesis: "אג" },
    ]);
    expect(cer(r.byCondition.clean.he)).toBeCloseTo(1 / 12, 10);
    expect(r.byCondition.clean.he.items).toBe(2);
  });

  it("gates Hebrew and English separately per condition; nikud lines are not gated", () => {
    const twenty = "אבגדהוזחטיכלמנסעפצקר";
    const r = buildReport([
      { id: "c", condition: "clean", reference: twenty, hypothesis: `ש${twenty.slice(1)}` }, // 1/20 = 5%: passes
      { id: "c2", condition: "clean", reference: "abcdefghij", hypothesis: "abcdefghiX" }, // 10%: fails
      { id: "d", condition: "degraded", reference: twenty, hypothesis: "" }, // 100%: fails
      { id: "n", condition: "nikud", reference: SHALOM, hypothesis: "" },
    ]);
    const g = checkGates(r);
    const v = (c: string, s: string) => g.find((x) => x.condition === c && x.script === s)?.verdict;
    expect(OCR_CER_GATES).toEqual({ clean: 0.05, degraded: 0.12 });
    expect(v("clean", "he")).toBe("pass");
    expect(v("clean", "en")).toBe("fail");
    expect(v("degraded", "he")).toBe("fail");
    expect(v("degraded", "en")).toBe("none");
    expect(g.some((x) => (x.condition as string) === "nikud")).toBe(false);
    expect(cer(r.byCondition.nikud.allNikud)).toBe(1);
  });

  it("formats a table with each condition and the gate verdicts", () => {
    const r = buildReport([{ id: "c", condition: "clean", reference: "שלום world", hypothesis: "שלום world" }]);
    const md = formatReport(r, "dev split");
    expect(md).toContain("### dev split");
    expect(md).toMatch(/\| clean \| 0\.00% · 0\/4 in 1 \(≤ 5%: PASS\) \| 0\.00% · 0\/5 in 1 \(≤ 5%: PASS\)/);
    expect(md).toMatch(/\| degraded \| — · 0\/0 in 0 \(≤ 12%: no text\)/);
    expect(md).toMatch(/\| nikud \| .*\(reported only\)/);
  });

  it("reports the owner's photos as their own condition, ungated", () => {
    const r = buildReport([
      { id: "owner-1", condition: "photo", reference: "שלום עולם", hypothesis: "שלומ עולם" },
      { id: "c", condition: "clean", reference: "שלום", hypothesis: "שלום" },
    ]);
    expect(r.byCondition.photo.he).toEqual({ edits: 1, length: 8, items: 1 });
    expect(checkGates(r).some((g) => (g.condition as string) === "photo")).toBe(false);
    expect(formatReport(r, "t")).toMatch(/\| photo \| 12\.50% · 1\/8 in 1 \(reported only\)/);
  });

  it("throws on an item of an unknown condition instead of dropping it", () => {
    const bad = { id: "x", condition: "scan", reference: "א", hypothesis: "א" } as unknown as CerItemInput;
    expect(() => buildReport([bad])).toThrow(/unknown condition "scan"/);
  });
});

describe("heldOutGaps", () => {
  it("is empty only for a complete, recorded split", () => {
    expect(heldOutGaps([], [])).toEqual([]);
  });

  it("names every short part and every part without a recorded sha256", () => {
    const g = heldOutGaps([{ part: "owner", have: 0, want: 15 }, { part: "pages", have: 9, want: 11 }], ["lines"]);
    expect(g).toHaveLength(3);
    expect(g[0]).toBe("part owner: 0 of 15 test items");
    expect(g[1]).toBe("part pages: 9 of 11 test items");
    expect(g[2]).toMatch(/^part lines: no recorded sha256/);
  });

  it("on the record run an unrecorded part is not a gap — the hashes are being recorded by that run — but a short part still is (Codex P1, #278)", () => {
    expect(heldOutGaps([], ["lines", "pages"], { recordRun: true })).toEqual([]);
    expect(heldOutGaps([{ part: "owner", have: 0, want: 15 }], ["lines"], { recordRun: true })).toEqual(["part owner: 0 of 15 test items"]);
    expect(heldOutGaps([], ["lines"], { recordRun: false })).toHaveLength(1);
  });
});
