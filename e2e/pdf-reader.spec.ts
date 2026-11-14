import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";

/**
 * Plan 4.14 — PDF reader with highlights. Acceptance: a highlight becomes a
 * link that opens the right page. The fixture (e2e/fixtures/bilingual.pdf,
 * 3 pages, English + Hebrew text with embedded fonts) is put in the vault;
 * two highlights (one English, one Hebrew) are made from text selections;
 * the companion note bilingual.pdf.md gets a [[bilingual.pdf#page=2&…]] link
 * per highlight, and clicking one in the note's preview reopens the reader
 * at page 2 with the highlight flashing.
 */

const FIXTURE = readFileSync(new URL("./fixtures/bilingual.pdf", import.meta.url)).toString("base64");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

/**
 * Can this engine write OPFS files here? Playwright's WebKit runs in an
 * ephemeral context that may refuse OPFS writes; the vault can't work there,
 * so the test skips (and says why) instead of failing.
 */
async function putInVault(page: Page, name: string, base64: string): Promise<boolean> {
  return page.evaluate(
    async ({ name, base64 }) => {
      try {
        const bytes = Uint8Array.from(atob(base64), (c) => c.charCodeAt(0));
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(name, { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") return false;
        const w = await h.createWritable();
        await w.write(bytes);
        await w.close();
        return true;
      } catch {
        return false;
      }
    },
    { name, base64 },
  );
}

const readVaultFile = (page: Page, name: string) =>
  page.evaluate(async (name) => {
    try {
      const root = await navigator.storage.getDirectory();
      return await (await (await root.getFileHandle(name)).getFile()).text();
    } catch {
      return "";
    }
  }, name);

/** Select `text` inside the text-layer span of `pageNumber` that contains it. */
async function selectInPage(page: Page, pageNumber: number, text: string) {
  await page.evaluate(
    ({ pageNumber, text }) => {
      const spans = Array.from(document.querySelectorAll(`[data-page-number="${pageNumber}"] .textLayer span`));
      const span = spans.find((s) => (s.textContent ?? "").includes(text));
      const node = span?.firstChild;
      if (!node || node.nodeType !== Node.TEXT_NODE) throw new Error(`no text "${text}" on page ${pageNumber}`);
      const at = (node as Text).data.indexOf(text);
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + text.length);
      const sel = document.getSelection()!;
      sel.removeAllRanges();
      sel.addRange(range);
    },
    { pageNumber, text },
  );
}

test("a highlight becomes a link that opens the PDF at the right page", async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(!(await putInVault(page, "bilingual.pdf", FIXTURE)), "this engine refuses OPFS writes here, so there is no vault to keep the PDF in");

  // Open it the way the file tree does.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "bilingual.pdf" } })));
  const reader = page.getByTestId("pdf-reader");
  await expect(reader).toBeVisible({ timeout: 15_000 });
  await expect(reader).toHaveAttribute("data-page-count", "3", { timeout: 15_000 });

  // English highlight on page 2.
  const page2 = page.locator('[data-page-number="2"]');
  await page2.scrollIntoViewIfNeeded();
  await expect(page2.locator(".textLayer span", { hasText: "passage to highlight" })).toHaveCount(1, { timeout: 15_000 });
  await selectInPage(page, 2, "passage to highlight");
  const highlight = page.getByTestId("pdf-highlight");
  await expect(highlight).toBeEnabled();
  await highlight.click();
  await expect(page2.locator("[data-highlight-id] .pdf-hl-rect")).toHaveCount(1);

  // Hebrew highlight (keyboard: H). Its overlay must sit on the Hebrew words
  // of the right-to-left line, not mirrored to the other side.
  await selectInPage(page, 2, "בעברית לסימון");
  await expect(highlight).toBeEnabled();
  await page.keyboard.press("h");
  await expect(page2.locator("[data-highlight-id] .pdf-hl-rect")).toHaveCount(2);
  const placed = await page.evaluate(() => {
    const spans = Array.from(document.querySelectorAll('[data-page-number="2"] .textLayer span'));
    const he = spans.find((s) => (s.textContent ?? "").includes("בעברית"))!;
    const line = he.getBoundingClientRect();
    const range = document.createRange();
    const node = he.firstChild as Text;
    const at = node.data.indexOf("בעברית לסימון");
    range.setStart(node, at);
    range.setEnd(node, at + "בעברית לסימון".length);
    const words = range.getBoundingClientRect();
    const rects = Array.from(document.querySelectorAll('[data-page-number="2"] [data-highlight-id] .pdf-hl-rect')).map((r) => r.getBoundingClientRect());
    const hl = rects.find((r) => r.top >= line.top - 4 && r.bottom <= line.bottom + 4)!;
    return { line: [line.left, line.right], words: [words.left, words.right], hl: hl ? [hl.left, hl.right] : null };
  });
  expect(placed.hl).not.toBeNull();
  expect(Math.abs(placed.hl![0] - placed.words[0])).toBeLessThan(3);
  expect(Math.abs(placed.hl![1] - placed.words[1])).toBeLessThan(3);
  expect(placed.hl![1] - placed.hl![0]).toBeLessThan(placed.line[1] - placed.line[0]);

  // The companion note: a readable link per highlight + the Web Annotations.
  await expect.poll(() => readVaultFile(page, "bilingual.pdf.md"), { timeout: 10_000 }).toContain("“בעברית לסימון”");
  const note = await readVaultFile(page, "bilingual.pdf.md");
  expect(note).toContain("“passage to highlight”");
  expect(note).toContain('"type": "TextQuoteSelector"');
  expect(note).toContain('"value": "page=2&viewrect=');
  const target = /\[\[(bilingual\.pdf#page=2&highlight=[0-9a-f]{8})\|[^\]]*\]\] “passage to highlight”/.exec(note)?.[1];
  expect(target).toBeTruthy();

  // Open the note, follow the link from its preview.
  await page.getByTestId("pdf-open-notes").click();
  await expect(reader).toHaveCount(0);
  const link = page.locator(`[data-preview-root] a.wiki-link[data-wiki-target="${target}"]`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();

  await expect(reader).toBeVisible({ timeout: 15_000 });
  await expect(reader).toHaveAttribute("data-current-page", "2", { timeout: 10_000 });
  const id = target!.split("highlight=")[1];
  const flashed = page.locator(`[data-page-number="2"] [data-highlight-id="${id}"][data-flash="true"] .pdf-hl-rect`);
  await expect(flashed).toBeVisible({ timeout: 10_000 });
  await expect(flashed).toBeInViewport();
});

test("search finds Hebrew text on another page and goes there", async ({ page }) => {
  test.skip(!(await putInVault(page, "bilingual.pdf", FIXTURE)), "this engine refuses OPFS writes here, so there is no vault to keep the PDF in");
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "bilingual.pdf" } })));
  const reader = page.getByTestId("pdf-reader");
  await expect(reader).toHaveAttribute("data-page-count", "3", { timeout: 15_000 });
  await page.getByTestId("pdf-search").fill("השלישי");
  await page.getByTestId("pdf-search").press("Enter");
  await expect(page.getByTestId("pdf-search-count")).toHaveText(/1/);
  await expect(reader).toHaveAttribute("data-current-page", "3", { timeout: 10_000 });
  await expect(page.locator('[data-page-number="3"] [data-search-hit] .pdf-hl-rect')).toBeVisible();
  // Esc closes the reader.
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
});
