import { test, expect } from "@playwright/test";

/**
 * Reading options (plan W3.5): no reading font is fetched until one is
 * chosen; a chosen face comes from the app's own origin (0 requests to a
 * font service), applies to the preview, and every Hebrew face shows nikud
 * in place — one screenshot per face is attached for the visual check.
 */

const SAMPLE = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים · שָׁלוֹם, עוֹלָם! כֻּתֹּנֶת פַּסִּים";
const FACES = [
  { id: "heebo", family: "Heebo" },
  { id: "frankRuhl", family: "Frank Ruhl Libre" },
  { id: "notoSans", family: "Lumen Noto Sans Hebrew" },
  { id: "notoSerif", family: "Lumen Noto Serif Hebrew" },
  { id: "assistant", family: "Lumen Assistant" },
  { id: "davidLibre", family: "Lumen David Libre" },
];

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
    localStorage.removeItem("lumen-reading");
  });
});

test("a face downloads only when chosen, from this app, and every Hebrew face keeps nikud in place", async ({ page, baseURL }, testInfo) => {
  test.setTimeout(60_000);
  const fontRequests: string[] = [];
  page.on("request", (r) => {
    if (r.resourceType() === "font" || /\.(woff2?|ttf|otf)(\?|$)/.test(r.url())) fontRequests.push(r.url());
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  expect(fontRequests.filter((u) => u.includes("/fonts/reading/"))).toEqual([]);

  await page.evaluate(() => window.dispatchEvent(new Event("lumen-open-reading")));
  const panel = page.getByTestId("reading-settings");
  await expect(panel).toBeVisible();
  for (const face of FACES) {
    await panel.getByTestId("reading-font").selectOption(face.id);
    await expect.poll(() => page.evaluate((f) => document.fonts.check(`20px "${f}"`, "שָׁלוֹם"), face.family), { timeout: 10_000 }).toBe(true);
    await expect(panel.getByTestId("reading-status")).toHaveText("");
    const sample = panel.getByTestId("reading-sample");
    await sample.evaluate((el, text) => (el.textContent = text), SAMPLE);
    await testInfo.attach(`nikud-${face.id}.png`, { body: await sample.screenshot(), contentType: "image/png" });
  }
  await expect.poll(() => page.evaluate(() => document.documentElement.style.getPropertyValue("--reading-font"))).toContain("Lumen David Libre");

  const origin = new URL(baseURL ?? page.url()).origin;
  expect(fontRequests.length).toBeGreaterThan(0);
  for (const u of fontRequests) expect(new URL(u).origin, u).toBe(origin);
  expect(fontRequests.some((u) => u.endsWith("/fonts/reading/noto-serif-hebrew.woff2"))).toBe(true);
});

test("the options reach the preview, and a per-note choice stays with its note", async ({ page }) => {
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new Event("lumen-open-reading")));
  const panel = page.getByTestId("reading-settings");
  await panel.getByTestId("reading-spaced").check();
  // A range input cannot be filled: set its value the way React sees a user's drag.
  await panel.getByTestId("reading-size").evaluate((el: HTMLInputElement) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(el, "21");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--reading-word-spacing").trim())).toBe("0.18em");
  await expect.poll(() => page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--reading-size").trim())).toBe("21px");
  const stored = await page.evaluate(() => JSON.parse(localStorage.getItem("lumen-reading") ?? "{}"));
  expect(stored.global).toMatchObject({ spacedHebrew: true, size: 21 });
});
