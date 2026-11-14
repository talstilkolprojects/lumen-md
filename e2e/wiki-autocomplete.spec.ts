import { test, expect, type Page } from "@playwright/test";

/**
 * `[[` link completion (MASTER_PLAN 4.5), in English and Hebrew, in the
 * source editor (CodeMirror) and the WYSIWYG editor (Milkdown): type `[[`,
 * see the workspace's notes, pick one, and the link lands in the document
 * as `[[Name]]` — headings after `#`, and a new note from "Create note".
 */

const NOTES: Record<string, string> = {
  "Project Alpha.md": "# Project Alpha\n\n## Goals\n\nShip it. ^ship\n",
  "שלום עולם.md": "# שלום עולם\n\n## סיכום\n",
  "work/Meeting notes.md": "# Meeting notes\n",
};

/**
 * Write the notes into the origin's OPFS (the vault) and tell the index.
 * False when this engine's test context can't write OPFS files from the
 * page (Playwright's WebKit has no `navigator.storage` there): no vault,
 * nothing to complete — the test skips, as the data-safety vault tests do.
 */
async function seedVault(page: Page): Promise<boolean> {
  return page.evaluate(async (notes) => {
    const storage = navigator.storage as StorageManager | undefined;
    let root: FileSystemDirectoryHandle;
    try {
      if (!storage?.getDirectory) return false;
      root = await storage.getDirectory();
      const probe = (await root.getFileHandle("__probe", { create: true })) as FileSystemFileHandle & { createWritable?: unknown };
      await root.removeEntry("__probe");
      if (typeof probe.createWritable !== "function") return false;
    } catch {
      return false;
    }
    for (const [path, text] of Object.entries(notes)) {
      const parts = path.split("/");
      let dir = root;
      for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
      const file = await dir.getFileHandle(parts[parts.length - 1], { create: true });
      const w = await file.createWritable();
      await w.write(text);
      await w.close();
    }
    window.dispatchEvent(new CustomEvent("lumen-workspace-changed", { detail: { kind: "structure" } }));
    return true;
  }, NOTES);
}

async function vaultHas(page: Page, name: string): Promise<boolean> {
  return page.evaluate(async (n) => {
    try {
      await (await navigator.storage.getDirectory()).getFileHandle(n);
      return true;
    } catch {
      return false;
    }
  }, name);
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  test.skip(!(await seedVault(page)), "OPFS writes are unavailable in this engine's test context");
});

test("source editor: [[ completes notes, Hebrew and headings, and creates a note", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("");
  const list = page.locator(".cm-tooltip-autocomplete");
  /** Enter on the first option once it reads `text`. CodeMirror ignores an
   * Enter within 75 ms of the list updating (its interactionDelay), and the
   * last keystroke's query lands up to ~100 ms after it: let it settle. */
  const pickFirst = async (text: string) => {
    await expect(list.locator("li").first()).toContainText(text, { timeout: 8_000 });
    await page.waitForTimeout(250);
    await expect(list.locator("li").first()).toContainText(text);
    await page.keyboard.press("Enter");
  };

  // English: `[[proj` → Project Alpha.
  await page.keyboard.type("See [[proj");
  await expect(list).toBeVisible({ timeout: 8_000 });
  await pickFirst("Project Alpha");
  await expect(editor).toContainText("See [[Project Alpha]]");
  // The preview reads it as a wiki link.
  await expect(page.locator(".wiki-link[data-wiki-target='Project Alpha']").first()).toBeVisible({ timeout: 5_000 });

  // Hebrew with niqqud (and no final letter yet) finds שלום עולם.
  await page.keyboard.type(" ו-[[שָׁלוֹ");
  await pickFirst("שלום עולם");
  await expect(editor).toContainText("ו-[[שלום עולם]]");

  // A heading after `#`.
  await page.keyboard.type(" [[Project Alpha#go");
  await pickFirst("Goals");
  await expect(editor).toContainText("[[Project Alpha#Goals]]");

  // No such note: "Create note «…»" creates it and links it.
  await page.keyboard.type(" [[Brand New Idea");
  await pickFirst("Create note «Brand New Idea»");
  await expect(editor).toContainText("[[Brand New Idea]]");
  await expect.poll(() => vaultHas(page, "Brand New Idea.md"), { timeout: 5_000 }).toBe(true);
});

test("WYSIWYG: [[ completes notes in English and Hebrew and writes a real wiki link", async ({ page }) => {
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.fill("Start here\n");

  await page.keyboard.press("ControlOrMeta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 8_000 });
  await pm.getByText("Start here").click();
  await page.keyboard.press("End");

  const menu = page.getByTestId("wiki-complete-menu");
  await page.keyboard.type(" [[proj");
  await expect(menu).toBeVisible({ timeout: 8_000 });
  await expect(menu.getByRole("option").first()).toContainText("Project Alpha");
  await page.keyboard.press("Enter");
  await expect(menu).toBeHidden();
  await expect(pm).toContainText("[[Project Alpha]]");

  await page.keyboard.type(" [[שָׁלוֹ");
  await expect(menu.getByRole("option").first()).toContainText("שלום עולם", { timeout: 8_000 });
  await page.keyboard.press("Enter");
  await expect(pm).toContainText("[[שלום עולם]]");

  // Back in source: plain wiki links, not `\[\[…]]`.
  await page.keyboard.press("ControlOrMeta+1");
  await expect(source).toContainText("Start here [[Project Alpha]] [[שלום עולם]]", { timeout: 5_000 });
  await expect(source).not.toContainText("\\[");
});
