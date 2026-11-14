import { test, expect } from "@playwright/test";

/**
 * Plan 4.15.2 — a clip from the extension's bridge lands in the vault as a
 * note: the bridge posts the page to the app's own window, the app saves
 * it in the library with its source, and acknowledges. Nothing is sent over
 * the network.
 */
test("a clip handed over by the extension bridge is saved to the library and acknowledged", async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  await expect.poll(() => page.evaluate(() => document.documentElement.dataset.lumenClipReady)).toBe("1");
  const requests: string[] = [];
  page.on("request", (r) => {
    if (!r.url().startsWith(new URL(page.url()).origin) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) requests.push(r.url());
  });

  const html = `<!doctype html><html><head><title>Bridge Test Story — Example News</title></head><body>
    <nav>Home About us</nav><div class="cookie-banner">Accept all cookies</div>
    <article><h1>Bridge Test Story</h1>
    <p>${"The first paragraph of the clipped story, long enough to count as article text. ".repeat(3)}</p>
    <p>${"The second paragraph closes the story with more words for the extractor to keep. ".repeat(3)}</p></article>
    <footer>All rights reserved</footer></body></html>`;
  const ack = await page.evaluate(
    (html) =>
      new Promise<unknown>((resolve) => {
        window.addEventListener("message", (e) => {
          if ((e.data as { type?: string })?.type === "lumen-clip-v2:ack") resolve(e.data);
        });
        window.postMessage({ type: "lumen-clip-v2", payload: { url: "https://news.example/story?utm_source=x", html, highlights: ["second paragraph closes the story"] } }, location.origin);
      }),
    html,
  );
  expect(ack).toMatchObject({ url: "https://news.example/story?utm_source=x" });
  await expect(page.getByText(/Saved to the library/)).toBeVisible({ timeout: 15_000 });
  const note = await page.evaluate(async () => {
    try {
      const root = await navigator.storage.getDirectory();
      const lib = await root.getDirectoryHandle("Library");
      return await (await (await lib.getFileHandle("Bridge Test Story.md")).getFile()).text();
    } catch (e) {
      return `missing: ${(e as Error).message}`;
    }
  });
  expect(note).toContain('source: "https://news.example/story?utm_source=x"');
  expect(note).toContain("# Bridge Test Story");
  expect(note).toContain("> ==second paragraph closes the story==");
  expect(note).toContain("The first paragraph of the clipped story");
  expect(note).not.toMatch(/Accept all cookies|All rights reserved|About us/);
  expect(requests).toEqual([]);
});
