import { test, expect, type Page } from "@playwright/test";
import { fileURLToPath } from "node:url";

/**
 * Plan W2.15 — import highlights in the app: the golden Kindle, Readwise and
 * Kobo files through the palette command, one note per book under
 * Highlights/, the same count again with nothing new on the second import,
 * the imported highlights in "All highlights", and no request off this
 * origin. (Zotero needs the desktop app; in the browser it says so.)
 */

const fixture = (name: string) => fileURLToPath(new URL(`../src/__tests__/fixtures/highlight-import/${name}`, import.meta.url));
const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

async function importFrom(page: Page, source: string, file: string) {
  await run(page, "highlights.import");
  const pick = page.getByRole("combobox", { name: "Import highlights from…" });
  await pick.selectOption(source);
  const chooser = page.waitForEvent("filechooser");
  await pick.press("Enter");
  await (await chooser).setFiles(fixture(file));
}

const notes = (page: Page) =>
  page.evaluate(async () => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("Highlights");
      const out: string[] = [];
      for await (const [name] of (dir as unknown as { entries(): AsyncIterable<[string, unknown]> }).entries()) out.push(name);
      return out.sort();
    } catch {
      return null;
    }
  });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("Kindle, Readwise and Kobo files: one note per book; importing again adds nothing; all offline", async ({ page, baseURL }) => {
  const origin = new URL(baseURL ?? page.url()).origin;
  const off: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin && !["data:", "blob:"].includes(u.protocol)) off.push(r.url());
  });
  await importFrom(page, "kindle", "My Clippings.txt");
  await expect(page.getByText(/Highlights imported: 7 new, 0 updated, 0 already there, in 4 notes/)).toBeVisible({ timeout: 15_000 });
  const first = await notes(page);
  test.skip(first === null, "this engine refuses OPFS, so there is no vault");
  expect(first).toContain("קיצור תולדות האנושות — יובל נח הררי.md");

  await importFrom(page, "readwise", "readwise.csv");
  await expect(page.getByText(/Highlights imported: 3 new, 0 updated, 1 already there/)).toBeVisible({ timeout: 15_000 });
  await importFrom(page, "kobo", "KoboReader.sqlite");
  await expect(page.getByText(/Highlights imported: 4 new, 0 updated, 0 already there, in 2 notes/)).toBeVisible({ timeout: 20_000 });

  await importFrom(page, "kindle", "My Clippings.txt");
  await expect(page.getByText(/Highlights imported: 0 new, 0 updated, 7 already there, in 4 notes/)).toBeVisible({ timeout: 15_000 });

  await run(page, "view.highlights");
  const panel = page.getByTestId("highlights-panel");
  await expect(panel).toBeVisible();
  await panel.getByRole("combobox", { name: "Kind" }).selectOption("import");
  await expect(panel.getByTestId("highlight-item")).toHaveCount(14);
  await panel.getByTestId("highlights-search").fill("בראשית");
  await expect(panel.getByTestId("highlight-item")).toHaveCount(1);
  expect(off).toEqual([]);
});

test("Zotero in the browser: explains that it needs the desktop app", async ({ page }) => {
  await run(page, "highlights.import");
  const pick = page.getByRole("combobox", { name: "Import highlights from…" });
  await pick.selectOption("zotero");
  await pick.press("Enter");
  await expect(page.getByText(/Zotero only answers apps on this computer/)).toBeVisible();
});
