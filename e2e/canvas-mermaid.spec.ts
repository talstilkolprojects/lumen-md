import { test, expect, type Page } from "@playwright/test";
import { MERMAID_GOLDEN } from "../src/__tests__/fixtures/mermaidGolden";
import { expectedLabels } from "../src/canvas/mermaidPrep";

/**
 * Plan W2.18 — Mermaid to the canvas. Acceptance: the 20 golden diagrams
 * (flowchart, sequence, class, state, ER; Hebrew labels) convert without
 * missing elements, into shapes saved in the canvas file, with 0 requests
 * off this origin. ("Draw me" needs a local model: its ≥ 80% acceptance
 * is `npm run eval:canvas-draw`.)
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
const readCanvas = (page: Page, file: string) =>
  page.evaluate(async (f) => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("canvases");
      return await (await (await dir.getFileHandle(f)).getFile()).text();
    } catch {
      return null;
    }
  }, file);

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("20 golden diagrams become canvas shapes with every label, and nothing leaves the origin", async ({ page, baseURL }) => {
  test.setTimeout(180_000);
  const origin = new URL(baseURL ?? page.url()).origin;
  const offOrigin: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin && !["data:", "blob:"].includes(u.protocol)) offOrigin.push(r.url());
  });
  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  await expect(canvas.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  const name = await canvas.locator("[data-canvas-name]").getAttribute("data-canvas-name");

  for (const g of MERMAID_GOLDEN) {
    await canvas.getByTestId("canvas-diagram").click();
    const dialog = page.getByTestId("canvas-diagram-dialog");
    await dialog.getByTestId("canvas-diagram-code").fill(g.code);
    await dialog.getByTestId("canvas-diagram-insert").click();
    // The dialog closes only when the conversion kept every label; otherwise it says which are missing.
    await expect(dialog, `${g.id}: ${await dialog.getByTestId("canvas-diagram-status").textContent().catch(() => "")}`).toBeHidden({ timeout: 20_000 });
  }

  await expect.poll(async () => (await readCanvas(page, `${name}.excalidraw`))?.length ?? 0, { timeout: 10_000 }).toBeGreaterThan(1000);
  const file = JSON.parse((await readCanvas(page, `${name}.excalidraw`))!) as { elements: Array<{ type: string; text?: string; isDeleted?: boolean }> };
  const texts = file.elements.filter((e) => e.type === "text" && !e.isDeleted).map((e) => (e.text ?? "").replace(/\s+/g, " "));
  for (const g of MERMAID_GOLDEN) {
    const l = expectedLabels(g.code);
    for (const label of [...l.nodes, ...l.edges]) expect(texts.some((t) => t.includes(label.replace(/\s+/g, " "))), `${g.id}: ${label}`).toBe(true);
  }
  expect(file.elements.filter((e) => e.type === "arrow").length).toBeGreaterThanOrEqual(30);
  expect(offOrigin).toEqual([]);
});

test("a broken diagram is refused with Mermaid's error and nothing is inserted", async ({ page }) => {
  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  await expect(canvas.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  await canvas.getByTestId("canvas-diagram").click();
  const dialog = page.getByTestId("canvas-diagram-dialog");
  await dialog.getByTestId("canvas-diagram-code").fill("flowchart TD\n  A[שלום --> B");
  await dialog.getByTestId("canvas-diagram-insert").click();
  await expect(dialog.getByTestId("canvas-diagram-status")).toContainText("Mermaid can't read it");
  await expect(dialog).toBeVisible();
});
