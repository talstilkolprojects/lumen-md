import { test, expect, type Page } from "@playwright/test";
import { vaultOrSkip } from "./_opfs";

/**
 * Plan W6.48 — the canvas at 5,000 shapes. @nightly: it runs in the "perf"
 * project (`npx playwright test --project=perf`), which `npm run nightly`
 * runs on the owner's Mac (a real GPU). It is not run on preview builds:
 * the build machine has no GPU and its numbers would say nothing.
 *
 * The canvas `untitled.excalidraw` is written to the vault (OPFS) with 5,000
 * shapes (rectangles, ellipses, diamonds, arrows and Hebrew/English text, in
 * a 100 × 50 grid), then opened. Measured with requestAnimationFrame while
 * the view pans for 3 s (wheel events, as a trackpad does) and zooms for 2 s:
 * frames per second and the 95th percentile frame time. Acceptance (W6.48):
 * at least 55 fps on a mid-range computer. Each number is a "perf"
 * annotation, which the nightly report keeps.
 */

const SHAPES = 5000;
const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** A 5,000-shape scene in Excalidraw's file format. */
function scene(n: number) {
  const types = ["rectangle", "ellipse", "diamond", "arrow", "text"] as const;
  const base = { angle: 0, strokeColor: "#1e1e1e", backgroundColor: "#a5d8ff", fillStyle: "hachure", strokeWidth: 1, strokeStyle: "solid", roughness: 1, opacity: 100, groupIds: [], frameId: null, roundness: null, isDeleted: false, boundElements: null, updated: 1, link: null, locked: false };
  const elements = Array.from({ length: n }, (_, i) => {
    const type = types[i % types.length];
    const x = (i % 100) * 60;
    const y = Math.floor(i / 100) * 60;
    const common = { ...base, id: `p${i}`, type, x, y, width: 48, height: 40, seed: i + 1, version: 1, versionNonce: i + 7, index: `a${String(i).padStart(5, "0")}` };
    if (type === "arrow") return { ...common, points: [[0, 0], [48, 40]], lastCommittedPoint: null, startBinding: null, endBinding: null, startArrowhead: null, endArrowhead: "arrow", elbowed: false };
    if (type === "text") {
      const text = i % 2 ? "שלום" : "Hi";
      return { ...common, text, originalText: text, fontSize: 16, fontFamily: 5, textAlign: "left", verticalAlign: "top", containerId: null, autoResize: true, lineHeight: 1.25, backgroundColor: "transparent" };
    }
    return common;
  });
  return { type: "excalidraw", version: 2, source: "lumen-md perf", elements, appState: { viewBackgroundColor: "#ffffff", gridSize: null }, files: {} };
}

/** Frames per second and the p95 frame time while `act` runs. */
async function measure(page: Page, act: () => Promise<void>): Promise<{ fps: number; p95: number; frames: number }> {
  await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafOn: boolean };
    w.__frames = [];
    w.__rafOn = true;
    const tick = (t: number) => {
      w.__frames.push(t);
      if (w.__rafOn) requestAnimationFrame(tick);
    };
    requestAnimationFrame(tick);
  });
  await act();
  const frames = await page.evaluate(() => {
    const w = window as unknown as { __frames: number[]; __rafOn: boolean };
    w.__rafOn = false;
    return w.__frames;
  });
  const deltas = frames.slice(1).map((t, i) => t - frames[i]).sort((a, b) => a - b);
  const seconds = (frames[frames.length - 1] - frames[0]) / 1000;
  return { fps: (frames.length - 1) / seconds, p95: deltas[Math.floor(deltas.length * 0.95)] ?? Infinity, frames: frames.length };
}

test("@nightly canvas: 5,000 shapes pan and zoom at ≥ 55 fps", async ({ page, browserName }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen.ai.policy", "local-only");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
  const wrote = await page.evaluate(async (text) => {
    try {
      const root = await navigator.storage.getDirectory();
      const dir = await root.getDirectoryHandle("canvases", { create: true });
      const fh = await dir.getFileHandle("untitled.excalidraw", { create: true });
      const w = await (fh as unknown as { createWritable(): Promise<{ write(d: string): Promise<void>; close(): Promise<void> }> }).createWritable();
      await w.write(text);
      await w.close();
      return true;
    } catch {
      return false;
    }
  }, JSON.stringify(scene(SHAPES)));
  vaultOrSkip(wrote, browserName);

  await run(page, "view.canvas");
  const canvas = page.getByTestId("canvas");
  const surface = canvas.locator(".excalidraw canvas.interactive").first();
  await expect(surface).toBeVisible({ timeout: 30_000 });
  const box = (await surface.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);

  const steps = (ms: number, fn: (i: number) => Promise<void>) => async () => {
    const end = Date.now() + ms;
    for (let i = 0; Date.now() < end; i++) await fn(i);
  };
  const pan = await measure(page, steps(3000, (i) => page.mouse.wheel(i % 120 < 60 ? 40 : -40, i % 80 < 40 ? 25 : -25)));
  await page.keyboard.down("Control");
  const zoom = await measure(page, steps(2000, (i) => page.mouse.wheel(0, i % 40 < 20 ? -20 : 20)));
  await page.keyboard.up("Control");

  for (const [name, m] of [["pan", pan], ["zoom", zoom]] as const) {
    test.info().annotations.push({ type: "perf", description: `canvas ${SHAPES} shapes ${name}: ${m.fps.toFixed(1)} fps` });
    test.info().annotations.push({ type: "perf", description: `canvas ${SHAPES} shapes ${name} p95 frame: ${m.p95.toFixed(1)} ms` });
  }
  expect(pan.frames, "frames were drawn").toBeGreaterThan(30);
  expect(pan.fps, "pan fps").toBeGreaterThanOrEqual(55);
  expect(zoom.fps, "zoom fps").toBeGreaterThanOrEqual(55);
});
