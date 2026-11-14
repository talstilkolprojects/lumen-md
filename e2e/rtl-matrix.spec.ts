import { test, expect, devices, type Page } from "@playwright/test";
import { RTL_NOTE as NOTE } from "./rtl-note";

/**
 * Plan 9.5 — the extended RTL matrix: tables, lists (bulleted, numbered,
 * nested, tasks), code and quotes, in a Hebrew note and a mixed one, on
 * every surface that shows them — preview, WYSIWYG and the HTML export —
 * with the interface in Hebrew and in English; then the same note on two
 * phones (iPhone 14, Pixel 7).
 *
 * The rules under test (renderer/rehypeDirAuto.ts, editor/wysiwygBidi.ts):
 * a leaf block (paragraph, heading, cell) takes the direction of its own
 * first strong character (`dir="auto"`); a container (list, item, quote)
 * gets the direction of its text; code is always left-to-right; in the
 * preview and the export a table as a whole is left-to-right while each
 * cell resolves on its own.
 *
 * Every check is on the real browser's computed direction or on the
 * exported HTML. The desktop part runs in all three browser projects; the
 * phone part emulates the devices on Chromium (like e2e/touch.spec.ts).
 */



type Locale = "en" | "he";

async function open(page: Page, locale: Locale, mode: "preview" | "wysiwyg" | "split" = "preview") {
  await page.addInitScript(
    ({ locale, content, mode }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale, mode, doc: { name: "RTL.md", content, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { locale, content: NOTE, mode },
  );
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
}

/**
 * [first text, computed direction, dir attribute] for each element matched under `root`.
 * The WYSIWYG editor's block drag handle (a `<button>` with "⠿" in a `<bdi>`,
 * src/editor/dragHandles.ts) sits at the start of every top-level block; its
 * glyph is not the block's text, so it is left out of the text compared here.
 */
async function dirs(page: Page, root: string, selector: string) {
  return page.locator(root).first().locator(selector).evaluateAll((els) =>
    els.map((el) => {
      const copy = el.cloneNode(true) as HTMLElement;
      for (const h of copy.querySelectorAll(".lumen-drag-handle")) h.remove();
      return [(copy.textContent ?? "").trim().slice(0, 14), getComputedStyle(el).direction, el.getAttribute("dir") ?? ""] as const;
    }),
  );
}

const dirOf = (rows: ReadonlyArray<readonly [string, string, string]>, prefix: string) => rows.find(([t]) => t.startsWith(prefix))?.[1];

async function checkPreviewBlocks(page: Page) {
  const preview = page.locator(".prose-lumen").first();
  await expect(preview.locator("h1")).toContainText("טבלאות", { timeout: 15_000 });
  const root = ".prose-lumen";

  // Paragraphs and headings: their own text decides.
  const blocks = await dirs(page, root, "h1, p");
  expect(dirOf(blocks, "טבלאות")).toBe("rtl");
  expect(dirOf(blocks, "פסקה בעברית")).toBe("rtl");
  expect(dirOf(blocks, "An English")).toBe("ltr");

  // Tables: the table itself left-to-right, each cell by its own text.
  const table = preview.locator("table").first();
  await expect(table).toHaveAttribute("dir", "ltr");
  const cells = await dirs(page, root, "th, td");
  expect(dirOf(cells, "שם")).toBe("rtl");
  expect(dirOf(cells, "Note")).toBe("ltr");
  expect(dirOf(cells, "תפוחים")).toBe("rtl");
  expect(dirOf(cells, "fresh")).toBe("ltr");
  expect(dirOf(cells, "Pears")).toBe("ltr");
  expect(dirOf(cells, "אגסים")).toBe("rtl");

  // Lists: Hebrew lists right-to-left (markers and indent on the right), the English one left-to-right.
  const lists = await dirs(page, root, "ul, ol");
  expect(dirOf(lists, "פריט ראשון")).toBe("rtl");
  expect(dirOf(lists, "First English")).toBe("ltr");
  expect(dirOf(lists, "צעד אחד")).toBe("rtl");
  expect(dirOf(lists, "משימה שהושלמה")).toBe("rtl");
  const items = await dirs(page, root, "li");
  expect(dirOf(items, "פריט מקונן")).toBe("rtl");
  expect(dirOf(items, "Second English")).toBe("ltr");
  const hebrewList = preview.locator("ul").first();
  const pad = await hebrewList.evaluate((el) => {
    const s = getComputedStyle(el);
    return { left: parseFloat(s.paddingLeft), right: parseFloat(s.paddingRight) };
  });
  expect(pad.right).toBeGreaterThan(pad.left);

  // Quotes: the bar on the side the text starts from.
  const quotes = await dirs(page, root, "blockquote");
  expect(dirOf(quotes, "ציטוט בעברית")).toBe("rtl");
  expect(dirOf(quotes, "A quote in")).toBe("ltr");

  // Code: always left-to-right, Hebrew comment or not.
  expect(await preview.locator(".code-block, pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
}

for (const locale of ["he", "en"] as const) {
  test.describe(`interface in ${locale}`, () => {
    test("preview: tables, lists, quotes, code", async ({ page }) => {
      await open(page, locale, "preview");
      await checkPreviewBlocks(page);
    });

    test("wysiwyg: tables, lists, quotes, code", async ({ page }) => {
      await open(page, locale, "wysiwyg");
      const pm = page.locator(".ProseMirror").first();
      await expect(pm.locator("h1")).toContainText("טבלאות", { timeout: 15_000 });
      const root = ".ProseMirror";
      const blocks = await dirs(page, root, "h1, p");
      expect(dirOf(blocks, "טבלאות")).toBe("rtl");
      expect(dirOf(blocks, "פסקה בעברית")).toBe("rtl");
      expect(dirOf(blocks, "An English")).toBe("ltr");
      // Cells hold paragraphs, which take their own direction.
      expect(dirOf(blocks, "תפוחים")).toBe("rtl");
      expect(dirOf(blocks, "fresh")).toBe("ltr");
      expect(dirOf(blocks, "אגסים")).toBe("rtl");
      const lists = await dirs(page, root, "ul, ol");
      expect(dirOf(lists, "פריט ראשון")).toBe("rtl");
      expect(dirOf(lists, "First English")).toBe("ltr");
      expect(dirOf(lists, "צעד אחד")).toBe("rtl");
      const quotes = await dirs(page, root, "blockquote");
      expect(dirOf(quotes, "ציטוט בעברית")).toBe("rtl");
      expect(dirOf(quotes, "A quote in")).toBe("ltr");
      expect(await pm.locator("pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
    });

    test("HTML export: the same directions are written into the file", async ({ page }) => {
      await open(page, locale, "preview");
      await expect(page.locator(".prose-lumen h1").first()).toContainText("טבלאות", { timeout: 15_000 });
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
      // The note's first strong character is Hebrew.
      expect(html).toMatch(/<html lang="he" dir="rtl"/);
      expect(html).toMatch(/<table[^>]*dir="ltr"/);
      expect(html).toMatch(/<td[^>]*dir="auto"[^>]*>תפוחים/);
      expect(html).toMatch(/<ul[^>]*dir="rtl"[^>]*>\s*<li[^>]*>\s*(<p[^>]*>)?פריט ראשון/);
      expect(html).toMatch(/<ul[^>]*dir="ltr"[^>]*>\s*<li[^>]*>\s*(<p[^>]*>)?First English/);
      expect(html).toMatch(/<ol[^>]*dir="rtl"/);
      expect(html).toMatch(/<blockquote[^>]*dir="rtl"[^>]*>\s*<p[^>]*>ציטוט/);
      expect(html).toMatch(/<blockquote[^>]*dir="ltr"[^>]*>\s*<p[^>]*>A quote/);
      expect(html).toMatch(/<pre[^>]*dir="ltr"|class="code-block"[^>]*dir="ltr"|dir="ltr"[^>]*class="code-block"/);
    });
  });
}

test("Hebrew interface: the chrome is mirrored and nothing overflows", async ({ page }) => {
  await open(page, "he", "split");
  await expect(page.locator(".prose-lumen h1").first()).toContainText("טבלאות", { timeout: 15_000 });
  expect(await page.locator("header").first().evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
  expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
});

// ── Phones ──────────────────────────────────────────────────────────────
for (const name of ["iPhone 14", "Pixel 7"] as const) {
  test.describe(name, () => {
    // Device emulation (viewport, touch, mobile UA) on Chromium; WebKit's
    // engine itself is covered by the desktop webkit project above.
    const { defaultBrowserType: _engine, ...device } = devices[name];
    test.use(device);
    test.skip(({ browserName }) => browserName !== "chromium", "phones are emulated on Chromium");

    for (const locale of ["he", "en"] as const) {
      test(`preview in ${locale}: the matrix holds and nothing overflows`, async ({ page }) => {
        await open(page, locale, "preview");
        await checkPreviewBlocks(page);
        // A wide table scrolls inside its own box, not the page.
        expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
      });
    }
  });
}
