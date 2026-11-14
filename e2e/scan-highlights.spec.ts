import { test, expect } from "@playwright/test";
import { opfsWritable, vaultOrSkip } from "./_opfs";

/**
 * Scanning printed highlights (plan W7.2): a page photo made in the browser
 * (printed lines, one under a yellow highlighter, one underlined in pen, a
 * page number in the footer) goes through the scan dialog. The marked lines
 * are read on this device and land in the book's highlights note with the
 * page. No request leaves the origin while it runs (the privacy check).
 */

async function makePage(page: import("@playwright/test").Page, rtl: boolean): Promise<Buffer> {
  const b64 = await page.evaluate(async (rtl) => {
    const c = document.createElement("canvas");
    c.width = 1400;
    c.height = 1800;
    const g = c.getContext("2d")!;
    g.fillStyle = "#f8f5ec";
    g.fillRect(0, 0, c.width, c.height);
    g.fillStyle = "#1e1e22";
    g.font = "40px serif";
    g.direction = rtl ? "rtl" : "ltr";
    g.textAlign = rtl ? "right" : "left";
    const x = rtl ? 1300 : 100;
    const lines = rtl
      ? ["זוהי שורה רגילה בספר מודפס", "המשפט הזה מודגש במרקר צהוב", "עוד שורה רגילה של טקסט", "והשורה הזאת מסומנת בקו של עט", "שורה אחרונה בעמוד"]
      : ["This is an ordinary printed line", "This sentence is under a yellow marker", "Another ordinary line of text here", "And this line is underlined with a pen", "The last line on the page"];
    lines.forEach((l, i) => g.fillText(l, x, 200 + i * 90));
    // Highlighter over line 2, multiplied like ink on paper.
    g.globalCompositeOperation = "multiply";
    g.fillStyle = "rgb(250, 235, 60)";
    g.fillRect(80, 200 + 90 - 44, 1240, 60);
    g.globalCompositeOperation = "source-over";
    // Pen under line 4.
    g.strokeStyle = "rgb(20, 30, 120)";
    g.lineWidth = 3;
    g.beginPath();
    g.moveTo(90, 200 + 3 * 90 + 14);
    g.bezierCurveTo(500, 200 + 3 * 90 + 18, 900, 200 + 3 * 90 + 10, 1310, 200 + 3 * 90 + 16);
    g.stroke();
    g.font = "34px serif";
    g.textAlign = "center";
    g.fillText("- 87 -", 700, 1720);
    const blob: Blob = await new Promise((ok) => c.toBlob((b) => ok(b!), "image/png"));
    const bytes = new Uint8Array(await blob.arrayBuffer());
    let s = "";
    for (const v of bytes) s += String.fromCharCode(v);
    return btoa(s);
  }, rtl);
  return Buffer.from(b64, "base64");
}

for (const rtl of [false, true]) {
  test(`a ${rtl ? "Hebrew" : "English"} page: marks found, read, saved with the page, no network`, async ({ page, browserName }) => {
    test.setTimeout(180_000);
    await page.addInitScript(() => localStorage.setItem("lumen-tour-done", "1"));
    await page.goto("/");
    await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 15_000 });
    vaultOrSkip(await opfsWritable(page), browserName);
    const png = await makePage(page, rtl);
    const origin = new URL(page.url()).origin;
    const outside: string[] = [];
    page.on("request", (r) => {
      if (!r.url().startsWith(origin) && !r.url().startsWith("data:") && !r.url().startsWith("blob:")) outside.push(r.url());
    });
    await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "view.highlights" } })));
    await page.getByTestId("highlights-scan").click();
    const dialog = page.getByTestId("scan-highlights");
    const started = Date.now();
    await dialog.getByTestId("scan-file").setInputFiles({ name: "page.png", mimeType: "image/png", buffer: png });
    await expect(dialog.getByTestId("scan-found")).toBeVisible({ timeout: 120_000 });
    const passages = dialog.getByTestId("scan-passages").locator("li");
    await expect(passages).toHaveCount(2);
    await expect(passages.nth(0)).toContainText(rtl ? "מודגש" : "yellow marker");
    await expect(passages.nth(1)).toContainText(rtl ? "מסומנת" : "underlined");
    await expect(dialog.getByTestId("scan-page")).toHaveValue("87");
    await dialog.getByTestId("scan-title").fill(rtl ? "ספר בדיקה" : "Test Book");
    await dialog.getByTestId("scan-save").click();
    await expect(dialog).toHaveCount(0, { timeout: 15_000 });
    test.info().annotations.push({ type: "photo→saved ms", description: String(Date.now() - started) });
    const note = await page.evaluate(async () => {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle("Highlights");
      for await (const [, h] of (dir as unknown as { entries(): AsyncIterable<[string, FileSystemHandle]> }).entries()) {
        if (h.kind === "file") return (await (h as FileSystemFileHandle).getFile()).text();
      }
      return "";
    });
    expect(note).toContain("p. 87");
    expect(note).toContain(rtl ? "מודגש" : "yellow marker");
    expect(outside).toEqual([]);
  });
}
