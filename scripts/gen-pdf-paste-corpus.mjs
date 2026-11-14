#!/usr/bin/env node
/**
 * Builds the test corpus for plan W5.5 (Hebrew pasted from a PDF):
 * src/__tests__/fixtures/pdf-paste/corpus.json.
 *
 * 1. 100 Hebrew lines in the shape of court rulings, articles and forms,
 *    composed from fragments written for this corpus (CC0 1.0), with
 *    numbers, dates, Latin words, URLs, brackets and quotes. Seeded, so a
 *    rebuild writes the same lines.
 * 2. Each line is laid out right to left by Chromium and printed to a real
 *    PDF (Playwright's page.pdf()).
 * 3. The PDF is read back with pdf.js (pdfjs-dist). pdf.js reorders each
 *    right-to-left text item for its own text layer; that one step is
 *    undone, so `visual` is the text in the order its glyphs were drawn,
 *    left to right — what a PDF reader that does not reorder copies.
 * 4. `finals`: the same lines as a PDF with a broken ToUnicode map gives
 *    them: final letters read as regular ones, or the two forms swapped.
 *
 *   node scripts/gen-pdf-paste-corpus.mjs
 *
 * Needs Playwright's Chromium and pdfjs-dist (both dev dependencies).
 */
import { createHash } from "node:crypto";
import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const require = createRequire(import.meta.url);
const OUT = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "__tests__", "fixtures", "pdf-paste", "corpus.json");

function rng(seed) {
  let i = 0;
  return () => createHash("sha256").update(`${seed}\u0000${i++}`).digest().readUInt32BE(0) / 2 ** 32;
}
const pick = (r, list) => list[Math.floor(r() * list.length)];

const RULING = {
  court: ["בית המשפט העליון", "בית המשפט המחוזי בתל אביב", "בית הדין הארצי לעבודה", "בית משפט השלום בחיפה", "ועדת הערר המחוזית", "כב׳ השופטת לוי"],
  holding: ["קבע כי דין הערעור להידחות", "קיבל את העתירה בחלקה", "פסק כי המשיבה הפרה את חובת הזהירות", "קבע שההסכם בטל מעיקרו", "דחה את הבקשה לעיכוב ביצוע", "הורה על השבת הסכום למבקש"],
  ref: ["(ע\"א 1234/20)", "לפי סעיף 12(ב) לחוק החוזים", "בהתאם לתקנה 7 לתקנות", "(בג\"ץ 5678/19, פסקה 14)", "כאמור בעמוד 3 לפסק הדין", "ביום 15.03.2022", "בסך 25,000 ש\"ח", "[ההדגשה במקור]"],
};
const ARTICLE = {
  subject: ["החוקרים", "משרד הבריאות", "הסטודנטים בקורס", "הצוות במעבדה", "הלשכה המרכזית לסטטיסטיקה", "המחברים"],
  verb: ["פרסמו דוח על", "בדקו את", "השוו בין", "מצאו קשר בין", "ניתחו את", "הציגו את"],
  object: ["שיעורי התחלואה", "מודל GPT-4 ומודלים אחרים", "נתוני השכר במשק", "תוצאות הניסוי", "השימוש ב-Python ו-R", "קבצי ה-PDF של הוועדה"],
  tail: ["בשנת 2023", "בקרב 1,200 משתתפים", "בכ-35% מהמקרים", "בין 10:30 ל-12:00", "(ראו טבלה 2)", "באתר gov.il", "לפי Smith et al. (2021)", "עם סטיית תקן של 3.5"],
};
const FORM = [
  ["שם המבקש", "דנה כהן"],
  ["מספר זהות", "012345678"],
  ["תאריך הגשה", "01.02.2024"],
  ["טלפון", "03-1234567"],
  ["כתובת דואר אלקטרוני", "dana@example.com"],
  ["סכום הבקשה", "15,000 ש\"ח"],
  ["מספר תיק", "1234-05-21"],
  ["סוג הבקשה", "הארכת מועד (דחוף)"],
  ["שם החברה", "Lumen Ltd."],
  ["כתובת", "רחוב הרצל 12, תל אביב"],
];
const FORM_NOTE = ["", " [נא לצרף מסמך PDF]", " (שדה חובה)", " - ראו הנחיות בעמוד 2"];

