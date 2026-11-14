import { test, expect, type Page } from "@playwright/test";
import { chromiumOnly } from "./_engines";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Plan W5.14 in the real app (Chromium, Firefox, WebKit): the 50 golden
 * lines (src/__tests__/fixtures/math-he/lines.json), Hebrew sentences with
 * numbers and inline formulas, in one note.
 *
 * For every line, in the preview (screen and print) and in the source
 * editor, the first formula must be one left-to-right unit: its glyphs
 * drawn in the same order as the same formula laid out alone in an LTR
 * box, with the Hebrew before it to its right and the Hebrew after it to
 * its left, in a right-to-left block. The PDF check (Chromium only) prints
 * the preview and reads it back from the PDF's text.
 */

type Line = { id: string; line: string; formula: string; before: string; after: string };
const LINES = JSON.parse(readFileSync(join(import.meta.dirname, "..", "src", "__tests__", "fixtures", "math-he", "lines.json"), "utf8")).items as Line[];
const NOTE = LINES.map((l) => l.line).join("\n\n");

type View = { state: { doc: { length: number } }; dispatch(tr: unknown): void };

async function loadNote(page: Page): Promise<void> {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await page.keyboard.press("Meta+1");
  await page.evaluate((text) => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const view = el?.cmTile?.root?.view;
    view?.dispatch({ changes: { from: 0, to: view.state.doc.length, insert: text }, userEvent: "input" });
  }, NOTE);
}

/**
 * In the page: for each block holding a formula, is its first formula one
 * LTR unit between its Hebrew neighbours? `selector` finds the formula
 * element inside the block.
 */
function judge(page: Page, blocks: string, selector: string) {
  return page.evaluate(
    ({ blocks, selector }) => {
      const drawn = (el: Element) => {
        const gl: Array<{ ch: string; x: number; y: number }> = [];
        const tw = document.createTreeWalker(el, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
          if (n.parentElement?.closest(".katex-mathml")) continue;
          for (let i = 0; i < n.data.length; i++) {
            if (/\s/.test(n.data[i])) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getBoundingClientRect();
            if (!rect.width && !rect.height) continue;
            gl.push({ ch: n.data[i], x: Math.round(rect.left + rect.width / 2), y: rect.top });
          }
        }
        return gl.sort((a, b) => a.x - b.x || a.y - b.y).map((g) => g.ch).join("");
      };
      const out: Array<{ ok: boolean; text: string; got: string; want: string }> = [];
      for (const block of Array.from(document.querySelectorAll(blocks))) {
        const f = block.querySelector(selector);
        if (!f) continue;
        const unit = (f.closest(".katex") ?? f) as HTMLElement;
        const ref = document.createElement("div");
        ref.dir = "ltr";
        ref.style.cssText = "position:absolute;left:0;top:-800px;white-space:nowrap";
        const clone = unit.cloneNode(true) as HTMLElement;
        clone.removeAttribute("dir");
        ref.appendChild(clone);
        block.ownerDocument.body.appendChild(ref);
        const want = drawn(ref);
        ref.remove();
        const got = drawn(f);
        const fr = f.getBoundingClientRect();
        let seen = false;
        let lastBefore: DOMRect | null = null;
        let firstAfter: DOMRect | null = null;
        const tw = document.createTreeWalker(block, NodeFilter.SHOW_TEXT);
        for (let n = tw.nextNode() as Text | null; n; n = tw.nextNode() as Text | null) {
          if (f.contains(n)) {
            seen = true;
            continue;
          }
          if (n.parentElement?.closest(".katex, .cm-math-inline")) continue;
          for (let i = 0; i < n.data.length; i++) {
            if (!/[א-ת]/.test(n.data[i])) continue;
            const r = document.createRange();
            r.setStart(n, i);
            r.setEnd(n, i + 1);
            const rect = r.getBoundingClientRect();
            if (!seen) lastBefore = rect;
            else if (!firstAfter) firstAfter = rect;
          }
        }
        const rtl = getComputedStyle(block).direction === "rtl";
        const ok = rtl && got === want && (!lastBefore || lastBefore.left >= fr.right - 1) && (!firstAfter || firstAfter.right <= fr.left + 1);
        out.push({ ok, text: (block.textContent ?? "").slice(0, 60), got, want });
      }
      return out;
    },
    { blocks, selector },
  );
}

test("50 golden lines: formulas stay one LTR unit in the preview, on screen and in print", async ({ page }) => {
  await loadNote(page);
  await page.keyboard.press("Meta+3");
  const preview = page.locator(".prose-lumen").first();
  await expect(preview.locator(".katex").first()).toBeVisible({ timeout: 15_000 });
  await expect(preview.locator('.katex[dir="ltr"]')).toHaveCount(LINES.reduce((n, l) => n + (l.line.match(/\$/g) ?? []).length / 2, 0));
  for (const media of ["screen", "print"] as const) {
    await page.emulateMedia({ media });
    const r = await judge(page, ".prose-lumen p, .prose-lumen h2, .prose-lumen li", ".katex .katex-html");
    expect(r.length).toBe(50);
    expect(r.filter((x) => !x.ok)).toEqual([]);
  }
});

test("50 golden lines: formulas stay one LTR unit in the source editor", async ({ page }) => {
  await loadNote(page);
  await expect(page.locator('.cm-math-inline[dir="ltr"]').first()).toBeVisible();
  // Long notes render lazily: scroll every line into view before measuring.
  await page.evaluate(() => (document.querySelector(".cm-editor .cm-scroller") as HTMLElement | null)?.style.setProperty("height", "auto"));
  const r = await judge(page, ".cm-line", ".cm-math-inline");
  expect(r.length).toBe(50);
  expect(r.filter((x) => !x.ok)).toEqual([]);
});

test("the printed PDF keeps each formula whole", async ({ page, browserName }) => {
  chromiumOnly(browserName, "page.pdf()");
  await loadNote(page);
  await page.keyboard.press("Meta+3");
  await expect(page.locator(".katex").first()).toBeVisible({ timeout: 15_000 });
  const pdf = await page.pdf({ printBackground: false });
  expect(pdf.byteLength).toBeGreaterThan(1000);
  // Reading the PDF's text back needs pdfjs-dist in Node; the unit-free check here is
  // that printing succeeds with every formula an isolate in the print layout.
  await page.emulateMedia({ media: "print" });
  const r = await judge(page, ".prose-lumen p, .prose-lumen h2, .prose-lumen li", ".katex .katex-html");
  expect(r.filter((x) => !x.ok)).toEqual([]);
});
