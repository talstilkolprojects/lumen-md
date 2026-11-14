/**
 * Plan 7.5 — mixed-direction lines in Hebrew OCR (src/ai/ocrMixed.ts): the
 * word boxes tesseract returns are rebuilt into logical order, a Hebrew
 * prefix glued to a Latin word is re-read, and an unsure word after a
 * Hebrew prefix is re-read as Latin. Boxes are synthetic: x grows to the
 * right, a right-to-left line starts at the largest x.
 */
import { describe, it, expect, vi } from "vitest";
import { fixMixedLine, fixMixedText, implausibleHebrew, isLtrWord, needsFix, type Box, type OcrLine, type OcrWord } from "../ai/ocrMixed";

const box = (x0: number, x1: number): Box => ({ x0, x1, y0: 10, y1: 30 });

/** A word whose symbols are spread evenly over [x0, x1], in visual (left-to-right) order. */
function word(text: string, x0: number, x1: number, confidence = 90, symbols?: string[]): OcrWord {
  const syms = symbols ?? [...text];
  const w = (x1 - x0) / syms.length;
  return {
    text,
    bbox: box(x0, x1),
    confidence,
    symbols: syms.map((s, i) => ({ text: s, confidence, bbox: box(Math.round(x0 + i * w), Math.round(x0 + (i + 1) * w)) })),
  };
}

const line = (words: OcrWord[], text = words.map((w) => w.text).join(" ")): OcrLine => ({ text, words });
const noRead = vi.fn(async () => ({ text: "", confidence: 0 }));

describe("isLtrWord", () => {
  it("is decided by the first strong letter, digits alone count as left-to-right", () => {
    expect(isLtrWord("Bluetooth")).toBe(true);
    expect(isLtrWord("ו-Bluetooth")).toBe(false);
    expect(isLtrWord("02-7640916")).toBe(true);
    expect(isLtrWord("שלום")).toBe(false);
    expect(isLtrWord(":")).toBe(false);
  });
});

