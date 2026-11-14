import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W5.17 (with W4.18's open item): the RTL matrix of 9.5 in Arabic.
 * One note in Arabic, Hebrew and English — a heading, paragraphs in each
 * language, a table with cells in all three, a list in each (different
 * markers, so each is its own list), quotes, a pointed (tashkeel) line and
 * code with an Arabic comment — with the interface in Arabic. Each block
 * takes the direction of its own text (renderer/rehypeDirAuto.ts,
 * editor/wysiwygBidi.ts), code stays left-to-right. Checked on the real
 * browser's computed direction in the preview and WYSIWYG, and in the HTML
 * export. Arabic stays "beta" in the language picker (W4.18) until a native
 * speaker reviews the interface strings.
 */
const NOTE = [
  "# مقدمة الدراسة",
  "",
  "هذه فقرة عربية مع some English words في الوسط.",
  "",
  "זו פסקה בעברית באותו פתק.",
  "",
  "An English paragraph.",
  "",
  "مَدْرَسَةٌ جَمِيلَةٌ فِي المَدِينَةِ.",
  "",
  "| الاسم | שם | Name |",
  "| --- | --- | --- |",
  "| تفاح | תפוחים | apples |",
  "",
  "- العنصر الأول",
  "- العنصر الثاني",
  "",
  "+ פריט בעברית",
  "",
  "* An English item",
  "",
  "> اقتباس بالعربية.",
  "",
  "> ציטוט בעברית.",
  "",
  "```js",
  "const total = 1; // تعليق بالعربية",
  "```",
  "",
].join("\n");

async function open(page: Page, mode: "preview" | "wysiwyg") {
  await page.addInitScript(
    ({ content, mode }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "ar", mode, doc: { name: "عربي.md", content, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { content: NOTE, mode },
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "ar");
}

/** [first text, computed direction] for each element matched under `root`. */
async function dirs(page: Page, root: string, selector: string) {
  return page.locator(root).first().locator(selector).evaluateAll((els) => els.map((el) => [(el.textContent ?? "").trim().slice(0, 14), getComputedStyle(el).direction] as const));
}
const dirOf = (rows: ReadonlyArray<readonly [string, string]>, prefix: string) => rows.find(([t]) => t.startsWith(prefix))?.[1];

test.describe("interface in Arabic", () => {
  test("preview: each block in its own direction, code left-to-right", async ({ page }) => {
    await open(page, "preview");
    const preview = page.locator(".prose-lumen").first();
    await expect(preview.locator("h1")).toContainText("مقدمة", { timeout: 15_000 });
    const blocks = await dirs(page, ".prose-lumen", "h1, p");
    expect(dirOf(blocks, "مقدمة")).toBe("rtl");
    expect(dirOf(blocks, "هذه فقرة")).toBe("rtl");
    expect(dirOf(blocks, "זו פסקה")).toBe("rtl");
    expect(dirOf(blocks, "An English")).toBe("ltr");
    expect(dirOf(blocks, "مَدْرَسَةٌ")).toBe("rtl");
    const cells = await dirs(page, ".prose-lumen", "th, td");
    expect(dirOf(cells, "الاسم")).toBe("rtl");
    expect(dirOf(cells, "שם")).toBe("rtl");
    expect(dirOf(cells, "Name")).toBe("ltr");
    expect(dirOf(cells, "apples")).toBe("ltr");
    const lists = await dirs(page, ".prose-lumen", "ul");
    expect(dirOf(lists, "العنصر الأول")).toBe("rtl");
    expect(dirOf(lists, "פריט בעברית")).toBe("rtl");
    expect(dirOf(lists, "An English")).toBe("ltr");
    const quotes = await dirs(page, ".prose-lumen", "blockquote");
    expect(dirOf(quotes, "اقتباس")).toBe("rtl");
    expect(dirOf(quotes, "ציטוט")).toBe("rtl");
    expect(await preview.locator(".code-block, pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
    // The tashkeel is rendered, not dropped.
    await expect(preview.locator("p", { hasText: "جَمِيلَةٌ" })).toHaveCount(1);
    expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
  });

  test("wysiwyg: each block in its own direction", async ({ page }) => {
    await open(page, "wysiwyg");
    const pm = page.locator(".ProseMirror").first();
    await expect(pm.locator("h1")).toContainText("مقدمة", { timeout: 15_000 });
    const blocks = await dirs(page, ".ProseMirror", "h1, p");
    expect(dirOf(blocks, "مقدمة")).toBe("rtl");
    expect(dirOf(blocks, "هذه فقرة")).toBe("rtl");
    expect(dirOf(blocks, "זו פסקה")).toBe("rtl");
    expect(dirOf(blocks, "An English")).toBe("ltr");
    expect(dirOf(blocks, "apples")).toBe("ltr");
    expect(dirOf(blocks, "تفاح")).toBe("rtl");
    const lists = await dirs(page, ".ProseMirror", "ul");
    expect(dirOf(lists, "العنصر الأول")).toBe("rtl");
    expect(dirOf(lists, "An English")).toBe("ltr");
    expect(await pm.locator("pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
  });

  test("HTML export: Arabic document, the directions written into the file", async ({ page }) => {
    await open(page, "preview");
    await expect(page.locator(".prose-lumen h1").first()).toContainText("مقدمة", { timeout: 15_000 });
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
    expect(html).toMatch(/<html lang="ar" dir="rtl"/);
    expect(html).toMatch(/<ul[^>]*dir="rtl"[^>]*>\s*<li[^>]*>\s*(<p[^>]*>)?العنصر الأول/);
    expect(html).toMatch(/<ul[^>]*dir="ltr"[^>]*>\s*<li[^>]*>\s*(<p[^>]*>)?An English/);
    expect(html).toMatch(/<blockquote[^>]*dir="rtl"[^>]*>\s*<p[^>]*>اقتباس/);
  });
});
