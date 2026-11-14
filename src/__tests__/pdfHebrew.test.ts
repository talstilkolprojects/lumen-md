/**
 * Plan W5.5: Hebrew pasted from a PDF — reversed (visual order) and broken
 * final letters are detected and fixed; correct Hebrew is never touched.
 *
 * The corpus (fixtures/pdf-paste/corpus.json) is 100 lines printed to a
 * real PDF by Chromium and read back with pdf.js in glyph-drawing order
 * (scripts/gen-pdf-paste-corpus.mjs). The controls are the same 100 lines
 * as written, plus Hebrew prose from the app's own Hebrew welcome note.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { analyzePdfHebrew, fixFinalForms, fixVisualLine, fixVisualText, suggestPdfHebrewFix } from "../paste/pdfHebrew";

interface Item {
  id: string;
  kind: string;
  logical: string;
  visual: string;
  finals: string;
  finalsMode: "regular" | "swapped";
}

const CORPUS: Item[] = JSON.parse(readFileSync(join(__dirname, "fixtures", "pdf-paste", "corpus.json"), "utf8")).items;

/** Hebrew prose that reads correctly: the paragraphs of the Hebrew welcome note. */
function welcomeParagraphs(): string[] {
  const src = readFileSync(join(__dirname, "..", "welcome.he.ts"), "utf8");
  return src
    .split("\n")
    .map((l) => l.trim())
    .filter((l) => /[א-ת]{3}/.test(l) && !l.startsWith("//") && !l.startsWith("*") && !l.includes("${"));
}

describe("reversed Hebrew from a PDF (100 lines)", () => {
  it("has 100 lines: rulings, articles and forms", () => {
    expect(CORPUS.length).toBe(100);
    expect(new Set(CORPUS.map((c) => c.kind))).toEqual(new Set(["ruling", "article", "form"]));
    for (const c of CORPUS) expect(c.visual).not.toBe(c.logical);
  });

  it("detects and fixes at least 95 of 100 exactly", () => {
    let right = 0;
    for (const c of CORPUS) {
      const s = suggestPdfHebrewFix(c.visual);
      if (s?.kind === "reversed" && s.fixed === c.logical) right++;
      else console.log("miss", c.id, JSON.stringify(c.visual), "→", JSON.stringify(s?.fixed ?? null));
    }
    console.log(`reversed lines fixed: ${right}/100`);
    expect(right).toBeGreaterThanOrEqual(95);
  });

  it("fixes a pasted block of several lines, keeping the line order", () => {
    const block = CORPUS.slice(0, 10);
    const s = suggestPdfHebrewFix(block.map((c) => c.visual).join("\n"));
    expect(s?.kind).toBe("reversed");
    expect(s?.fixed).toBe(block.map((c) => c.logical).join("\n"));
  });

  it("keeps numbers, Latin runs and brackets the right way round", () => {
    expect(fixVisualLine("2024 תנשב PDF-ה ץבוק")).toBe("קובץ ה-PDF בשנת 2024");
    expect(fixVisualLine(".(2 הלבט ואר) Microsoft Word לש הסרג")).toBe("גרסה של Microsoft Word (ראו טבלה 2).");
    expect(fixVisualLine("12:00 - 10:30 ןיב")).toBe("בין 10:30 - 12:00");
    expect(fixVisualLine("Only English here")).toBe("Only English here");
  });
});

describe("broken final letters", () => {
  // The one thing the fix cannot know: the last letter of an acronym (בג״ץ) stays as written.
  const sameButAcronyms = (fixed: string, logical: string) => fixed.replace(/בג"צ/g, 'בג"ץ') === logical;

  it("swapped finals (a final letter inside a word): found and fixed in at least 45 of 47 lines", () => {
    const lines = CORPUS.filter((c) => c.finalsMode === "swapped" && c.finals !== c.logical);
    const fixed = lines.filter((c) => {
      const s = suggestPdfHebrewFix(c.finals);
      return s?.kind === "finals" && sameButAcronyms(s.fixed, c.logical);
    });
    console.log(`swapped finals fixed: ${fixed.length}/${lines.length}`);
    expect(fixed.length).toBeGreaterThanOrEqual(lines.length - 2);
  });

  it("finals read as regular letters: every suggestion is right; one odd word alone (a loanword?) is left alone", () => {
    const lines = CORPUS.filter((c) => c.finalsMode === "regular" && c.finals !== c.logical);
    let offered = 0;
    for (const c of lines) {
      const s = suggestPdfHebrewFix(c.finals);
      if (!s) continue;
      offered++;
      expect({ id: c.id, ok: s.kind === "finals" && sameButAcronyms(s.fixed, c.logical) }).toEqual({ id: c.id, ok: true });
    }
    console.log(`regular-letter finals offered and fixed: ${offered}/${lines.length}`);
    expect(offered).toBeGreaterThanOrEqual(Math.floor(lines.length * 0.6));
  });

  it("leaves acronyms and quoted words alone, regular letters before a hyphen", () => {
    expect(fixFinalForms("מ״מ ע\"מ צה\"ל שלומ בך-35%")).toBe("מ״מ ע\"מ צה\"ל שלום בכ-35%");
  });
});

describe("correct Hebrew is never changed", () => {
  it("the 100 lines as written: 0 suggestions", () => {
    const flagged = CORPUS.filter((c) => suggestPdfHebrewFix(c.logical) !== null).map((c) => c.id);
    expect(flagged).toEqual([]);
  });

  it("Hebrew prose from the welcome note: 0 suggestions", () => {
    const paras = welcomeParagraphs();
    expect(paras.length).toBeGreaterThan(30);
    const flagged = paras.filter((p) => suggestPdfHebrewFix(p) !== null);
    expect(flagged).toEqual([]);
  });

  it("every Hebrew string of the app's interface: 0 suggestions", () => {
    const he = JSON.parse(readFileSync(join(__dirname, "..", "i18n", "locales", "he.json"), "utf8")) as Record<string, string>;
    const strings = Object.values(he).filter((v) => typeof v === "string" && /[\u05d0-\u05ea]{2}/.test(v));
    expect(strings.length).toBeGreaterThan(1400);
    expect(strings.filter((v) => suggestPdfHebrewFix(v) !== null)).toEqual([]);
  });

  it("short, odd and mixed text: 0 suggestions", () => {
    for (const s of ["שלום", "כן", "ok", "10:30", "שלום world", "PDF", "ראו עמ׳ 3", "מ״מ", "גוגל Google", "1. סעיף ראשון", "- [ ] משימה", "אני בא", "תא קולי", "אל תשכח", "דע מה", "קר היום"]) expect({ s, r: suggestPdfHebrewFix(s) }).toEqual({ s, r: null });
  });

  it("explains its decision", () => {
    expect(analyzePdfHebrew("םולש").kind).toBe("reversed");
    expect(analyzePdfHebrew("שלום").kind).toBe(null);
    expect(fixVisualText("םולש\nםלוע")).toBe("שלום\nעולם");
  });
});
