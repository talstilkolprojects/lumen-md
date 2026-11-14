import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * The canvas on Excalidraw (plan 4.19, part 2). Acceptance:
 *  - 0 network requests from the canvas under the local-only policy: every
 *    request while the canvas is open stays on the app's origin (fonts
 *    included — they come from /excalidraw/fonts/, not esm.sh);
 *  - Hebrew text: typed right-to-left in the editor, drawn with a loaded
 *    Hebrew face (not a missing-glyph fallback), saved as written in the
 *    .excalidraw file; the UI in Hebrew is right-to-left;
 *  - the drawing is saved to canvases/<name>.excalidraw and comes back.
 * tldraw's absence from the build is checked by scripts/bundle-budget.mjs.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** The text of canvases/<file> in OPFS, or null. */
const readCanvas = (page: Page, file: string) =>
  page.evaluate(async (f) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("canvases");
      return await (await (await dir.getFileHandle(f)).getFile()).text();
    } catch {
      return null;
    }
  }, file);

async function opfsWritable(page: Page): Promise<boolean> {
  return page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const fh = await root.getFileHandle("__probe", { create: true });
      const h = fh as unknown as { createWritable?: () => Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> };
      if (typeof h.createWritable !== "function") return false;
      const w = await h.createWritable();
      await w.write("x");
      await w.close();
      await root.removeEntry("__probe");
      return true;
    } catch {
      return false;
    }
  });
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
});

