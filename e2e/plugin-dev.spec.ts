import { test, expect } from "@playwright/test";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { startDevServer } from "../packages/create-lumen-plugin/template/tools/dev-server.mjs";

/**
 * Plan W3.10: a plugin made from the create-lumen-plugin template runs in
 * developer mode, and saving main.js reloads it in the app within a second.
 */

const TEMPLATE = path.join(process.cwd(), "packages", "create-lumen-plugin", "template");

test("developer mode runs the template plugin and reloads it on save", async ({ page }) => {
  const dir = mkdtempSync(path.join(tmpdir(), "lumen-dev-e2e-"));
  cpSync(TEMPLATE, dir, { recursive: true });
  const fill = (f: string) => writeFileSync(path.join(dir, f), readFileSync(path.join(dir, f), "utf8").replace(/__PLUGIN_NAME__/g, "e2e-plugin").replace(/__PLUGIN_TITLE__/g, "E2E plugin"));
  ["lumen-plugin.json", "main.js"].forEach(fill);
  const server = await startDevServer({ dir, port: 5199, log: () => {} });
  try {
    await page.addInitScript(() => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.removeItem("lumen-md");
    });
    await page.goto("/");
    await page.locator("header").first().waitFor({ state: "visible", timeout: 10_000 });
    await page.keyboard.press("Meta+K");
    const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
    await palette.locator("input").first().fill("Plugin Gallery");
    await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Plugin Gallery/i, { timeout: 8000 });
    await page.keyboard.press("Enter");

    const gallery = page.locator('[role="dialog"][aria-labelledby="plugin-gallery-title"]');
    await gallery.getByTestId("plugin-dev").locator("summary").click();
    const panel = gallery.getByTestId("plugin-dev-panel");
    await panel.getByRole("button", { name: "Connect" }).click();
    const status = panel.getByTestId("plugin-dev-status");
    await expect(status).toContainText("E2E plugin 0.1.0 · running", { timeout: 15_000 });
    await expect(panel.getByTestId("plugin-dev-reload")).toContainText("Reloads: 1");

    const main = path.join(dir, "main.js");
    writeFileSync(main, readFileSync(main, "utf8").replace("words · ${c.chars} characters", "words (v2)"));
    const t0 = Date.now();
    await expect(panel.getByTestId("plugin-dev-reload")).toContainText("Reloads: 2", { timeout: 5000 });
    expect(Date.now() - t0).toBeLessThan(1000 + 500); // the reload, plus Playwright's polling
    await expect(panel.getByTestId("plugin-dev-caps").locator('tr[data-cap="document:read"]')).toBeVisible();
  } finally {
    await server.close();
    rmSync(dir, { recursive: true, force: true });
  }
});