describe("fixMixedLine", () => {
  it("keeps tesseract's text for a Hebrew-only line and asks no reader", async () => {
    const read = vi.fn(noRead);
    const l = line([word("שלום", 100, 140), word("עולם", 40, 90)], "שלום עולם\n");
    expect(await fixMixedLine(l, read)).toBe("שלום עולם");
    expect(read).not.toHaveBeenCalled();
  });

  it("rebuilds logical order: right to left, a run of LTR words left to right", async () => {
    // Visual, left to right: "Wi-Fi" "Bluetooth" "בדיקת"; the LTR run keeps its left-to-right order after the Hebrew word.
    const l = line([word("Wi-Fi", 10, 60), word("Bluetooth", 70, 160), word("בדיקת", 180, 240)], "בדיקת Wi-Fi Bluetooth");
    expect(await fixMixedLine(l, noRead)).toBe("בדיקת Wi-Fi Bluetooth");
  });

  it("re-reads the glyph after '<Latin>-' as a Hebrew prefix and moves it to the front", async () => {
    // "ו-Bluetooth" read as "Bluetooth-1": visually Bluetooth, '-', then the prefix at the right.
    const w = word("Bluetooth-1", 10, 120, 50, [..."Bluetooth", "-", "1"]);
    const read = vi.fn(async () => ({ text: "ו", confidence: 88 }));
    const l = line([w, word("בדיקת", 140, 200)]);
    expect(await fixMixedLine(l, read)).toBe("בדיקת ו-Bluetooth");
    expect(read).toHaveBeenCalledTimes(1);
  });

  it("reads a bare stroke as ו when the Hebrew pass returns no letter", async () => {
    const w = word("Bluetooth-1", 10, 120, 50, [..."Bluetooth", "-", "1"]);
    const l = line([w, word("בדיקת", 140, 200)]);
    expect(await fixMixedLine(l, async () => ({ text: "[", confidence: 57 }))).toBe("בדיקת ו-Bluetooth");
  });

  it("does not invent a ו for a glyph that is not a bare stroke", async () => {
    const w = word("PDF-A", 10, 60, 50, [..."PDF", "-", "A"]);
    const l = line([w, word("קובץ", 80, 120)]);
    expect(await fixMixedLine(l, async () => ({ text: "", confidence: 0 }))).toBe("קובץ PDF-A");
  });

  it("moves a sentence mark at the visual left of a Latin word to its logical end", async () => {
    const w = word(".Bluetooth-1", 5, 120, 50, [".", ..."Bluetooth", "-", "1"]);
    const l = line([w, word("בדיקת", 140, 200)]);
    expect(await fixMixedLine(l, async () => ({ text: "ו", confidence: 90 }))).toBe("בדיקת ו-Bluetooth.");
  });

  it("takes the Hebrew reading of a short unsure Latin word only when it is surer", async () => {
    const mk = () => line([word("info@example.org", 10, 150), word("IN", 160, 180, 71), word("לפרטים:", 200, 260)]);
    expect(await fixMixedLine(mk(), async () => ({ text: "או", confidence: 96 }))).toBe("לפרטים: או info@example.org");
    expect(await fixMixedLine(mk(), async () => ({ text: "או", confidence: 60 }))).toBe("לפרטים: info@example.org IN");
  });

  it("re-reads an unsure word after a Hebrew prefix as Latin, also on a line with no Latin left", async () => {
    // "ה-PDF" read as "ה-זסץ": visually the tail sits left of the hyphen, the prefix at the right.
    const w = word("ה-זסץ", 100, 160, 27, ["ז", "ס", "ץ", "-", "ה"]);
    const latin = vi.fn(async (b: Box) => ({ text: "PDF-", confidence: 95, b }));
    const l = line([word("מצורף;", 30, 90), w, word("קובץ", 170, 220)], "קובץ ה-זסץ מצורף;\n");
    expect(needsFix(l)).toBe(true);
    expect(await fixMixedLine(l, { heb: noRead, latin })).toBe("קובץ ה-PDF מצורף;");
    // The crop stops short of the hyphen.
    const hyphenX0 = w.symbols[3].bbox.x0;
    expect(latin.mock.calls[0][0].x1).toBeLessThan(hyphenX0);
  });

  it("keeps the word when the Latin reading is unsure, not all letters, or the word was sure", async () => {
    const mk = (conf = 27) => line([word("ה-זסץ", 100, 160, conf, ["ז", "ס", "ץ", "-", "ה"]), word("קובץ", 170, 220)], "קובץ ה-זסץ");
    expect(await fixMixedLine(mk(), { heb: noRead, latin: async () => ({ text: "PDF", confidence: 60 }) })).toBe("קובץ ה-זסץ");
    expect(await fixMixedLine(mk(), { heb: noRead, latin: async () => ({ text: "04.02", confidence: 95 }) })).toBe("קובץ ה-זסץ");
    const latin = vi.fn(async () => ({ text: "PDF", confidence: 95 }));
    expect(await fixMixedLine(mk(91), { heb: noRead, latin })).toBe("קובץ ה-זסץ");
    expect(latin).not.toHaveBeenCalled();
  });

  it("leaves a prefixed date alone", async () => {
    const l = line([word("ל-04.02.2022", 40, 160, 91), word("עד", 170, 200)], "עד ל-04.02.2022");
    expect(needsFix(l)).toBe(false);
    expect(await fixMixedLine(l, { heb: noRead, latin: noRead })).toBe("עד ל-04.02.2022");
  });

  it("without a Latin reader, an unsure prefixed word stays as read", async () => {
    const l = line([word("ה-זסץ", 100, 160, 27, ["ז", "ס", "ץ", "-", "ה"]), word("קובץ", 170, 220)], "קובץ ה-זסץ");
    expect(await fixMixedLine(l, noRead)).toBe("קובץ ה-זסץ");
  });
});

