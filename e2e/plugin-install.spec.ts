import { test, expect } from "@playwright/test";
import { readFileSync } from "node:fs";
import path from "node:path";

/**
 * Plan W1.20: the install screen of each example plugin lists every
 * permission its manifest asks for, in plain language, with the plugin's
 * reason and its safety scan — before anything runs.
 */

const EXAMPLES = path.join(process.cwd(), "public", "plugins", "examples");
const index = JSON.parse(readFileSync(path.join(EXAMPLES, "index.json"), "utf8")) as { plugins: Array<{ id: string; versions: Array<{ path: string }> }> };
const manifests = index.plugins.map((p) => JSON.parse(readFileSync(path.join(EXAMPLES, p.versions[p.versions.length - 1].path, "lumen-plugin.json"), "utf8")) as { id: string; name: string; capabilities: Array<{ id: string; reason: string }> });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await page.locator("header").first().waitFor({ state: "visible", timeout: 10_000 });
});

test("the install screen shows every permission of every example plugin", async ({ page }) => {
  expect(manifests).toHaveLength(index.plugins.length);
  const pageErrors: string[] = [];
  page.on("pageerror", (err) => pageErrors.push(err.message));

  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("Plugin Gallery");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Plugin Gallery/i, { timeout: 8000 });
  await page.keyboard.press("Enter");

  const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
  const section = gallery.getByTestId("sandboxed-plugins");
  await expect(section.getByTestId("sandboxed-plugin-card")).toHaveCount(manifests.length, { timeout: 15_000 });

  for (const m of manifests) {
    const card = section.locator(`[data-testid="sandboxed-plugin-card"][data-plugin="${m.id}"]`);
    await expect(card.getByTestId("safety-card")).toContainText(/Safety [ABC]/);
    await card.getByRole("button", { name: /Install/ }).click();
    const dialog = page.getByTestId("plugin-install-dialog");
    await expect(dialog).toBeVisible();
    await expect(dialog.getByRole("heading")).toContainText(m.name);
    const items = dialog.getByTestId("install-capability");
    await expect(items).toHaveCount(m.capabilities.length);
    const shown = await items.evaluateAll((els) => els.map((e) => e.getAttribute("data-capability")));
    expect(shown.sort()).toEqual(m.capabilities.map((c) => c.id).sort());
    for (const c of m.capabilities) {
      const item = dialog.locator(`[data-capability="${c.id}"]`);
      await expect(item).toContainText(c.reason);
      // Plain language, not the raw id (network names its origin).
      await expect(item).not.toContainText(/pluginTrust\./);
      if (c.id.startsWith("network:")) await expect(item).toContainText(c.id.slice("network:".length));
    }
    await expect(dialog.getByTestId("install-scan")).toContainText(/Safety [ABC]/);
    await dialog.getByRole("button", { name: "Cancel" }).click();
    await expect(dialog).toBeHidden();
  }
  expect(pageErrors).toEqual([]);
});
