import { test, expect, type Page, type BrowserContext } from "@playwright/test";
import { swOfflineOrSkip } from "./_engines";

/**
 * Plan 8.5 — the installed app works offline from the first visit: after one
 * online load (the service worker installs and precaches), the network goes
 * away and the app still
 *   - opens a note shared to it (share_target, GET with text),
 *   - highlights code (Shiki core + themes are precached),
 *   - renders Hebrew in its self-hosted Hebrew font (B8: Heebo is precached;
 *     the first visit never rendered Hebrew, so nothing came from a cache
 *     filled by use),
 *   - opens a file handed to it by the OS (file_handlers → launchQueue),
 *   - reaches a local AI (a fake Ollama on loopback; the real one is the
 *     owner's check).
 * OCR is not covered: its language data (tessdata, ~1–20 MB per language)
 * and the tesseract cores (~12 MB) are downloaded on first use, far beyond
 * the precache budget, so OCR needs one online use first.
 *
 * Production build + Chromium only (the service worker is not registered
 * in dev); CI runs it in the e2e-prod job.
 */

const SHARED = ["שלום עולם — טקסט בעברית", "", "```python", "def greet(name):", "    return f\"hi {name}\"", "```"].join("\n");

async function installOffline(page: Page, context: BrowserContext, browserName: string) {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    // Source mode for the online visit: the Welcome note's code fences are
    // never highlighted while online, so nothing Shiki needs can reach the
    // runtime or HTTP cache before the offline check (only the precache can serve it).
    if (!localStorage.getItem("lumen-md")) localStorage.setItem("lumen-md", JSON.stringify({ state: { mode: "source" }, version: 0 }));
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  const dev = await page.evaluate(() => !!document.querySelector('script[src*="/@vite/client"]'));
  swOfflineOrSkip(dev, browserName, "the service-worker offline checks run on the production build in Chromium");
  // Chromium has service workers: their absence on a production build is a regression, not a skip.
  expect(await page.evaluate(() => "serviceWorker" in navigator)).toBe(true);
  // `ready` resolves once the worker is active, i.e. after the precache was filled.
  await page.evaluate(async () => {
    await navigator.serviceWorker.ready;
  });
  const precached = await page.evaluate(async () => {
    const names = await caches.keys();
    const urls: string[] = [];
    for (const n of names.filter((n) => n.includes("precache"))) for (const r of await (await caches.open(n)).keys()) urls.push(new URL(r.url).pathname);
    return urls;
  });
  expect(precached.some((u) => /\/assets\/vendor-shiki-.+\.js$/.test(u)), "Shiki core precached").toBe(true);
  expect(precached.some((u) => /\/assets\/github-dark-default-.+\.js$/.test(u)), "Shiki theme precached").toBe(true);
  expect(precached.some((u) => /\/assets\/python-.+\.js$/.test(u)), "Python grammar precached").toBe(true);
  expect(precached.some((u) => /heebo-hebrew-400-normal.*\.woff2$/.test(u)), "Hebrew font precached").toBe(true);
  expect(precached.some((u) => /\/assets\/pdf\.worker\.min-.+\.mjs$/.test(u)), "PDF.js worker precached").toBe(true);
  await page.reload();
  await expect.poll(() => page.evaluate(() => !!navigator.serviceWorker.controller), { timeout: 20_000 }).toBe(true);
  // Nothing fetched on demand while online may stand in for the precache.
  const dropped = await page.evaluate(async () => {
    const names = (await caches.keys()).filter((n) => !n.includes("precache"));
    for (const n of names) await caches.delete(n);
    return names;
  });
  expect(dropped.every((n) => !n.includes("precache"))).toBe(true);
  await context.setOffline(true);
}

test.afterEach(async ({ context }) => {
  await context.setOffline(false);
});

