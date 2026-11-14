import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { VAULT } from "../src/__tests__/fixtures/bases/vault";

/**
 * Obsidian Bases (plan W1.11): a golden `.base` file embedded with
 * `![[…]]` and an inline ```base block show the same rows in the same order
 * as the unit golden set; sorting by a column and "Save this sort" writes
 * only that view's `sort:` back to the file.
 */

const FIXTURES = join(process.cwd(), "src", "__tests__", "fixtures", "bases");
const BOOKS = readFileSync(join(FIXTURES, "01-all-books.base"), "utf8");
const LIMIT = readFileSync(join(FIXTURES, "08-limit.base"), "utf8");

async function seed(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (all) => {
    const storage = navigator.storage as StorageManager | undefined;
    try {
      if (!storage?.getDirectory) return false;
      const root = await storage.getDirectory();
      const probe = (await root.getFileHandle("__probe", { create: true })) as FileSystemFileHandle & { createWritable?: unknown };
      await root.removeEntry("__probe");
      if (typeof probe.createWritable !== "function") return false;
      for (const [path, text] of Object.entries(all)) {
        const parts = path.split("/");
        const name = parts.pop()!;
        let dir = root;
        for (const p of parts) dir = await dir.getDirectoryHandle(p, { create: true });
        const w = await (await dir.getFileHandle(name, { create: true })).createWritable();
        await w.write(text);
        await w.close();
      }
      return true;
    } catch {
      return false;
    }
  }, files);
}

async function readFile(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    const parts = p.split("/");
    const name = parts.pop()!;
    let dir = await navigator.storage.getDirectory();
    for (const x of parts) dir = await dir.getDirectoryHandle(x);
    return (await (await dir.getFileHandle(name)).getFile()).text();
  }, path);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("an embedded .base shows the golden rows, and a saved sort changes only sort:", async ({ page, browserName }) => {
  test.setTimeout(60_000);
  const files: Record<string, string> = { "Books.base": BOOKS };
  for (const v of VAULT) if (v.text !== null) files[v.path] = v.text;
  vaultOrSkip(await seed(page, files), browserName);

  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(["# Shelf", "", "![[Books.base]]", "", "```base", LIMIT.trim(), "```", ""].join("\n"));

  const embedded = page.getByTestId("base-block").first();
  const rows = embedded.locator("tbody tr[data-path]");
  await expect(rows).toHaveCount(5, { timeout: 15_000 });
  expect(await rows.evaluateAll((els) => els.map((e) => e.getAttribute("data-path")))).toEqual(["Books/Dune.md", "Books/Emma.md", "Books/Foundation.md", "Books/Neuromancer.md", "Books/הנסיך הקטן.md"]);

  const inline = page.getByTestId("base-block").nth(1);
  await expect(inline.locator("tbody tr[data-path]")).toHaveCount(2);
  await expect(inline.getByTestId("base-count")).toContainText("2");

  // Sort by author, descending (two clicks), then save it to the file.
  const author = embedded.getByRole("button", { name: /^author/ });
  await author.click();
  await author.click();
  await expect(embedded.getByRole("columnheader", { name: /author/ })).toHaveAttribute("aria-sort", "descending");
  await expect(rows.first()).toHaveAttribute("data-path", "Books/הנסיך הקטן.md");
  await embedded.getByRole("button", { name: /Books\.base/ }).click();
  await expect.poll(async () => readFile(page, "Books.base"), { timeout: 5_000 }).toContain("note.author");
  const saved = await readFile(page, "Books.base");
  expect(saved).toContain("# Every book, by name.");
  expect(saved.replace(/\n    sort:[\s\S]*$/, "")).toBe(BOOKS.replace(/\n    sort:[\s\S]*$/, ""));
});
