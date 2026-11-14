import { test, expect, type Page } from "@playwright/test";
import { keepExport, notionExport } from "../src/__tests__/fixtures/import/exports";

/**
 * The import wizard (plan W1.26): from the command palette, pick the
 * source and its export, see what will come in, import into a new folder,
 * and undo it — the vault is as it was.
 */

async function opfsWritable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const probe = (await root.getFileHandle("__probe", { create: true })) as FileSystemFileHandle & { createWritable?: unknown };
      await root.removeEntry("__probe");
      return typeof probe.createWritable === "function";
    } catch {
      return false;
    }
  });
}

async function readFile(page: Page, path: string): Promise<string | null> {
  return page.evaluate(async (p) => {
    try {
      const parts = p.split("/");
      const name = parts.pop()!;
      let dir = await navigator.storage.getDirectory();
      for (const x of parts) dir = await dir.getDirectoryHandle(x);
      return await (await (await dir.getFileHandle(name)).getFile()).text();
    } catch {
      return null;
    }
  }, path);
}

async function exists(page: Page, path: string): Promise<boolean> {
  return page.evaluate(async (p) => {
    try {
      let dir = await navigator.storage.getDirectory();
      for (const x of p.split("/")) dir = await dir.getDirectoryHandle(x);
      return true;
    } catch {
      return false;
    }
  }, path);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen-last-import");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("Keep export: palette → wizard → review → import → undo leaves the vault as it was", async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  await page.locator("header").first().waitFor({ state: "visible" });
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Import notes from another app");
  await page.keyboard.press("Enter");
  const wizard = page.getByTestId("import-wizard");
  await expect(wizard).toBeVisible();

  await wizard.getByTestId("import-source-keep").click();
  await expect(wizard.getByTestId("import-how")).toContainText("takeout.google.com");
  const [[name, bytes]] = [...(await keepExport())];
  await wizard.getByTestId("import-file-input").setInputFiles({ name, mimeType: "application/zip", buffer: Buffer.from(bytes) });

  await expect(wizard.getByTestId("import-summary")).toHaveText("2 notes, 2 attachments and 0 databases will go into “Imported/takeout-20240201”.");
  await wizard.getByTestId("import-start").click();
  await expect(wizard.getByTestId("import-done")).toBeVisible();
  await expect.poll(() => readFile(page, "Imported/takeout-20240201/Groceries.md")).toContain("- [x] חלב");
  await expect.poll(() => readFile(page, "Imported/takeout-20240201/Archive/רעיון לסטארטאפ.md")).toContain("archived: true");

  await wizard.getByTestId("import-undo").click();
  await expect.poll(() => exists(page, "Imported")).toBe(false);
});

test("Notion export: the database arrives as a .base the app shows as a table", async ({ page }) => {
  test.setTimeout(60_000);
  test.skip(!(await opfsWritable(page)), "OPFS writes are unavailable in this engine's test context");
  await page.evaluate(() => window.dispatchEvent(new Event("lumen-open-import")));
  const wizard = page.getByTestId("import-wizard");
  await wizard.getByTestId("import-source-notion").click();
  const [[name, bytes]] = [...(await notionExport())];
  await wizard.getByTestId("import-file-input").setInputFiles({ name, mimeType: "application/zip", buffer: Buffer.from(bytes) });
  await expect(wizard.getByTestId("import-summary")).toContainText("1 databases");
  await wizard.getByTestId("import-start").click();
  await expect(wizard.getByTestId("import-done")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(wizard).toBeHidden();

  const base = await readFile(page, "Imported/Export-7a1b/ספרים.base");
  expect(base).toContain('file.inFolder("Imported/Export-7a1b/ספרים")');
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("# Shelf\n\n![[ספרים.base]]\n");
  const rows = page.getByTestId("base-block").first().locator("tbody tr[data-path]");
  await expect(rows).toHaveCount(3, { timeout: 15_000 });
});
