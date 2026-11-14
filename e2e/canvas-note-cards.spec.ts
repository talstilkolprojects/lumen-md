import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";
import { readFileSync } from "node:fs";
import { GOLDEN_CANVASES, goldenFile } from "./fixtures/hebrewCanvases";

/**
 * Plan W1.16 — note cards on the canvas and Hebrew in its exports.
 * Acceptance:
 *  - a canvas with 50 note cards opens in < 1.5 s (cards in view loaded);
 *  - a card edits its note in place and opens it in a tab;
 *  - 20 golden canvases with Hebrew: the PNG / SVG exports match their
 *    visual baselines (diff < 0.5%; baselines are made once with
 *    `npx playwright test e2e/canvas-note-cards.spec.ts --update-snapshots`
 *    and checked by eye), and every SVG line lies inside the drawing.
 * tldraw's absence from the build: scripts/bundle-budget.mjs.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** Write files into OPFS (path → text); false when this engine can't. */
async function put(page: Page, files: Record<string, string>): Promise<boolean> {
  return page.evaluate(async (fs) => {
    try {
      const root = await navigator.storage.getDirectory();
      for (const [path, text] of Object.entries(fs)) {
        const parts = path.split("/");
        let dir = root;
        for (const p of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(p, { create: true });
        const fh = await dir.getFileHandle(parts[parts.length - 1], { create: true });
        const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
        if (typeof h.createWritable !== "function") return false;
        const w = await h.createWritable();
        await w.write(text);
        await w.close();
      }
      return true;
    } catch {
      return false;
    }
  }, files);
}

const read = (page: Page, path: string) =>
  page.evaluate(async (p) => {
    try {
      const parts = p.split("/");
      let dir = await navigator.storage.getDirectory();
      for (const d of parts.slice(0, -1)) dir = await dir.getDirectoryHandle(d);
      return await (await (await dir.getFileHandle(parts[parts.length - 1])).getFile()).text();
    } catch {
      return null;
    }
  }, path);

async function openCanvas(page: Page, name: string): Promise<number> {
  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  await expect(canvas.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });
  const t0 = Date.now();
  await canvas.getByRole("combobox", { name: "Pick canvas" }).selectOption(name);
  await expect(canvas.locator(`[data-canvas-name="${name}"] .excalidraw`)).toBeVisible({ timeout: 15_000 });
  return t0;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("a canvas with 50 note cards opens in under 1.5 s", async ({ page, browserName }) => {
  const files: Record<string, string> = {};
  const elements = Array.from({ length: 50 }, (_, i) => {
    files[`Notes/n${i}.md`] = `# פתק ${i}\n\nתוכן בעברית ו-English, שורה ${i}.`;
    return { id: `c${i}`, type: "embeddable", x: (i % 10) * 360, y: Math.floor(i / 10) * 260, width: 320, height: 220, link: `lumen-note:Notes/n${i}.md`, strokeWidth: 1, roughness: 0, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeStyle: "solid", opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: i + 1, version: 1, versionNonce: i + 1, isDeleted: false, boundElements: null, updated: 1, locked: false };
  });
  files["canvases/fifty.excalidraw"] = JSON.stringify({ type: "excalidraw", version: 2, source: "e2e", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} });
  vaultOrSkip(await put(page, files), browserName);
  const t0 = await openCanvas(page, "fifty");
  const cards = page.getByTestId("note-card");
  await expect(cards.first()).toHaveAttribute("data-loaded", "true", { timeout: 5_000 });
  await expect.poll(async () => cards.evaluateAll((els) => els.length > 0 && els.every((e) => e.getAttribute("data-loaded") === "true"))).toBe(true);
  const ms = Date.now() - t0;
  console.log(`50-card canvas: open → cards in view loaded in ${ms} ms (${await cards.count()} in view)`);
  expect(ms).toBeLessThan(1500);
  await expect(cards.first()).toContainText("פתק 0");
});

