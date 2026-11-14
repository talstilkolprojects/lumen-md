import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { makeEpub } from "../src/__tests__/helpers/epubFixture";
import { createPdfAnnotation, upsertAnnotationsNote } from "../src/pdf/annotations";
import { createEpubAnnotation, upsertEpubNote } from "../src/epub/annotations";

/**
 * Plan W1.15 — all highlights in one place. Acceptance: in the export note,
 * every link opens the right page / location (e2e on 20 highlights). The
 * vault gets the 3-page PDF fixture with 12 highlights (pages 1–3) and a
 * 2-chapter EPUB with 8 (chapters 1–2); "All highlights" exports all 20 to a
 * note, and each of its 20 links is followed from the note's preview.
 */

const PDF = readFileSync(new URL("./fixtures/bilingual.pdf", import.meta.url));
const NOW = new Date("2026-11-10T08:00:00Z");
const uuid = (n: number) => `${String(n).padStart(8, "0")}-0000-4000-8000-000000000000`;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

async function put(page: Page, name: string, data: Uint8Array | string): Promise<boolean> {
  const bytes = typeof data === "string" ? Array.from(new TextEncoder().encode(data)) : Array.from(data);
  return page.evaluate(
    async ({ name, bytes }) => {
      try {
        const root = await navigator.storage.getDirectory();
        const fh = await root.getFileHandle(name, { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: Uint8Array): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") return false;
        const w = await h.createWritable();
        await w.write(Uint8Array.from(bytes));
        await w.close();
        return true;
      } catch {
        return false;
      }
    },
    { name, bytes },
  );
}

test("the export note's 20 links each open their highlight's page or chapter", async ({ page }) => {
  test.setTimeout(180_000);
  const text = "Some words on this page that the highlight quotes.";
  const pdf = Array.from({ length: 12 }, (_, i) => createPdfAnnotation({ id: uuid(100 + i), source: "bilingual.pdf", page: (i % 3) + 1, text, start: 0, end: 10, now: NOW }));
  const epub = Array.from({ length: 8 }, (_, i) => createEpubAnnotation({ id: uuid(200 + i), source: "book.epub", chapter: (i % 2) + 1, text, start: 0, end: 10, now: NOW }));
  const ok =
    (await put(page, "bilingual.pdf", new Uint8Array(PDF))) &&
    (await put(page, "bilingual.pdf.md", upsertAnnotationsNote(null, "bilingual.pdf", pdf, { title: "Highlights — bilingual.pdf", page: (n) => `p. ${n}`, empty: "_none_" }))) &&
    (await put(page, "book.epub", await makeEpub({ hebrew: true }))) &&
    (await put(page, "book.epub.md", upsertEpubNote(null, "book.epub", epub, { title: "Highlights — book", chapter: (n) => `ch. ${n}`, empty: "_none_" })));
  test.skip(!ok, "this engine refuses OPFS writes here, so there is no vault");

  await page.keyboard.press(process.platform === "darwin" ? "Meta+k" : "Control+k");
  await page.keyboard.type("All highlights");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("highlights-panel");
  await expect(page.getByTestId("highlights-count")).toContainText("20 of 20", { timeout: 15_000 });
  await page.getByTestId("highlights-export").click();
  await expect(panel).toHaveCount(0);

  const links = page.locator("[data-preview-root] a.wiki-link[data-wiki-target*='highlight=']");
  await expect(links).toHaveCount(20, { timeout: 15_000 });
  const targets = await links.evaluateAll((as) => as.map((a) => a.getAttribute("data-wiki-target")!));
  for (const target of targets) {
    await page.locator(`[data-preview-root] a.wiki-link[data-wiki-target="${target}"]`).click();
    if (target.startsWith("bilingual.pdf#")) {
      const want = /page=(\d+)/.exec(target)![1];
      const reader = page.getByTestId("pdf-reader");
      await expect(reader).toHaveAttribute("data-current-page", want, { timeout: 15_000 });
    } else {
      const want = /chapter=(\d+)/.exec(target)![1];
      const reader = page.getByTestId("epub-reader");
      await expect(reader).toHaveAttribute("data-chapter", want, { timeout: 15_000 });
    }
    await page.keyboard.press("Escape");
    await expect(page.getByTestId("pdf-reader").or(page.getByTestId("epub-reader"))).toHaveCount(0);
  }
});
