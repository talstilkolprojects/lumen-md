import { test, expect } from "@playwright/test";

/**
 * Plan W1.30 — "Always allow" for an image host, then revoking it on the
 * allowed-hosts screen: the image is blocked again at once (placeholder, no
 * new request), and the choice is gone from storage.
 */

const HOST = "img.lumen-e2e.test";
const GIF = Buffer.from("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7", "base64");

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen.remoteImages.allowedHosts");
  });
});

test("allow a host, revoke it, and its image is blocked again", async ({ page }) => {
  const requests: string[] = [];
  page.on("request", (r) => {
    if (new URL(r.url()).hostname === HOST) requests.push(new URL(r.url()).pathname);
  });
  await page.route(`https://${HOST}/**`, (route) => route.fulfill({ status: 200, contentType: "image/gif", body: GIF }));
  await page.goto("/");
  const editor = page.locator(".cm-content").first();
  await editor.click();
  await editor.fill(`# Hosts\n\n![one](https://${HOST}/one.gif)\n`);

  const preview = page.locator(".prose-lumen").first();
  const placeholder = preview.locator(".lumen-remote-image");
  await expect(placeholder).toHaveCount(1, { timeout: 10_000 });

  // Approve: "Always allow".
  await placeholder.getByRole("button", { name: `Always allow ${HOST}` }).click();
  await expect(preview.locator(`img[src="https://${HOST}/one.gif"]`)).toBeVisible();
  await expect.poll(() => requests).toEqual(["/one.gif"]);

  // The screen lists it; revoke.
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "privacy.imageHosts" } })));
  const dialog = page.getByRole("dialog", { name: "Allowed image hosts" });
  await expect(dialog.getByTestId("image-hosts")).toContainText(HOST);
  await dialog.getByRole("button", { name: `Stop always allowing ${HOST}` }).click();
  await expect(dialog.getByTestId("image-hosts-empty")).toBeVisible();
  await page.keyboard.press("Escape");

  // Blocked again: the placeholder is back, the image is gone, nothing new was requested.
  await expect(placeholder).toHaveCount(1);
  await expect(preview.locator(`img[src^="https://${HOST}"]`)).toHaveCount(0);
  expect(await page.evaluate(() => localStorage.getItem("lumen.remoteImages.allowedHosts"))).toBe("[]");
  // A new image from the host stays blocked too.
  await editor.click();
  await page.keyboard.press("ControlOrMeta+End");
  await page.keyboard.type(`\n![two](https://${HOST}/two.gif)\n`);
  await expect(placeholder).toHaveCount(2);
  await page.waitForLoadState("networkidle");
  expect(requests).toEqual(["/one.gif"]);
});
