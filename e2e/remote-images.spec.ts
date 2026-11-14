import { test, expect, type Page, type Request } from "@playwright/test";

/**
 * Plan 2.2 — a tracking pixel in a note makes no request until the user
 * allows it. The web CSP keeps `img-src https:` (it cannot hold one user's
 * choices), so this is the renderer's job: the preview shows a placeholder
 * with "Load" (this image) and "Always allow" (its host).
 *
 * The tracker host is fake; Playwright answers it, so the test never leaves
 * the machine.
 */

const TRACKER = "tracker.lumen-e2e.test";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

async function watchTracker(page: Page): Promise<Request[]> {
  const seen: Request[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === TRACKER) seen.push(r);
  });
  await page.route(`https://${TRACKER}/**`, (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
  return seen;
}

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen.remoteImages.allowedHosts");
  });
});

test("a tracking pixel makes 0 requests until the user loads or allows it", async ({ page }) => {
  const requests = await watchTracker(page);
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    [
      "# Remote images",
      "",
      `Markdown pixel: ![pixel](https://${TRACKER}/md.gif?reader=1)`,
      "",
      `<p>Raw HTML: <img src="https://${TRACKER}/raw.gif" alt="raw pixel"></p>`,
      "",
      `<picture><source srcset="https://${TRACKER}/picture.webp" type="image/webp"><img src="https://${TRACKER}/picture.gif" alt="picture"></picture>`,
      "",
      `<video src="https://${TRACKER}/v.mp4" poster="https://${TRACKER}/poster.gif" autoplay muted></video>`,
      "",
    ].join("\n"),
  );

  const preview = page.locator(".prose-lumen").first();
  const placeholders = preview.locator(".lumen-remote-image");
  // md pixel, raw <img>, <picture>'s <img>, and the <video> (WebKit would
  // fetch its src despite preload="none").
  await expect(placeholders).toHaveCount(4, { timeout: 10_000 });
  await expect(placeholders.first()).toContainText(TRACKER);
  await page.waitForLoadState("networkidle");
  expect(requests.map((r) => r.url())).toEqual([]);
  await expect(preview.locator(`img[src^="https://${TRACKER}"]`)).toHaveCount(0);

  // "Load": this image only.
  await placeholders.first().getByRole("button", { name: "Load" }).click();
  await expect(preview.locator(`img[src^="https://${TRACKER}/md.gif"]`)).toBeVisible();
  await expect(placeholders).toHaveCount(3);
  await expect.poll(() => requests.map((r) => new URL(r.url()).pathname)).toEqual(["/md.gif"]);

  // "Always allow": every image from the host, kept in this browser.
  await placeholders.first().getByRole("button", { name: `Always allow ${TRACKER}` }).click();
  await expect(placeholders).toHaveCount(0);
  await expect(preview.locator(`img[src="https://${TRACKER}/raw.gif"]`)).toBeVisible();
  await expect(preview.locator(`video[src="https://${TRACKER}/v.mp4"]`)).toHaveCount(1);
  await expect
    .poll(() => new Set(requests.map((r) => new URL(r.url()).pathname).filter((p) => p !== "/v.mp4")))
    .toEqual(new Set(["/md.gif", "/raw.gif", "/picture.gif"]));
  // The other-site <source> and the poster were removed: never fetched.
  // (The video itself may load now: its host was allowed.)
  expect(requests.map((r) => new URL(r.url()).pathname)).not.toContain("/picture.webp");
  expect(requests.map((r) => new URL(r.url()).pathname)).not.toContain("/poster.gif");
  expect(await page.evaluate(() => localStorage.getItem("lumen.remoteImages.allowedHosts"))).toBe(JSON.stringify([TRACKER]));
});

test("the page's connect-src names its WebSocket hosts: no bare ws: / wss:", async ({ page }) => {
  await page.goto("/");
  const csp = await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content");
  const connect = (/connect-src ([^;]*)/.exec(csp ?? "")?.[1] ?? "").trim().split(/\s+/);
  expect(connect).toContain("wss://signaling.yjs.dev");
  expect(connect.filter((s) => s === "ws:" || s === "wss:")).toEqual([]);
});
