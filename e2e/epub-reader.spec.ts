import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";
import { makeEpub } from "../src/__tests__/helpers/epubFixture";

/**
 * Plan W1.14 — EPUB reader. Acceptance: a highlight in an EPUB opens at the
 * right place after closing and reopening, and the reader makes no network
 * request. A small Hebrew EPUB 3 book (two chapters, an embedded font and
 * image, a remote image and stylesheet that must not be fetched) is put in
 * the vault, a selection is highlighted, the reader is closed, and the link
 * in `<book>.epub.md` reopens it at chapter 1 with the highlight flashing.
 *
 * Golden books (acceptance 1: 10 EPUBs, 5 Hebrew, open < 2 s, TOC right):
 * set LUMEN_EPUB_GOLDEN to a folder of .epub files and the second test opens
 * each one; without it the test is skipped (the books are not in the repo).
 */

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

async function putInVault(page: Page, name: string, bytes: Uint8Array): Promise<boolean> {
  return page.evaluate(
    async ({ name, data }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(name, { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") return false;
        const w = await h.createWritable();
        await w.write(Uint8Array.from(data));
        await w.close();
        return true;
      } catch {
        return false;
      }
    },
    { name, data: Array.from(bytes) },
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

test("an EPUB highlight reopens at the right place, and the reader fetches nothing", async ({ page, browserName }) => {
  test.setTimeout(60_000);
  vaultOrSkip(await putInVault(page, "book.epub", await makeEpub({ hebrew: true, deflate: true })), browserName);
  const outside: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (!["localhost", "127.0.0.1"].includes(u.hostname) && !u.protocol.startsWith("data") && !u.protocol.startsWith("blob")) outside.push(r.url());
  });

  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path: "book.epub" } })));
  const reader = page.getByTestId("epub-reader");
  await expect(reader).toHaveAttribute("data-chapter", "1", { timeout: 15_000 });
  await expect(reader).toHaveAttribute("data-chapter-count", "2");
  const chapter = reader.locator(".epub-chapter[dir]");
  await expect(chapter).toHaveAttribute("dir", "rtl");

  await page.evaluate(() => {
    const p = document.querySelector(".epub-chapter p")!;
    const node = p.firstChild as Text;
    const at = node.data.indexOf("משפט ראשון");
    const range = document.createRange();
    range.setStart(node, at);
    range.setEnd(node, at + "משפט ראשון".length);
    document.getSelection()!.removeAllRanges();
    document.getSelection()!.addRange(range);
  });
  await expect(page.getByTestId("epub-highlight")).toBeEnabled();
  await page.keyboard.press("h");
  await expect(reader.locator("mark.epub-hl")).toHaveText("משפט ראשון");

  await expect.poll(() => readVaultFile(page, "book.epub.md"), { timeout: 10_000 }).toContain("“משפט ראשון”");
  const note = await readVaultFile(page, "book.epub.md");
  const target = /\[\[(book\.epub#chapter=1&highlight=[0-9a-f]{8})\|/.exec(note)?.[1];
  expect(target).toBeTruthy();

  // Move on, then close: the next open resumes at chapter 2, the link goes back to 1.
  await page.getByTestId("epub-next").click();
  await expect(reader).toHaveAttribute("data-chapter", "2");
  await page.getByTestId("epub-open-notes").click();
  await expect(reader).toHaveCount(0);
  const link = page.locator(`[data-preview-root] a.wiki-link[data-wiki-target="${target}"]`);
  await expect(link).toBeVisible({ timeout: 15_000 });
  await link.click();
  await expect(reader).toHaveAttribute("data-chapter", "1", { timeout: 15_000 });
  const id = target!.split("highlight=")[1];
  await expect(reader.locator(`mark[data-highlight="${id}"].epub-hl-flash`)).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Escape");
  await expect(reader).toHaveCount(0);
  expect(outside).toEqual([]);
});

test("golden EPUBs open in under 2 s with a table of contents (LUMEN_EPUB_GOLDEN)", async ({ page }) => {
  const dir = process.env.LUMEN_EPUB_GOLDEN;
  // skip-reason: an opt-in measurement over golden EPUB books that are not in the repo (set LUMEN_EPUB_GOLDEN) | task: W1.14 | until: 2027-05-12
  test.skip(!dir, "set LUMEN_EPUB_GOLDEN to a folder of golden .epub files");
  test.setTimeout(10 * 60_000);
  const { readdirSync, readFileSync } = await import("node:fs");
  const { join } = await import("node:path");
  const books = readdirSync(dir!).filter((f) => f.endsWith(".epub"));
  expect(books.length).toBeGreaterThan(0);
  const results: Array<{ book: string; ms: number; chapters: number }> = [];
  for (const [i, f] of books.entries()) {
    const name = `golden-${i}.epub`;
    expect(await putInVault(page, name, new Uint8Array(readFileSync(join(dir!, f))))).toBe(true);
    const t0 = Date.now();
    await page.evaluate((path) => window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } })), name);
    const reader = page.getByTestId("epub-reader");
    await expect(reader).toHaveAttribute("data-chapter", /\d+/, { timeout: 15_000 });
    const ms = Date.now() - t0;
    await reader.getByRole("button", { name: /Contents|תוכן/ }).click();
    const entries = await reader.locator(".epub-toc button").count();
    results.push({ book: f, ms, chapters: Number(await reader.getAttribute("data-chapter-count")) });
    console.log(`[W1.14] ${f}: opened in ${ms} ms, ${entries} TOC entries`);
    expect(ms, f).toBeLessThan(2000);
    expect(entries, f).toBeGreaterThan(0);
    await page.keyboard.press("Escape");
    await expect(reader).toHaveCount(0);
  }
  console.log(`[W1.14] golden: ${JSON.stringify(results)}`);
});
