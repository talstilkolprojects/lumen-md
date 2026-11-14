import { test, expect } from "@playwright/test";
import { testHooks, type LumenTestWindow } from "./_lumen";

/**
 * T31 — on-device OCR reads Hebrew and English from an image. The language
 * models are served from this origin (public/tesseract/lang/, plan 7.5), so
 * the test needs no network. The CER on the golden set is measured by
 * ocr-cer.spec.ts.
 */
test("OCR reads Hebrew and English text from an image on this device", async ({ page }) => {
  test.setTimeout(180_000);
  await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
  // The OCR module through window.__lumenTest (e2e/_lumen.ts): the dev
  // server and the gate's production build alike.
  await testHooks(page);
  const text = await page.evaluate(async () => {
    const c = document.createElement("canvas");
    c.width = 900;
    c.height = 260;
    const g = c.getContext("2d")!;
    g.fillStyle = "#fff";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#000";
    g.font = "56px Arial";
    g.direction = "rtl";
    g.textAlign = "right";
    g.fillText("שלום עולם", 860, 100);
    g.direction = "ltr";
    g.textAlign = "left";
    g.fillText("Hello world", 40, 210);
    const mod = await (window as unknown as LumenTestWindow).__lumenTest.load("ai/ocr");
    return (await mod.ocrImage(c)).text as string;
  });
  expect(text).toMatch(/שלום/);
  expect(text).toMatch(/Hello/i);
});
