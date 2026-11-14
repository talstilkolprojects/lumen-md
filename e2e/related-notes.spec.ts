import { test, expect, type Page } from "@playwright/test";
import { opfsWritable, vaultOrSkip } from "./_opfs";

/**
 * Plan W2.2: related notes and suggested links while writing. Notes are put
 * in the workspace; typing a paragraph shows the related one in the panel
 * shortly after typing stops, underlines a mentioned note, and "Link"
 * turns the mention into a wiki-link. Typing itself is never changed.
 */

const NOTES: Record<string, string> = {
  "Project Aurora.md": "# Project Aurora\n\nThe launch plan.\n",
  "sourdough-b.md": "# Bread log\n\nThe levain was lively; hydration at 75% gave an open crumb after long proofing.\n",
  "kubernetes.md": "# Cluster notes\n\nHelm charts and ingress rules for the pods.\n",
};

async function seed(page: Page) {
  await page.evaluate(async (notes) => {
    const root = await navigator.storage.getDirectory();
    for (const [name, text] of Object.entries(notes)) {
      const w = await (await root.getFileHandle(name, { create: true })).createWritable();
      await w.write(text);
      await w.close();
    }
  }, NOTES);
}

test.beforeEach(async ({ page, browserName }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  vaultOrSkip(await opfsWritable(page), browserName);
  await seed(page);
});

test("the panel follows the paragraph being written; a mention becomes a link only on Link", async ({ page }) => {
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.press("Delete");

  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Related notes: show");
  await page.keyboard.press("Enter");
  const panel = page.getByTestId("related-panel");
  await expect(panel).toBeVisible();

  await source.click();
  const typed = "Fed the sourdough starter; hydration and proofing for Project Aurora day";
  await page.keyboard.type(typed);
  const stopped = Date.now();
  await expect(panel.locator('[data-testid="related-hit"][data-path="sourdough-b.md"]')).toBeVisible();
  const latency = Date.now() - stopped;
  console.log(`[W2.2] panel updated ${latency} ms after the last keystroke`);
  expect(latency).toBeLessThan(1500);
  // Typing was not changed by the plugin.
  await expect(source).toHaveText(typed);
  await expect(page.locator(".cm-related-hint")).toHaveText("Project Aurora");

  await panel.getByTestId("related-link-accept").first().click();
  await expect(source).toContainText("for [[Project Aurora]] day");
  await page.keyboard.press("ControlOrMeta+z");
  await expect(source).toHaveText(typed);
});

test("off for a note with related: false", async ({ page }) => {
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill("---\nrelated: false\n---\nsourdough hydration proofing levain");
  await page.keyboard.press("Meta+K");
  await page.keyboard.type("Related notes: show");
  await page.keyboard.press("Enter");
  await expect(page.getByTestId("related-off")).toBeVisible();
  await expect(page.getByTestId("related-hit")).toHaveCount(0);
});
