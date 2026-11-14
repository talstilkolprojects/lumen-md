import { test, expect, type Page } from "@playwright/test";
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { RTL_NOTE } from "./rtl-note";

/**
 * Plan 9.9 — RTL at Obsidian's level: the whole workspace mirrors in the
 * Hebrew interface (toolbar, panels, tabs, menus, floating controls), and
 * the arrow keys keep their visual meaning. 20 scenarios, then axe.
 *
 * Geometry is checked with bounding boxes (what the user sees), not with
 * CSS: "the file tree is on the right" means its box is right of the
 * editor's. The English interface is the control: the same checks mirror.
 */

type Locale = "he" | "en";

async function open(page: Page, locale: Locale, opts: { tour?: boolean; tabs?: number; content?: string } = {}) {
  const tabs = Array.from({ length: opts.tabs ?? 0 }, (_, i) => ({ id: `t${i}`, name: `${locale === "he" ? "פתק" : "Note"} ${i + 1}.md`, content: `# ${i + 1}\n`, workspaceName: null, dirty: false }));
  await page.addInitScript(
    ({ locale, content, tour, tabs }) => {
      localStorage.clear();
      if (!tour) localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem(
        "lumen-md",
        JSON.stringify({
          state: { locale, mode: "split", showWorkspace: true, showOutline: true, showBacklinks: true, openTabs: tabs, doc: { name: tabs[0]?.name ?? "RTL.md", content: tabs[0]?.content ?? content, dirty: false, workspaceName: null } },
          version: 0,
        }),
      );
    },
    { locale, content: opts.content ?? RTL_NOTE, tour: !!opts.tour, tabs },
  );
  await page.setViewportSize({ width: 1440, height: 900 });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", locale === "he" ? "rtl" : "ltr");
  await page.locator("header").first().waitFor({ state: "visible" });
}

const box = async (page: Page, selector: string) => {
  const b = await page.locator(selector).first().boundingBox();
  expect(b, selector).not.toBeNull();
  return b!;
};
const centerX = (b: { x: number; width: number }) => b.x + b.width / 2;
/** `a` is drawn to the right of `b` in RTL and to the left in LTR. */
const startSide = (locale: Locale, a: number, b: number) => (locale === "he" ? a > b : a < b);

