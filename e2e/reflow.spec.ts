import { test, expect, type Page } from "@playwright/test";

/**
 * Reflow and forced colours (plan W1.23, WCAG 1.4.10 / 1.4.11). At 400 %
 * zoom a 1280 px window is 320 CSS px wide; at 200 % it is 640. On ten
 * surfaces, in English and Hebrew, nothing may need horizontal scrolling or
 * be cut off at the side: no page-level horizontal scroll, and no visible
 * control or text outside the viewport — except inside a region that
 * scrolls sideways on its own (code, wide tables: the WCAG exception).
 * With forced colours (Windows high contrast) every focused control still
 * shows a visible outline.
 */

const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

const SURFACES: Array<{ name: string; open?: (page: Page) => Promise<void>; dialog?: boolean }> = [
  { name: "main screen" },
  { name: "preview", open: (p) => run(p, "view.preview") },
  { name: "workspace sidebar", open: (p) => run(p, "view.workspace") },
  { name: "outline", open: (p) => run(p, "view.outline") },
  { name: "find and replace", open: (p) => run(p, "view.findReplace") },
  { name: "command palette", open: (p) => p.keyboard.press("ControlOrMeta+k"), dialog: true },
  { name: "search", open: (p) => run(p, "view.search"), dialog: true },
  { name: "keyboard shortcuts", open: (p) => p.keyboard.press("ControlOrMeta+/"), dialog: true },
  { name: "theme settings", open: (p) => run(p, "settings.theme"), dialog: true },
  { name: "setup", open: (p) => run(p, "help.setup"), dialog: true },
];

async function boot(page: Page, lang: "en" | "he", width: number) {
  await page.setViewportSize({ width, height: Math.round(width * 0.8) });
  await page.addInitScript((l) => {
    localStorage.setItem("lumen-tour-done", "1");
    localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: l }, version: 0 }));
  }, lang);
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator(".cm-content, .prose-lumen").first()).toBeVisible({ timeout: 20_000 });
}

/** What overflows sideways: page scroll, and visible elements outside the viewport (not inside a sideways scroller). */
async function overflow(page: Page): Promise<string[]> {
  return page.evaluate(() => {
    const out: string[] = [];
    const se = document.scrollingElement ?? document.documentElement;
    if (se.scrollWidth > se.clientWidth + 1) out.push(`page scrolls sideways: ${se.scrollWidth} > ${se.clientWidth}`);
    const vw = document.documentElement.clientWidth;
    const scrollsSideways = (el: Element | null): boolean => {
      for (let e = el; e && e !== document.body; e = e.parentElement) {
        const ox = getComputedStyle(e).overflowX;
        if ((ox === "auto" || ox === "scroll") && e.scrollWidth > e.clientWidth) return true;
      }
      return false;
    };
    const sel = "button, a[href], input, select, textarea, [role=button], [role=tab], [role=menuitem], [role=option], h1, h2, h3, p, label, li";
    for (const el of Array.from(document.querySelectorAll(sel))) {
      const r = el.getBoundingClientRect();
      if (r.width === 0 || r.height === 0) continue;
      const cs = getComputedStyle(el);
      if (cs.visibility === "hidden" || cs.display === "none" || el.closest("[aria-hidden=true], .sr-only")) continue;
      if (r.right <= vw + 1 && r.left >= -1) continue;
      if (scrollsSideways(el.parentElement)) continue;
      // An element wholly off-screen on purpose (a closed drawer, an unfocused skip link) is not cut off.
      if (r.left >= vw || r.right <= 0 || r.bottom <= 0) continue;
      const name = (el.getAttribute("aria-label") ?? el.textContent ?? "").trim().slice(0, 30);
      out.push(`${el.tagName.toLowerCase()} "${name}" spans ${Math.round(r.left)}…${Math.round(r.right)} of ${vw}`);
      if (out.length > 12) break;
    }
    return out;
  });
}

for (const [zoom, width] of [
  ["400%", 320],
  ["200%", 640],
] as const) {
  for (const lang of ["en", "he"] as const) {
    test(`reflow at ${zoom} (${width} px), ${lang === "he" ? "Hebrew RTL" : "English LTR"}: no sideways scroll on 10 surfaces`, async ({ page }) => {
      test.setTimeout(90_000);
      await boot(page, lang, width);
      const found: string[] = [];
      for (const s of SURFACES) {
        if (s.open) await s.open(page);
        if (s.dialog) await expect(page.locator('[role="dialog"][aria-modal="true"]').first()).toBeVisible({ timeout: 10_000 });
        const o = await overflow(page);
        if (o.length) found.push(`— ${s.name}\n    ${o.join("\n    ")}`);
        if (s.dialog) {
          await page.keyboard.press("Escape");
          await expect(page.locator('[role="dialog"][aria-modal="true"]')).toHaveCount(0, { timeout: 5_000 });
        } else if (s.open) {
          // Panels toggle: run the same command again to close it; preview → back to split.
          if (s.name === "preview") await run(page, "view.split");
          else await s.open(page);
        }
      }
      expect(found.join("\n"), `sideways overflow at ${zoom}`).toBe("");
    });
  }
}

test("forced colours: a focused control shows an outline", async ({ page }) => {
  await page.emulateMedia({ forcedColors: "active" });
  await boot(page, "he", 1280);
  await page.keyboard.press("ControlOrMeta+k");
  await expect(page.locator('[role="dialog"][aria-modal="true"]').first()).toBeVisible({ timeout: 10_000 });
  await page.keyboard.press("Tab");
  const style = await page.evaluate(() => {
    const el = document.activeElement as HTMLElement | null;
    if (!el) return null;
    const cs = getComputedStyle(el);
    return { outline: cs.outlineStyle, width: parseFloat(cs.outlineWidth) };
  });
  expect(style).not.toBeNull();
  expect(style!.outline).not.toBe("none");
  expect(style!.width).toBeGreaterThanOrEqual(2);
});
