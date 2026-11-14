import { test, expect, type Page } from "@playwright/test";

/**
 * Block references (MASTER_PLAN 4.8), acceptance: a `[[Note#^id]]` link and
 * an `![[Note#^id]]` embed survive renaming the note and moving it to a
 * folder; following the link still scrolls the preview to that block, and
 * the embed shows only that block. Also: "Copy link to block" gives the
 * block at the cursor an id.
 */

const FILLER = Array.from({ length: 60 }, (_, i) => `Filler paragraph ${i + 1}.`).join("\n\n");
const PLANS = `# Plans\n\n${FILLER}\n\nThe goal paragraph. ^goal\n\nAfter the goal.\n`;
const HUB = "# Hub\n\nSee [[Plans#^goal]].\n\n![[Plans#^goal]]\n";

async function seed(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (files) => {
    try {
      const root = await navigator.storage.getDirectory();
      for (const [name, data] of Object.entries(files)) {
        const fh = (await root.getFileHandle(name, { create: true })) as unknown as {
          createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }>;
        };
        if (typeof fh.createWritable !== "function") return false;
        const w = await fh.createWritable();
        await w.write(data);
        await w.close();
      }
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      return true;
    } catch {
      return false;
    }
  }, files);
}

async function read(page: Page, path: string): Promise<string> {
  return page.evaluate(async (p) => {
    let dir = await navigator.storage.getDirectory();
    const parts = p.split("/");
    for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
    return (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
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

test("a block reference survives a rename and a move, and still scrolls to the block", async ({ page }) => {
  test.setTimeout(90_000);
  test.skip(!(await seed(page, { "Plans.md": PLANS, "Hub.md": HUB })), "this engine cannot write OPFS files here");
  const tree = page.locator("aside.file-tree");
  if (!(await tree.isVisible())) await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "view.workspace" } })));
  const name = (n: string) => tree.locator(".file-tree-name", { hasText: n });
  await expect(name("Plans.md")).toBeVisible({ timeout: 10_000 });

  // Rename Plans.md → Roadmap.md.
  const row = tree.locator(".file-tree-item", { has: page.locator(".file-tree-name", { hasText: "Plans.md" }) });
  await row.hover();
  await row.getByRole("button", { name: /rename/i }).click();
  const input = tree.locator("input.file-tree-input");
  await input.fill("Roadmap");
  await input.press("Enter");
  await expect(name("Roadmap.md")).toBeVisible({ timeout: 10_000 });
  await expect.poll(() => read(page, "Hub.md"), { timeout: 10_000 }).toBe("# Hub\n\nSee [[Roadmap#^goal]].\n\n![[Roadmap#^goal]]\n");

  // Move it into archive/.
  await name("Roadmap.md").click({ modifiers: ["ControlOrMeta"] });
  await tree.getByRole("button", { name: "Move…" }).click();
  const dialog = page.getByRole("dialog");
  await dialog.getByRole("textbox").fill("archive");
  await dialog.getByRole("textbox").press("Enter");
  await expect.poll(() => read(page, "archive/Roadmap.md").catch(() => ""), { timeout: 10_000 }).toBe(PLANS);
  expect(await read(page, "Hub.md")).toBe("# Hub\n\nSee [[Roadmap#^goal]].\n\n![[Roadmap#^goal]]\n");

  // Open the hub: the embed shows only the block.
  await name("Hub.md").click();
  const preview = page.locator("[data-preview-root]").first();
  const embed = preview.locator('.lumen-embed[data-embed-target="Roadmap#^goal"] .lumen-embed-body');
  await expect(embed).toHaveText("The goal paragraph.", { timeout: 10_000 });

  // Follow the link: the moved note opens, scrolled to the block.
  await preview.locator('a.wiki-link[data-wiki-target="Roadmap#^goal"]').first().click();
  const block = page.locator('[data-preview-root] [id="^goal"]').first();
  await expect(block).toHaveText("The goal paragraph.", { timeout: 10_000 });
  await expect(block).toBeInViewport({ timeout: 5_000 });
  // The marker itself is not shown.
  await expect(page.locator("[data-preview-root]").first()).not.toContainText("^goal");
});

test("Copy link to block gives the block at the cursor an id", async ({ page }) => {
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("# Note\n\nA paragraph to link to.\n");
  await editor.locator(".cm-line", { hasText: "A paragraph" }).click();
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "editor.copyBlockLink" } })));
  await expect(editor).toContainText(/A paragraph to link to\. \^[0-9a-z]{6}/, { timeout: 5_000 });
  const id = /\^([0-9a-z]{6})/.exec((await editor.textContent()) ?? "")![1];
  // The preview gives the paragraph that id.
  await expect(page.locator(`[data-preview-root] [id="^${id}"]`).first()).toHaveText("A paragraph to link to.", { timeout: 5_000 });
});
