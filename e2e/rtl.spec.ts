import { test, expect, type Page } from "@playwright/test";

/**
 * T25 — a note that mixes Hebrew and English reads correctly line by line
 * and block by block: the Hebrew paragraph sits on the right, the English
 * one on the left, code always left-to-right. Checked on the *computed*
 * direction in the real browser, in all three editing surfaces.
 */

const NOTE = ["# כותרת בעברית", "", "פסקה ראשונה בעברית, עם a few English words.", "", "An English paragraph after it.", "", "```js", "const x = 1; // קוד", "```", "", "- פריט ראשון", "- second item", ""].join("\n");

async function loadNote(page: Page) {
  await page.keyboard.press("Meta+1"); // source
  const source = page.locator(".cm-content").first();
  await source.click();
  await source.press("ControlOrMeta+a");
  await source.fill(NOTE);
}

const direction = (el: Element) => getComputedStyle(el).direction;

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 15_000 });
});

test("source editor: each line takes its own direction, code stays ltr", async ({ page }) => {
  await loadNote(page);
  const lines = page.locator(".cm-content .cm-line");
  await expect(lines.first()).toHaveAttribute("dir", "rtl");
  const dirs = await lines.evaluateAll((els) => els.map((el) => [el.textContent?.trim().slice(0, 12) ?? "", getComputedStyle(el).direction]));
  const by = (prefix: string) => dirs.find(([t]) => t.startsWith(prefix))?.[1];
  expect(by("# כותרת")).toBe("rtl");
  expect(by("פסקה ראשונה")).toBe("rtl");
  expect(by("An English")).toBe("ltr");
  expect(by("const x")).toBe("ltr"); // inside the fence, despite the Hebrew comment
  expect(by("- פריט")).toBe("rtl");
  expect(by("- second")).toBe("ltr");
  // The editor chrome (gutter) stays on the left.
  expect(await page.locator(".cm-editor").first().evaluate(direction)).toBe("ltr");
});

test("preview: each block takes its own direction, code and tables stay ltr", async ({ page }) => {
  await loadNote(page);
  await page.keyboard.press("Meta+2"); // split
  const preview = page.locator(".prose-lumen").first();
  await expect(preview.locator("h1")).toContainText("כותרת", { timeout: 10_000 });
  expect(await preview.locator("h1").first().evaluate(direction)).toBe("rtl");
  const paragraphs = preview.locator("p");
  expect(await paragraphs.nth(0).evaluate(direction)).toBe("rtl");
  expect(await paragraphs.nth(1).evaluate(direction)).toBe("ltr");
  expect(await preview.locator(".code-block, pre").first().evaluate(direction)).toBe("ltr");
  const items = preview.locator("li");
  expect(await items.nth(0).evaluate(direction)).toBe("rtl");
  expect(await items.nth(1).evaluate(direction)).toBe("ltr");
  // Logical CSS: the Hebrew list indents on its right, the English one on its left.
  const pad = await preview.locator("ul").first().evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
  });
  // The <ul> itself has mixed items and resolves from its first (Hebrew) item.
  expect(pad.right).toBeGreaterThan(pad.left);
});

test("wysiwyg: each block takes its own direction, code stays ltr", async ({ page }) => {
  await loadNote(page);
  await page.keyboard.press("Meta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await expect(pm.locator("h1")).toContainText("כותרת");
  expect(await pm.locator("h1").first().evaluate(direction)).toBe("rtl");
  const paragraphs = pm.locator("p");
  expect(await paragraphs.nth(0).evaluate(direction)).toBe("rtl");
  expect(await paragraphs.nth(1).evaluate(direction)).toBe("ltr");
  expect(await pm.locator("pre").first().evaluate(direction)).toBe("ltr");
});

test("export: a Hebrew note is written as <html dir=\"rtl\" lang=\"he\">", async ({ page }) => {
  await loadNote(page);
  // The real export command (a download), so this also holds for the
  // production bundle, which has no /src to import from.
  const downloadPromise = page.waitForEvent("download", { timeout: 15_000 });
  await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "file.exportHtml" } })));
  const download = await downloadPromise;
  const stream = await download.createReadStream();
  const html = await new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    stream.on("data", (c: Buffer) => chunks.push(c));
    stream.on("end", () => resolve(Buffer.concat(chunks).toString("utf8")));
    stream.on("error", reject);
  });
  expect(download.suggestedFilename()).toMatch(/\.html$/);
  expect(html).toMatch(/<html lang="he" dir="rtl"/);
  expect(html).toMatch(/<p dir="auto">An English paragraph/);
});