test("a card edits its note in place and opens it in a tab", async ({ page, browserName }) => {
  const el = { id: "c1", type: "embeddable", x: 100, y: 100, width: 320, height: 220, link: "lumen-note:Notes/תוכנית.md", strokeWidth: 1, roughness: 0, angle: 0, strokeColor: "#1e1e1e", backgroundColor: "transparent", fillStyle: "solid", strokeStyle: "solid", opacity: 100, groupIds: [], frameId: null, roundness: { type: 3 }, seed: 1, version: 1, versionNonce: 1, isDeleted: false, boundElements: null, updated: 1, locked: false };
  const ok = await put(page, {
    "Notes/תוכנית.md": "---\ntags: [x]\n---\n# תוכנית\n\nשורה ראשונה",
    "canvases/one.excalidraw": JSON.stringify({ type: "excalidraw", version: 2, source: "e2e", elements: [el], appState: { viewBackgroundColor: "#ffffff", gridSize: null, scrollX: 0, scrollY: 0 }, files: {} }),
  });
  vaultOrSkip(ok, browserName);
  await openCanvas(page, "one");
  const card = page.getByTestId("note-card");
  await expect(card).toHaveAttribute("data-loaded", "true");
  await expect(card).toContainText("שורה ראשונה");
  // Excalidraw's embed interaction: select the card, click it again to interact.
  const box = (await card.boundingBox())!;
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await page.mouse.click(box.x + box.width / 2, box.y + box.height - 20);
  await card.getByTestId("note-card-body").dblclick();
  const edit = card.getByTestId("note-card-edit");
  await expect(edit).toBeVisible();
  await edit.press("End");
  await edit.pressSequentially("\nשורה חדשה");
  await edit.press("ControlOrMeta+Enter");
  await expect.poll(() => read(page, "Notes/תוכנית.md")).toBe("---\ntags: [x]\n---\n# תוכנית\n\nשורה ראשונה\nשורה חדשה");

  await card.getByTestId("note-card-open").click();
  await expect(page.getByTestId("canvas")).toBeHidden();
  await expect(page.locator(".cm-content").first()).toContainText("שורה חדשה");
});

for (const golden of GOLDEN_CANVASES) {
  test(`golden canvas ${golden.name}: SVG lines inside the drawing; PNG and SVG match the baseline`, async ({ page, browserName }) => {
    const ok = await put(page, { [`canvases/${golden.name}.excalidraw`]: goldenFile(golden), ...(golden.notes ?? {}) });
    vaultOrSkip(ok, browserName);
    await openCanvas(page, golden.name);
    const canvas = page.getByTestId("canvas");

    const [svgDl] = await Promise.all([page.waitForEvent("download"), canvas.getByTestId("canvas-export-svg").click()]);
    const svg = readFileSync((await svgDl.path())!, "utf8");
    expect(svg).toContain("<svg");
    if (/[֐-׿]/.test(JSON.stringify(golden))) expect(svg).toContain("unicode-range: U+0590-05FF");

    // Every line of text lies inside the exported drawing (the RTL export bug pushed right-aligned Hebrew out of it).
    const offside = await page.evaluate((markup) => {
      const host = document.createElement("div");
      host.style.cssText = "position:fixed;inset:0;background:#fff;z-index:99999";
      const doc = new DOMParser().parseFromString(markup, "image/svg+xml");
      const el = document.importNode(doc.documentElement, true) as unknown as SVGSVGElement;
      host.appendChild(el);
      document.body.appendChild(host);
      const vb = el.viewBox.baseVal;
      const bad: string[] = [];
      for (const t of Array.from(el.querySelectorAll("text"))) {
        const r = (t as SVGGraphicsElement).getBoundingClientRect();
        const s = el.getBoundingClientRect();
        if (r.width > 0 && (r.left < s.left - 1 || r.right > s.left + vb.width + 1)) bad.push(t.textContent ?? "");
      }
      host.setAttribute("data-testid", "svg-preview");
      return bad;
    }, svg);
    expect(offside).toEqual([]);
    await expect(page.getByTestId("svg-preview").locator("svg")).toHaveScreenshot(`${golden.name}.svg.png`, { maxDiffPixelRatio: 0.005 });
    await page.evaluate(() => document.querySelector('[data-testid="svg-preview"]')?.remove());

    const [pngDl] = await Promise.all([page.waitForEvent("download"), canvas.getByTestId("canvas-export-png").click()]);
    expect(readFileSync((await pngDl.path())!)).toMatchSnapshot(`${golden.name}.png`, { maxDiffPixelRatio: 0.005 });
  });
}