test("offline: a shared note opens, its code is highlighted and its Hebrew uses the bundled font", async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  await installOffline(page, context, browserName);
  // A font request that could not be served (offline, nothing in the
  // precache). net::ERR_ABORTED is the renderer withdrawing a speculative
  // subset request it no longer needs, not a failure to serve.
  const failedFonts: string[] = [];
  page.on("requestfailed", (r) => {
    const why = r.failure()?.errorText ?? "";
    if (/\.woff2($|\?)/.test(r.url()) && why !== "net::ERR_ABORTED") failedFonts.push(`${r.url()} ${why}`);
  });
  await page.goto("/?title=" + encodeURIComponent("Offline share") + "&text=" + encodeURIComponent(SHARED));
  await expect(page.locator(".cm-content").first()).toContainText("# Offline share", { timeout: 20_000 });
  await expect(page.locator(".cm-content").first()).toContainText("def greet");

  // Split view: the preview highlights the Python block with Shiki.
  await page.keyboard.press("Meta+2");
  const code = page.locator(".prose-lumen pre.shiki").first();
  await expect(code).toBeVisible({ timeout: 20_000 });
  await expect(code).toContainText("def greet");
  await expect(code.locator("span[style*='color']").first()).toBeVisible();

  // The Hebrew paragraph renders in Heebo, loaded from the precache.
  await expect(page.locator(".prose-lumen").first()).toContainText("שלום עולם");
  const heebo = await page.evaluate(async () => {
    const faces = await document.fonts.load('16px "Heebo"', "שלום");
    return { loaded: faces.length, check: document.fonts.check('16px "Heebo"', "שלום") };
  });
  expect(heebo.loaded).toBeGreaterThan(0);
  expect(heebo.check).toBe(true);
  expect(failedFonts).toEqual([]);
});

test("offline: a file opened with the app (file_handlers) opens as a tab", async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  await installOffline(page, context, browserName);
  // Chromium hands OS-opened files to `launchQueue`; stand one in with a file.
  await page.addInitScript(() => {
    if (location.hash !== "#e2e-launch-file") return;
    const file = new File(["# From disk\n\nOpened offline.\n"], "from-disk.md", { type: "text/markdown" });
    // Chromium has a real (read-only) window.launchQueue: shadow it.
    Object.defineProperty(window, "launchQueue", {
      configurable: true,
      value: {
        setConsumer(fn: (p: { files: Array<{ kind: string; name: string; getFile(): Promise<File> }> }) => void) {
          void fn({ files: [{ kind: "file", name: file.name, getFile: async () => file }] });
        },
      },
    });
  });
  // A hash change alone doesn't reload the page (and rerun the init script).
  await page.goto("/#e2e-launch-file");
  await page.reload();
  await expect(page.locator(".cm-content").first()).toContainText("Opened offline.", { timeout: 20_000 });
});

test("offline: the local AI on loopback is still reachable (fake Ollama)", async ({ page, context, browserName }) => {
  test.setTimeout(120_000);
  await installOffline(page, context, browserName);
  // Still offline (the app comes from the service worker); only the local
  // Ollama port answers, as a loopback server would, through a fulfilled route.
  await context.route(/\/\/(localhost|127\.0\.0\.1):11434\//, (r) => {
    const path = new URL(r.request().url()).pathname;
    if (path === "/api/version") return r.fulfill({ json: { version: "0.12.0" } });
    if (path === "/api/tags") return r.fulfill({ json: { models: [{ name: "qwen2.5:7b" }, { name: "nomic-embed-text:latest" }] } });
    if (path === "/api/show") return r.fulfill({ json: { capabilities: ["completion", "tools"] } });
    return r.fulfill({ json: {} });
  });
  await page.reload();
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
  await page.keyboard.press("Meta+K");
  const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
  await palette.waitFor({ timeout: 8000 });
  await palette.locator("input").first().fill("AI: Doctor");
  await expect(palette.locator('[role="option"][aria-selected="true"]')).toContainText(/Doctor/i, { timeout: 8000 });
  await page.keyboard.press("Enter");
  const doctor = page.locator('[role="dialog"][aria-label="AI doctor"]');
  await expect(doctor.getByTestId("doctor-summary")).toBeVisible({ timeout: 20_000 });
  await expect(doctor.getByTestId("doctor-ollama.reach")).toHaveAttribute("data-status", "ok");
  await expect(doctor.getByTestId("doctor-ollama.models")).toContainText("qwen2.5:7b");
});
