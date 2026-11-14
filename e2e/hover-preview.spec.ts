import { test, expect, type Page } from "@playwright/test";

/**
 * Hover preview and unlinked mentions (MASTER_PLAN 4.6): pointing at — or
 * tabbing to — a [[link]] in the preview shows the note's first lines
 * rendered, Escape hides it; hovering a link in the source editor shows the
 * same; the backlinks panel lists unlinked mentions and links one.
 */

const PLANS = ["# Plans", "", ...Array.from({ length: 30 }, (_, i) => `Plan line ${i + 1}.`)].join("\n");

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

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("hover and focus on a [[link]] preview the note; the editor's hover too", async ({ page }) => {
  test.skip(!(await seed(page, { "Plans.md": PLANS })), "this engine cannot write OPFS files here");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill("# Hub\n\nSee [[Plans]] for more.\n");
  const link = page.locator('[data-preview-root] a.wiki-link[data-wiki-target="Plans"]').first();
  await expect(link).toBeVisible({ timeout: 10_000 });

  const card = page.getByTestId("hover-preview");
  await link.hover();
  await expect(card).toBeVisible({ timeout: 5_000 });
  await expect(card.getByRole("heading", { name: "Plans" })).toBeVisible();
  await expect(card).toContainText("Plan line 18.");
  await expect(card).not.toContainText("Plan line 19.");
  await expect(link).toHaveAttribute("aria-describedby", (await card.getAttribute("id"))!);
  // The second time it comes from the cache: under 150 ms from hover intent to card.
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden({ timeout: 5_000 });
  await link.hover();
  await expect(card).toBeVisible();
  const ms = Number(await card.getAttribute("data-ms"));
  test.info().annotations.push({ type: "hover-ms", description: String(ms) });
  expect(ms).toBeLessThan(150);

  // Keyboard: focus shows it, Escape hides it.
  await page.mouse.move(0, 0);
  await expect(card).toBeHidden({ timeout: 5_000 });
  await link.focus();
  await expect(card).toBeVisible({ timeout: 5_000 });
  await page.keyboard.press("Escape");
  await expect(card).toBeHidden();

  // The source editor: hovering the [[link]] text.
  await editor.locator(".cm-line", { hasText: "See [[Plans]]" }).getByText("Plans", { exact: false }).first().hover();
  const tip = page.getByTestId("hover-preview-editor");
  await expect(tip).toBeVisible({ timeout: 5_000 });
  await expect(tip).toContainText("Plan line 1.");
});

test("the backlinks panel lists unlinked mentions and links one", async ({ page }) => {
  test.skip(
    !(await seed(page, { "Tel Aviv.md": "# Tel Aviv\n", "Trip.md": "We flew to tel aviv yesterday.\n", "Linked.md": "Already [[Tel Aviv]].\n" })),
    "this engine cannot write OPFS files here",
  );
  const tree = page.locator("aside.file-tree");
  if (!(await tree.isVisible())) await run(page, "view.workspace");
  await tree.locator(".file-tree-name", { hasText: "Tel Aviv.md" }).click();
  await expect(page.locator(".cm-content").first()).toContainText("# Tel Aviv", { timeout: 10_000 });
  if (!(await page.locator(".backlinks-panel").isVisible())) await run(page, "view.backlinks");
  const section = page.getByTestId("unlinked-mentions");
  const button = section.getByRole("button", { name: "Link “tel aviv” in Trip" });
  await expect(button).toBeVisible({ timeout: 10_000 });
  await expect(section).not.toContainText("Linked");
  await button.click();
  await expect(button).toHaveCount(0);
  await expect
    .poll(() => page.evaluate(async () => (await (await (await navigator.storage.getDirectory()).getFileHandle("Trip.md")).getFile()).text()), { timeout: 5_000 })
    .toBe("We flew to [[Tel Aviv|tel aviv]] yesterday.\n");
});