for (const locale of ["he", "en"] as const) {
  test.describe(`workspace in ${locale}`, () => {
    test("1. the document says its language and direction", async ({ page }) => {
      await open(page, locale);
      await expect(page.locator("html")).toHaveAttribute("lang", locale);
    });

    test("2. the toolbar starts on the reading side", async ({ page }) => {
      await open(page, locale);
      const bar = await box(page, "header");
      // The logo button (opens the palette) comes first in the toolbar.
      const first = await box(page, "header > button:first-child");
      expect(startSide(locale, centerX(first), centerX(bar))).toBe(true);
    });

    test("3. the file tree sits on the start side of the editor", async ({ page }) => {
      await open(page, locale);
      const tree = await box(page, ".file-tree");
      const editor = await box(page, ".cm-editor");
      expect(startSide(locale, centerX(tree), centerX(editor))).toBe(true);
    });

    test("4. the outline sits on the end side", async ({ page }) => {
      await open(page, locale);
      const outline = await box(page, ".outline-aside");
      const editor = await box(page, ".cm-editor");
      expect(startSide(locale, centerX(editor), centerX(outline))).toBe(true);
    });

    test("5. the backlinks panel sits on the end side", async ({ page }) => {
      await open(page, locale);
      const backlinks = await box(page, ".backlinks-panel");
      const editor = await box(page, ".cm-editor");
      expect(startSide(locale, centerX(editor), centerX(backlinks))).toBe(true);
    });

    test("6. the file tree's border faces the editor", async ({ page }) => {
      await open(page, locale);
      const w = await page.locator(".file-tree").first().evaluate((el) => {
        const s = getComputedStyle(el);
        return { left: parseFloat(s.borderLeftWidth), right: parseFloat(s.borderRightWidth) };
      });
      if (locale === "he") expect([w.left > 0, w.right]).toEqual([true, 0]);
      else expect([w.right > 0, w.left]).toEqual([true, 0]);
    });

    test("7. the outline's border faces the editor and its levels indent from the start", async ({ page }) => {
      // RTL_NOTE has one heading (an h1, which has no indent of its own): add an
      // h2 in the interface's language, since the outline link is dir="auto".
      const h2 = locale === "he" ? "## פרק שני\n\nטקסט.\n" : "## Second part\n\nText.\n";
      await open(page, locale, { content: `${RTL_NOTE}\n${h2}` });
      const s = await page.locator(".outline-aside").first().evaluate((el) => {
        const c = getComputedStyle(el);
        return { left: parseFloat(c.borderLeftWidth), right: parseFloat(c.borderRightWidth) };
      });
      expect(locale === "he" ? s.right : s.left).toBeGreaterThan(0);
      const link = page.locator(".outline-link.h2").first();
      await expect(link).toBeVisible();
      const pad = await link.evaluate((el) => {
        const c = getComputedStyle(el);
        return { left: parseFloat(c.paddingLeft), right: parseFloat(c.paddingRight) };
      });
      expect(locale === "he" ? pad.right > pad.left : pad.left > pad.right).toBe(true);
    });

    test("8. split view: the editor on the start side, the preview on the end side", async ({ page }) => {
      await open(page, locale);
      const editor = await box(page, ".cm-editor");
      const preview = await box(page, ".prose-lumen");
      expect(startSide(locale, centerX(editor), centerX(preview))).toBe(true);
    });

    test("9. the first tab is drawn on the start side", async ({ page }) => {
      await open(page, locale, { tabs: 3 });
      const tabs = page.locator("button[data-doc-tab]");
      await expect(tabs).toHaveCount(3);
      const first = (await tabs.nth(0).boundingBox())!;
      const last = (await tabs.nth(2).boundingBox())!;
      expect(startSide(locale, centerX(first), centerX(last))).toBe(true);
    });

    test("10. ← / → move between tabs by where they are drawn", async ({ page }) => {
      await open(page, locale, { tabs: 3 });
      const tabs = page.locator("button[data-doc-tab]");
      await tabs.nth(0).focus();
      // The key that points towards the second tab.
      await page.keyboard.press(locale === "he" ? "ArrowLeft" : "ArrowRight");
      await expect(tabs.nth(1)).toBeFocused();
      await page.keyboard.press(locale === "he" ? "ArrowRight" : "ArrowLeft");
      await expect(tabs.nth(0)).toBeFocused();
      await page.keyboard.press("End");
      await expect(tabs.nth(2)).toBeFocused();
      await page.keyboard.press("Home");
      await expect(tabs.nth(0)).toBeFocused();
    });

    test("11. a toolbar menu opens from its button's start edge", async ({ page }) => {
      await open(page, locale);
      const button = page.locator('header button[aria-haspopup="menu"]').first();
      await button.click();
      const menu = page.locator('header [role="menu"]').first();
      await expect(menu).toBeVisible();
      const b = (await button.boundingBox())!;
      const m = (await menu.boundingBox())!;
      if (locale === "he") expect(Math.abs(m.x + m.width - (b.x + b.width))).toBeLessThanOrEqual(2);
      else expect(Math.abs(m.x - b.x)).toBeLessThanOrEqual(2);
    });

    test("12. find & replace opens on the end side", async ({ page }) => {
      await open(page, locale);
      await page.keyboard.press("ControlOrMeta+h");
      await expect(page.getByTestId("find-replace")).toBeVisible();
      const panel = await box(page, '[data-testid="find-replace"]');
      const viewport = page.viewportSize()!;
      expect(startSide(locale, viewport.width / 2, centerX(panel))).toBe(true);
    });

    test("13. the AI button floats on the end side", async ({ page }) => {
      await open(page, locale);
      const fab = await box(page, '[data-testid="ai-fab"]');
      const viewport = page.viewportSize()!;
      expect(startSide(locale, viewport.width / 2, centerX(fab))).toBe(true);
    });

    test("14. the status bar starts on the reading side", async ({ page }) => {
      await open(page, locale);
      const bar = await box(page, ".status-bar");
      const first = await box(page, ".status-bar .sb-item");
      expect(startSide(locale, centerX(first), centerX(bar))).toBe(true);
    });

    test("15. the command palette reads in the interface's direction", async ({ page }) => {
      await open(page, locale);
      await page.keyboard.press("ControlOrMeta+k");
      const input = page.locator('[role="dialog"][aria-modal="true"] input').first();
      await expect(input).toBeVisible();
      expect(await input.evaluate((el) => getComputedStyle(el).direction)).toBe(locale === "he" ? "rtl" : "ltr");
    });

    test("16. the tour's next arrow points the way the interface reads", async ({ page }) => {
      // A first visit opens the setup dialog, not the tour (plan 14.1): the
      // tour is replayed from Help → Guided tour, as a user would.
      await open(page, locale);
      await page.locator("header button", { hasText: locale === "he" ? "עזרה" : "Help" }).first().click();
      await page.getByRole("menuitem", { name: locale === "he" ? /סיור מודרך/ : /Guided tour/ }).click();
      const counter = page.getByText(/^1 \/ \d+$/);
      await expect(counter).toBeVisible({ timeout: 10_000 });
      await page.keyboard.press(locale === "he" ? "ArrowLeft" : "ArrowRight");
      await expect(page.getByText(/^2 \/ \d+$/)).toBeVisible();
      await page.keyboard.press(locale === "he" ? "ArrowRight" : "ArrowLeft");
      await expect(page.getByText(/^1 \/ \d+$/)).toBeVisible();
    });

    test("17. the plugin gallery's search icon and its room are on the start side", async ({ page }) => {
      await open(page, locale);
      await page.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: "view.plugins" } })));
      const input = page.getByTestId("plugin-search");
      await expect(input).toBeVisible();
      const pad = await input.evaluate((el) => {
        const c = getComputedStyle(el);
        return { left: parseFloat(c.paddingLeft), right: parseFloat(c.paddingRight) };
      });
      expect(locale === "he" ? pad.right > pad.left : pad.left > pad.right).toBe(true);
    });

    test("18. nothing is wider than the window with every panel open", async ({ page }) => {
      await open(page, locale, { tabs: 3 });
      expect(await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth)).toBeLessThanOrEqual(1);
    });

    test("19. the preview's blocks still follow their own text inside the mirrored chrome", async ({ page }) => {
      await open(page, locale);
      const preview = page.locator(".prose-lumen").first();
      await expect(preview.locator("h1")).toContainText("טבלאות");
      expect(await preview.locator("h1").first().evaluate((el) => getComputedStyle(el).direction)).toBe("rtl");
      expect(await preview.locator("p", { hasText: "An English paragraph" }).first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
    });

    test("20. the source editor and code stay left-to-right", async ({ page }) => {
      await open(page, locale);
      expect(await page.locator(".cm-editor").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
      expect(await page.locator(".prose-lumen pre").first().evaluate((el) => getComputedStyle(el).direction)).toBe("ltr");
    });
  });
}

