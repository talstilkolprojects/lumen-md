import { test, expect, type Page } from "@playwright/test";

/**
 * Plan W1.4 — pasting HTML from Word / Google Docs / a Hebrew site lands as
 * clean Markdown in the source editor, and as real structure in WYSIWYG,
 * with no inline style and no stray direction marks.
 */

const WORD =
  '<html xmlns:o="urn:schemas-microsoft-com:office:office"><body dir=RTL><!--StartFragment-->' +
  "<h2 dir=RTL style='text-align:right'>סיכום</h2>" +
  "<p class=MsoListParagraph dir=RTL style='mso-list:l0 level1 lfo1'><span style='mso-list:Ignore'>·</span><span style='color:red'>פריט ראשון</span></p>" +
  "<p class=MsoListParagraph dir=RTL style='mso-list:l0 level2 lfo1'><span style='mso-list:Ignore'>o</span>תת פריט</p>" +
  "<p class=MsoNormal dir=RTL><b>מודגש</b> ו<a href='https://example.org'>קישור</a>.</p><!--EndFragment--></body></html>";

const MD = "## סיכום\n\n- פריט ראשון\n  - תת פריט\n\n**מודגש** ו[קישור](https://example.org).";

async function paste(page: Page, selector: string, html: string, text: string): Promise<void> {
  await page.locator(selector).first().click();
  await page.evaluate(
    ([sel, h, t]) => {
      const el = document.querySelector(sel)!;
      const dt = new DataTransfer();
      dt.setData("text/html", h);
      dt.setData("text/plain", t);
      el.dispatchEvent(new ClipboardEvent("paste", { clipboardData: dt, bubbles: true, cancelable: true }));
    },
    [selector, html, text] as const,
  );
}

type View = { state: { doc: { length: number; toString(): string } }; dispatch(tr: unknown): void };
const source = (page: Page) =>
  page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    return el?.cmTile?.root?.view?.state.doc.toString() ?? "";
  });

test.beforeEach(async ({ page }) => {
  await page.addInitScript(() => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.removeItem("lumen-md");
  });
  await page.goto("/");
  await expect(page.locator(".cm-content").first()).toContainText("Welcome to", { timeout: 20_000 });
  await page.keyboard.press("Meta+1");
  await page.evaluate(() => {
    const el = document.querySelector(".cm-content") as (HTMLElement & { cmTile?: { root?: { view?: View } } }) | null;
    const v = el?.cmTile?.root?.view;
    v?.dispatch({ changes: { from: 0, to: v.state.doc.length, insert: "" } });
  });
});

test("source editor: Word HTML pastes as clean Markdown", async ({ page }) => {
  await paste(page, ".cm-content", WORD, "סיכום\nפריט ראשון\nתת פריט\nמודגש וקישור.");
  await expect.poll(() => source(page)).toBe(MD);
  const text = await source(page);
  expect(text).not.toMatch(/style=|mso-|<span/);
  expect(text).not.toMatch(/[\u200E\u200F\u202A-\u202E]/);
});

test("source editor: code copied from an editor stays plain text", async ({ page }) => {
  await paste(page, ".cm-content", '<div style="font-family:Consolas;color:#d4d4d4"><span>const x = 1;</span></div>', "const x = 1;");
  await expect.poll(() => source(page)).toBe("const x = 1;");
});

test("WYSIWYG: Word HTML pastes as headings, nested lists and links", async ({ page }) => {
  await page.keyboard.press("Meta+4");
  const pm = page.locator(".ProseMirror").first();
  await expect(pm).toBeVisible({ timeout: 10_000 });
  await paste(page, ".ProseMirror", WORD, "סיכום");
  await expect(pm.locator("h2")).toHaveText("סיכום");
  await expect(pm.locator("ul ul li")).toHaveText("תת פריט");
  await expect(pm.locator("a[href='https://example.org']")).toHaveText("קישור");
  await expect(pm.locator("[style*='color']")).toHaveCount(0);
});
