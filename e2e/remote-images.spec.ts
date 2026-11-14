import { test, expect, type Page, type Request } from "@playwright/test";

/**
 * Plan 2.2 — a tracking pixel in a note makes no request until the user
 * allows it. A static CSP cannot hold one user's choices, so this is the
 * renderer's job: the preview shows a placeholder with "Load" (this image)
 * and "Always allow" (its host). Since plan W4.15 the app's own CSP has no
 * `https:` in img-src / media-src and frames only itself: an allowed image,
 * video or embed renders inside /content-frame.html, the page with its own
 * policy.
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

/** What the content frames in the preview show: "kind src" (the request in their #fragment). */
async function framed(page: Page): Promise<string[]> {
  return page.locator(".prose-lumen iframe[data-content-frame]").evaluateAll((frames) =>
    frames.map((f) => {
      const req = JSON.parse(decodeURIComponent((f.getAttribute("src") ?? "").split("#")[1] ?? "null")) as { kind: string; src?: string; user?: string; id?: string } | null;
      return `${req?.kind} ${req?.src ?? `${req?.user}/${req?.id}`}`;
    }),
  );
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

  // "Load": this image only — inside the content frame, never an <img> in the app.
  await placeholders.first().getByRole("button", { name: "Load" }).click();
  await expect.poll(() => framed(page)).toEqual([`img https://${TRACKER}/md.gif?reader=1`]);
  await expect(page.frameLocator(".prose-lumen iframe[data-content-frame]").first().locator(`img[src^="https://${TRACKER}/md.gif"]`)).toBeVisible();
  await expect(placeholders).toHaveCount(3);
  await expect.poll(() => requests.map((r) => new URL(r.url()).pathname)).toEqual(["/md.gif"]);
  // The frame reported the image's size (1×1 GIF).
  await expect(preview.locator("iframe[data-content-frame]").first()).toHaveCSS("width", "1px");

  // "Always allow": every image from the host, kept in this browser.
  await placeholders.first().getByRole("button", { name: `Always allow ${TRACKER}` }).click();
  await expect(placeholders).toHaveCount(0);
  await expect
    .poll(() => framed(page))
    .toEqual([
      `img https://${TRACKER}/md.gif?reader=1`,
      `img https://${TRACKER}/raw.gif`,
      `img https://${TRACKER}/picture.gif`,
      `video https://${TRACKER}/v.mp4`,
    ]);
  await expect(preview.locator(`img[src^="https://${TRACKER}"], video[src^="https://${TRACKER}"]`)).toHaveCount(0);
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

test("the app's own policy has no https: in img-src / media-src and frames only itself (plan W4.15)", async ({ page }) => {
  await page.goto("/");
  const csp = (await page.locator('meta[http-equiv="Content-Security-Policy"]').getAttribute("content")) ?? "";
  const directive = (name: string) => (new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(csp)?.[1] ?? "").trim().split(/\s+/);
  expect(directive("img-src")).not.toContain("https:");
  expect(directive("media-src")).not.toContain("https:");
  expect(directive("frame-src")).toEqual(["'self'"]);
});

test("an embed block makes 0 requests until Load; then the player runs in the content frame", async ({ page }) => {
  const player: string[] = [];
  await page.route("https://www.youtube-nocookie.com/**", (route) => {
    player.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>player</title><p>player ok</p>" });
  });
  const gist: string[] = [];
  await page.route("https://gist.github.com/**", (route) => {
    gist.push(route.request().url());
    return route.fulfill({ status: 200, contentType: "text/javascript", body: `document.write('<div class="gist"><p>gist ok</p></div>')` });
  });
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(
    ["# Embeds", "", "```embed", "https://www.youtube.com/watch?v=dQw4w9WgXcQ", "```", "", "```embed", "https://gist.github.com/someone/abc123", "```", ""].join("\n"),
  );
  const preview = page.locator(".prose-lumen").first();
  const gates = preview.locator("[data-remote-frame]");
  await expect(gates).toHaveCount(2, { timeout: 15_000 });
  await page.waitForLoadState("networkidle");
  expect(player).toEqual([]);
  expect(gist).toEqual([]);
  await expect(preview.locator("iframe")).toHaveCount(0);

  await preview.locator('[data-remote-frame="www.youtube-nocookie.com"]').getByRole("button", { name: "Load" }).click();
  await expect.poll(() => framed(page)).toEqual(["embed https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);
  const yt = page.frameLocator('.prose-lumen iframe[data-content-frame="embed"]').frameLocator("iframe");
  await expect(yt.getByText("player ok")).toBeVisible();
  expect(player).toEqual(["https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"]);

  // A Gist: GitHub's embed script, in an opaque-origin content frame (it used
  // to be a data: page that inherited the app's script-src and never rendered).
  await preview.locator('[data-remote-frame="gist.github.com"]').getByRole("button", { name: "Load" }).click();
  const g = page.frameLocator('.prose-lumen iframe[data-content-frame="gist"]');
  await expect(g.getByText("gist ok")).toBeVisible();
  expect(gist).toEqual(["https://gist.github.com/someone/abc123.js"]);
  await expect(preview.locator('iframe[data-content-frame="gist"]')).toHaveAttribute("sandbox", "allow-scripts allow-popups allow-popups-to-escape-sandbox");
});