// ── axe in RTL ──────────────────────────────────────────────────────────
const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");

type Violation = { id: string; impact: string | null; nodes: unknown[] };
async function axe(page: Page): Promise<Violation[]> {
  // Evaluated over the DevTools protocol, as in a11y.spec.ts: the page's CSP
  // (script-src 'self') refuses the inline <script> addScriptTag would add.
  await page.evaluate(AXE);
  return page.evaluate(async () => {
    const w = window as unknown as { axe: { run: (ctx: Document, opts: object) => Promise<{ violations: Violation[] }> } };
    const r = await w.axe.run(document, { resultTypes: ["violations"] });
    return r.violations.map((v) => ({ id: v.id, impact: v.impact, nodes: v.nodes.map(() => 0) }));
  });
}

test("axe: the Hebrew workspace has no serious violation, and none that English doesn't have", async ({ page, browser }) => {
  await open(page, "he", { tabs: 2 });
  await expect(page.locator(".prose-lumen h1").first()).toBeVisible();
  const he = await axe(page);
  const enPage = await browser.newPage();
  await open(enPage, "en", { tabs: 2 });
  await expect(enPage.locator(".prose-lumen h1").first()).toBeVisible();
  const en = await axe(enPage);
  await enPage.close();
  const enIds = new Set(en.map((v) => v.id));
  expect(he.filter((v) => !enIds.has(v.id)).map((v) => v.id), "violations only in RTL").toEqual([]);
  expect(he.filter((v) => v.impact === "serious" || v.impact === "critical").map((v) => `${v.id} (${v.nodes.length})`)).toEqual([]);
});