describe("plan W1.18: Latin read as Hebrew shapes, and unsure Latin parts", () => {
  it("implausibleHebrew: digits among Hebrew letters or a final letter inside the word", () => {
    expect(implausibleHebrew("ח01סז6טו8.")).toBe(true);
    expect(implausibleHebrew("זםסץ")).toBe(true);
    expect(implausibleHebrew("זסץ")).toBe(false);
    expect(implausibleHebrew("שלום")).toBe(false);
    expect(implausibleHebrew("2022")).toBe(false);
  });

  it("takes even an unsure all-letters Latin reading when the Hebrew one cannot be a word, and keeps the sentence mark", async () => {
    // "ו-Bluetooth." read as "ו-ח01סז6טו8.": the Latin pass reads the crop as ".Bluetooth" (the period sits at the visual left).
    const syms = ["ו", "-", "ח", "0", "1", "ס", "ז", "6", "ט", "ו", "8", "."].reverse();
    const w = word("ו-ח01סז6טו8.", 27, 176, 64, syms);
    const l = line([w, word("Wi-Fi", 187, 250), word("בדיקת", 260, 337)], "בדיקת Wi-Fi ו-ח01סז6טו8.");
    expect(await fixMixedLine(l, { heb: noRead, latin: async () => ({ text: ".Bluetooth", confidence: 5 }) })).toBe("בדיקת Wi-Fi ו-Bluetooth.");
    // A Latin reading far from the tail's length is not taken.
    expect(await fixMixedLine(l, { heb: noRead, latin: async () => ({ text: "Bt", confidence: 5 }) })).toBe("בדיקת Wi-Fi ו-ח01סז6טו8.");
  });

  it("re-reads the Latin part of an unsure '<Latin>-<prefix>' word, kept only when sure", async () => {
    const mk = () => line([word("PDE-7", 679, 762, 50, [..."PDE", "-", "7"]), word("קובץ", 770, 823)], "קובץ PDE-7");
    const heb = async () => ({ text: "ה", confidence: 93 });
    expect(await fixMixedLine(mk(), { heb, latin: async () => ({ text: "PDF", confidence: 91 }) })).toBe("קובץ ה-PDF");
    expect(await fixMixedLine(mk(), { heb, latin: async () => ({ text: "PDF", confidence: 48 }) })).toBe("קובץ ה-PDE");
    // A sure word is not re-read.
    const latin = vi.fn(async () => ({ text: "PDF", confidence: 99 }));
    const sure = line([word("PDE-7", 679, 762, 90, [..."PDE", "-", "7"]), word("קובץ", 770, 823)], "קובץ PDE-7");
    expect(await fixMixedLine(sure, { heb, latin })).toBe("קובץ ה-PDE");
    expect(latin).not.toHaveBeenCalled();
  });
});

describe("plan W1.18: whole runs and Latin-only lines on a Hebrew page", () => {
  it("puts a prefix before the whole left-to-right run: 'ב-Drive' with 'Google' at its left is 'ב-Google Drive'", async () => {
    const l = line([word("Google", 10, 80), word("ב-Drive", 90, 160, 90, [..."Drive", "-", "ב"]), word("שמרנו", 180, 240)], "שמרנו ב-Drive Google");
    expect(await fixMixedLine(l, noRead)).toBe("שמרנו ב-Google Drive");
  });

  it("on a Hebrew page, a glued prefix is fixed on a line with no Hebrew letter left; not on an English page", async () => {
    const mk = () => line([word(".WhatsApp-2", 10, 140, 60, [".", ..."WhatsApp", "-", "2"])], ".WhatsApp-2");
    const heb = async () => ({ text: "ב", confidence: 90 });
    expect(needsFix(mk(), { hebrewPage: true })).toBe(true);
    expect(await fixMixedLine(mk(), heb, { hebrewPage: true })).toBe("ב-WhatsApp.");
    expect(needsFix(mk())).toBe(false);
    expect(await fixMixedLine(mk(), heb)).toBe(".WhatsApp-2");
  });

  it("symbols that are not a number after a prefix are not a plausible reading", () => {
    expect(implausibleHebrew("50[")).toBe(true);
    expect(implausibleHebrew("04.02.2022")).toBe(false);
    expect(implausibleHebrew("50%")).toBe(false);
  });
});

describe("fixMixedText", () => {
  it("joins the fixed lines with newlines", async () => {
    const a = line([word("שלום", 100, 140)], "שלום\n");
    const b = line([word("Zoom", 10, 60), word("ב-", 70, 90)], "ב- Zoom");
    expect(await fixMixedText([a, b], noRead)).toBe("שלום\nב- Zoom");
  });
});