test("local-only: opening the canvas, drawing Hebrew text and saving makes no request off this origin", async ({ page, baseURL, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  const origin = new URL(baseURL ?? page.url()).origin;
  const offOrigin: string[] = [];
  const fontRequests: string[] = [];
  page.on("request", (r) => {
    const u = new URL(r.url());
    if (u.origin !== origin && u.protocol !== "data:" && u.protocol !== "blob:") offOrigin.push(r.url());
    if (u.pathname.includes("/excalidraw/fonts/")) fontRequests.push(u.pathname);
  });

  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  await expect(canvas).toBeVisible({ timeout: 15_000 });
  const excalidraw = canvas.locator(".excalidraw");
  await expect(excalidraw).toBeVisible({ timeout: 15_000 });

  // The text tool, a click on the canvas, Hebrew typed into Excalidraw's editor.
  await page.keyboard.press("t");
  const surface = excalidraw.locator("canvas.interactive").first();
  await surface.click({ position: { x: 400, y: 300 } });
  const editor = excalidraw.locator("textarea.excalidraw-wysiwyg");
  await expect(editor).toBeVisible({ timeout: 5_000 });
  await expect(editor).toHaveAttribute("dir", "auto");
  await page.keyboard.type("שלום עולם");
  // dir=auto on Hebrew text: the editor lays it out right-to-left.
  expect(await editor.evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
  await page.keyboard.press("Escape");

  // Saved (500 ms debounce) as written, into the default canvas file.
  await expect.poll(() => readCanvas(page, "untitled.excalidraw"), { timeout: 10_000 }).toContain("שלום עולם");
  const saved = JSON.parse((await readCanvas(page, "untitled.excalidraw"))!) as { type: string; elements: Array<{ type: string; text?: string }> };
  expect(saved.type).toBe("excalidraw");
  expect(saved.elements.filter((e) => e.type === "text").map((e) => e.text)).toEqual(["שלום עולם"]);

  // The Hebrew glyphs are drawn with a loaded face (Assistant, served from this origin), not a fallback box.
  await expect.poll(() => page.evaluate(() => document.fonts.check("20px Excalifont", "שלום")), { timeout: 10_000 }).toBe(true);
  expect(fontRequests.some((p) => p.includes("/Assistant/"))).toBe(true);
  expect(fontRequests.some((p) => p.includes("/Excalifont/"))).toBe(true);

  // Nothing left the device.
  expect(offOrigin).toEqual([]);
  test.info().annotations.push({ type: "canvas-requests", description: `${fontRequests.length} same-origin font files, 0 off-origin` });
});

test("a canvas comes back after reopening, and the UI follows the app's language and direction", async ({ page, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  const excalidraw = canvas.locator(".excalidraw");
  await expect(excalidraw).toBeVisible({ timeout: 15_000 });
  await page.keyboard.press("t");
  await excalidraw.locator("canvas.interactive").first().click({ position: { x: 300, y: 200 } });
  await expect(excalidraw.locator("textarea.excalidraw-wysiwyg")).toBeVisible();
  await page.keyboard.type("persist me");
  await page.keyboard.press("Escape");
  await expect.poll(() => readCanvas(page, "untitled.excalidraw"), { timeout: 10_000 }).toContain("persist me");
  await canvas.getByRole("button", { name: "Close" }).click();
  await expect(canvas).toBeHidden();

  // Hebrew UI: Excalidraw in Hebrew, right-to-left; the drawing is still there.
  await run(page, "lang.he");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl", { timeout: 10_000 });
  await run(page, "view.canvas");
  await expect(excalidraw).toBeVisible({ timeout: 15_000 });
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", /^he/);
  await expect(canvas.getByRole("button", { name: "סגור" })).toBeVisible();
  // The main menu is Excalidraw's own, in Hebrew.
  await excalidraw.locator(".dropdown-menu-button").first().click();
  await expect(excalidraw.getByText("אפס את הקנבאס")).toBeVisible();
  await page.keyboard.press("Escape");
  const file = JSON.parse((await readCanvas(page, "untitled.excalidraw"))!) as { elements: Array<{ type: string; text?: string }> };
  expect(file.elements.some((e) => e.type === "text" && e.text === "persist me")).toBe(true);
  await canvas.getByRole("button", { name: "סגור" }).click();
  // Closing the canvas gives the app's own lang back (Excalidraw sets "he-IL").
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
});

test("JSON Canvas (plan 4.17): an Obsidian .canvas imports, opens, and exports back unchanged", async ({ page, browserName }) => {
  vaultOrSkip(await opfsWritable(page), browserName);
  const canvasJson = {
    nodes: [
      { id: "g1", type: "group", label: "Plan", x: -40, y: -40, width: 760, height: 260, color: "6" },
      { id: "t1", type: "text", text: "# שלום\n\nA **note** card", x: 0, y: 0, width: 260, height: 160 },
      { id: "f1", type: "file", file: "Notes/Plan.md", subpath: "#Goals", x: 400, y: 0, width: 260, height: 160 },
      { id: "l1", type: "link", url: "https://example.com/", x: 0, y: 400, width: 260, height: 120, color: "#FF8800" },
    ],
    edges: [
      { id: "e1", fromNode: "t1", fromSide: "right", toNode: "f1", toSide: "left", label: "details" },
      { id: "e2", fromNode: "t1", toNode: "l1", toEnd: "none" },
    ],
  };
  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  await expect(canvas.locator(".excalidraw")).toBeVisible({ timeout: 15_000 });

  await canvas.getByTestId("canvas-import-json-input").setInputFiles({ name: "obsidian-plan.canvas", mimeType: "application/json", buffer: Buffer.from(JSON.stringify(canvasJson)) });
  // The import is a new canvas file, opened.
  await expect(canvas.locator(".lumen-canvas-body")).toHaveAttribute("data-canvas-name", "obsidian-plan", { timeout: 10_000 });
  const saved = JSON.parse((await readCanvas(page, "obsidian-plan.excalidraw"))!) as { elements: Array<{ id: string; type: string; originalText?: string; link?: string | null }> };
  expect(saved.elements.find((e) => e.id === "g1")?.type).toBe("frame");
  expect(saved.elements.find((e) => e.id === "f1")?.link).toBe("Notes/Plan.md#Goals");
  expect(saved.elements.some((e) => e.type === "text" && e.originalText === "# שלום\n\nA **note** card")).toBe(true);

  await canvas.getByTestId("canvas-export-json").click();
  await expect.poll(() => readCanvas(page, "obsidian-plan.canvas"), { timeout: 10_000 }).not.toBeNull();
  const exported = JSON.parse((await readCanvas(page, "obsidian-plan.canvas"))!) as unknown;
  expect(exported).toEqual(canvasJson);
});
