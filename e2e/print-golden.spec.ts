import { test, expect } from "@playwright/test";
import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { contentDirection } from "../src/print/printLayout";

/**
 * Plan W2.23 — print and PDF at word-processor level, Hebrew first.
 *
 * Ten golden notes (src/__tests__/fixtures/print) go through the app's real
 * print path (`buildPrintHtml`: render, page breaks, TOC, @page layout) and
 * are then:
 *
 * - compared visually, in print media, with an approved baseline (under 1%
 *   of pixels may differ). The first run writes the baselines
 *   (`--update-snapshots`); a person looks at them once and commits them;
 * - printed to PDF (Chromium, the engine behind "Save as PDF"), and the PDF's
 *   text layer is read back with pdftotext: the Hebrew must come out in
 *   reading order, the page numbers must be there (Hebrew numerals where the
 *   note asks for them), and the fonts must be embedded.
 *
 * pdftotext / pdffonts (poppler) are needed for the PDF half; without them it
 * is skipped, with a note.
 */

const DIR = join(process.cwd(), "src/__tests__/fixtures/print");
const docs = readdirSync(DIR)
  .filter((f) => f.endsWith(".md"))
  .sort();

function hasPoppler(): boolean {
  try {
    execFileSync("pdftotext", ["-v"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

/** Hebrew phrases that must be readable, in order, in each PDF. */
const PHRASES: Record<string, string[]> = {
  "01-hebrew-report.md": ["דוח רבעוני", "זהו טקסט לדוגמה בעברית", "סוף הדוח"],
  "02-long-table.md": ["טבלה ארוכה", "הערה קצרה"],
  "03-toc.md": ["תוכן עניינים", "פרק ראשון", "פרק שני", "Chapter three"],
  "04-footnotes.md": ["טענה ראשונה", "מקור ראשון"],
  "05-callouts.md": ["שימו לב", "הדגשה צהובה"],
  "06-code-math.md": ["קוד נשאר משמאל לימין", "const sum"],
  "07-images.md": ["תמונה ברוחב מלא"],
  "08-page-breaks.md": ["עמוד ראשון", "עמוד שני", "עמוד שלישי"],
  "09-english-letter.md": ["Quarterly memo", "Confidential", "This English document prints left to right"],
  "10-nested-lists.md": ["שלב ראשון", "תת פרט", "משימה שבוצעה"],
};

const PAGES: Record<string, number> = { "08-page-breaks.md": 3 };

/** pdftotext marks direction runs with embedding characters; reading order is what is left. */
const plain = (s: string) => s.replace(/[\u200E\u200F\u202A-\u202E]/g, "").replace(/[ \t]+/g, " ");

test.describe.configure({ mode: "serial" });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await page.waitForFunction(() => typeof (window as unknown as { __lumen?: { buildPrintHtml?: unknown } }).__lumen?.buildPrintHtml === "function", null, { timeout: 20_000 });
});

for (const name of docs) {
  test(`prints ${name}`, async ({ page, context }, info) => {
    const md = readFileSync(join(DIR, name), "utf8");
    const html = await page.evaluate(
      ([m, n]) => (window as unknown as { __lumen: { buildPrintHtml: (m: string, n: string) => Promise<string> } }).__lumen.buildPrintHtml(m, n),
      [md, name.replace(/^\d+-|\.md$/g, "")] as const,
    );
    expect(html).not.toContain("Exported from Lumen");
    expect(html).toContain(`dir="${contentDirection(md)}"`);

    const printPage = await context.newPage();
    // Same origin as the app, so the embedded fonts load.
    await printPage.goto(new URL("/", page.url()).href);
    await printPage.setContent(html, { waitUntil: "load" });
    await printPage.evaluate(() => document.fonts.ready);
    await printPage.emulateMedia({ media: "print" });
    await expect(printPage).toHaveScreenshot(`${name}.png`, { fullPage: true, maxDiffPixelRatio: 0.01 });

    if (!hasPoppler()) {
      info.annotations.push({ type: "skip-pdf", description: "pdftotext not installed" });
      return;
    }
    const pdf = await printPage.pdf({ preferCSSPageSize: true, printBackground: true });
    const dir = mkdtempSync(join(tmpdir(), "lumen-print-"));
    const file = join(dir, `${name}.pdf`);
    writeFileSync(file, pdf);
    const text = plain(execFileSync("pdftotext", [file, "-"]).toString());
    let at = 0;
    for (const p of PHRASES[name] ?? []) {
      const i = text.indexOf(p, at);
      expect(i, `"${p}" readable in order in the PDF`).toBeGreaterThanOrEqual(0);
      at = i;
    }
    if (name === "01-hebrew-report.md") expect(text).toMatch(/א\s*\/\s*[א-ת]/); // Hebrew page numbers
    // "1 / 5": an RTL footer's number run comes out of pdftotext as "5/1".
    else expect(text).toMatch(/\b1\s*\/\s*\d+|\d+\s*\/\s*1\b/);
    const pages = Number(execFileSync("pdfinfo", [file]).toString().match(/Pages:\s+(\d+)/)?.[1] ?? "0");
    if (PAGES[name]) expect(pages).toBe(PAGES[name]);
    const fonts = execFileSync("pdffonts", [file]).toString().split("\n").slice(2).filter(Boolean);
    expect(fonts.length).toBeGreaterThan(0);
    // Columns end with: emb sub uni object ID.
    expect(fonts.filter((l) => / (yes|no) +(yes|no) +(yes|no) +\d+ +\d+\s*$/.exec(l)?.[1] !== "yes"), "every font embedded").toEqual([]);
    await printPage.close();
  });
}