function lines() {
  const out = [];
  for (let n = 0; n < 100; n++) {
    const r = rng(`w5.5:${n}`);
    let line;
    let kind;
    if (n < 35) {
      kind = "ruling";
      line = `${pick(r, RULING.court)} ${pick(r, RULING.holding)} ${pick(r, RULING.ref)}.`;
    } else if (n < 70) {
      kind = "article";
      line = `${pick(r, ARTICLE.subject)} ${pick(r, ARTICLE.verb)} ${pick(r, ARTICLE.object)} ${pick(r, ARTICLE.tail)}.`;
    } else {
      kind = "form";
      const [field, value] = pick(r, FORM);
      line = `${field}: ${value}${pick(r, FORM_NOTE)}`;
    }
    out.push({ id: `pdf-${String(n + 1).padStart(3, "0")}`, kind, logical: line });
  }
  return out;
}

const esc = (s) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");

async function printToPdf(items) {
  const { chromium } = require("playwright");
  const browser = await chromium.launch(process.env.CHROMIUM ? { executablePath: process.env.CHROMIUM } : {});
  try {
    const page = await browser.newPage();
    await page.setContent(`<!doctype html><meta charset="utf-8"><body dir="rtl" style="margin:0;font:11px 'DejaVu Sans',Arial,sans-serif">${items.map((it) => `<p style="margin:0 0 6px;white-space:nowrap">${esc(it.logical)}</p>`).join("")}</body>`);
    return await page.pdf({ width: "1600px", height: "2400px", printBackground: false });
  } finally {
    await browser.close();
  }
}

/** pdf.js text items, line by line, in drawing order (pdf.js's per-item reordering undone). */
async function visualLines(pdf) {
  const pdfjs = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const doc = await pdfjs.getDocument({ data: new Uint8Array(pdf), useSystemFonts: false }).promise;
  const out = [];
  for (let p = 1; p <= doc.numPages; p++) {
    const page = await doc.getPage(p);
    const { items } = await page.getTextContent();
    let line = "";
    for (const it of items) {
      if (!("str" in it)) continue;
      line += it.dir === "rtl" ? Array.from(it.str).reverse().join("") : it.str;
      if (it.hasEOL) {
        out.push(line);
        line = "";
      }
    }
    if (line) out.push(line);
  }
  return out.filter((l) => l.trim());
}

const TO_REGULAR = { ך: "כ", ם: "מ", ן: "נ", ף: "פ", ץ: "צ" };
const TO_FINAL = { כ: "ך", מ: "ם", נ: "ן", פ: "ף", צ: "ץ" };
/**
 * A broken ToUnicode map, one of the two ways it goes wrong: every final
 * letter read as its regular form, or the two forms swapped both ways.
 */
function brokenFinals(line, r) {
  if (r() < 0.5) return { finalsMode: "regular", finals: line.replace(/[ךםןףץ]/g, (c) => TO_REGULAR[c]) };
  return { finalsMode: "swapped", finals: line.replace(/[ךםןףץכמנפצ]/g, (c) => TO_REGULAR[c] ?? TO_FINAL[c]) };
}

const items = lines();
const visual = await visualLines(await printToPdf(items));
if (visual.length !== items.length) throw new Error(`pdf.js read ${visual.length} lines for ${items.length}`);
items.forEach((it, i) => {
  it.visual = visual[i];
  Object.assign(it, brokenFinals(it.logical, rng(`w5.5:finals:${i}`)));
});
mkdirSync(dirname(OUT), { recursive: true });
writeFileSync(
  OUT,
  JSON.stringify(
    {
      about: "Plan W5.5 test corpus (CC0 1.0): 100 Hebrew lines in the shape of court rulings, articles and forms, written for this test; `visual` is each line printed to PDF by Chromium and read back with pdf.js in glyph-drawing order; `finals` simulates a broken ToUnicode map (finals read as regular letters, or the two forms swapped). Built by scripts/gen-pdf-paste-corpus.mjs.",
      items,
    },
    null,
    1,
  ) + "\n",
);
console.log(`wrote ${items.length} items to ${OUT}`);
