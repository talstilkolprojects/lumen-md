import { test, expect } from "@playwright/test";

/**
 * Plan 6.7 — the search dialog's Images tab. The converted SigLIP has no
 * host before 15.9, so the tab must say so and make no request for a model;
 * the rest of the dialog keeps working. Tested in English and Hebrew (RTL).
 */
for (const locale of ["en", "he"] as const) {
  test(`image search tab explains a missing model host (${locale})`, async ({ page }) => {
    const pageErrors: string[] = [];
    page.on("pageerror", (e) => pageErrors.push(e.message));
    const modelRequests: string[] = [];
    page.on("request", (r) => {
      if (/siglip|huggingface\.co|\.onnx(\?|$)/i.test(r.url())) modelRequests.push(r.url());
    });
    await page.addInitScript((loc) => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: loc }, version: 0 }));
    }, locale);
    await page.goto("/");
    await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });

    // Open workspace search from the palette (⇧⌘F toggles focus mode first).
    await page.keyboard.press("Meta+K");
    const palette = page.locator('[role="dialog"][aria-modal="true"]').filter({ has: page.locator("input") });
    await palette.waitFor({ timeout: 8000 });
    await palette.locator("input").first().fill(locale === "he" ? "חיפוש במרחב העבודה" : "Search workspace");
    await page.keyboard.press("Enter");
    const tab = page.getByTestId("search-tab-images");
    await expect(tab).toBeVisible({ timeout: 10_000 });
    await expect(tab).toHaveText(locale === "he" ? /תמונות/ : /Images/);
    await tab.click();
    await expect(page.getByTestId("image-search-idle")).toBeVisible();

    await page.keyboard.type(locale === "he" ? "אופניים אדומים" : "a red bicycle");
    const unavailable = page.getByTestId("image-search-unavailable");
    await expect(unavailable).toBeVisible({ timeout: 10_000 });
    await expect(unavailable).not.toContainText("imageSearch.");
    expect(modelRequests).toEqual([]);
    expect(pageErrors).toEqual([]);
  });
}
