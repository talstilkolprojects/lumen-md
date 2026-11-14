/**
 * Visual regression (plan 10.3): the surfaces, the variants and how to get
 * a page into a state that renders the same way on every run.
 *
 * Deterministic input: a fixed note (English for en, Hebrew for he) put in
 * the persisted store before the app starts, a fixed clock, no service
 * worker, reduced motion, fonts loaded. Nothing here waits a fixed time:
 * every wait is for a condition.
 */
import { expect, type Locator, type Page } from "@playwright/test";

export interface Variant {
  id: string;
  locale: "en" | "he";
  theme: "light" | "dark";
}

export const VARIANTS: Variant[] = [
  { id: "en-light", locale: "en", theme: "light" },
  { id: "en-dark", locale: "en", theme: "dark" },
  { id: "he-light", locale: "he", theme: "light" },
  { id: "he-dark", locale: "he", theme: "dark" },
];

export interface Surface {
  id: string;
  open: (page: Page) => Promise<unknown>;
  /** Visible once the surface has rendered. */
  ready: string;
  /** Parts whose text depends on the machine (a local model running or not). */
  mask?: (page: Page) => Locator[];
  /** A condition that must hold before the shot (e.g. no "Checking…" left). */
  settled?: (page: Page) => Promise<void>;
}

const runCommand = (page: Page, id: string) =>
  page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

/** The ten surfaces (the same ones scripts/preview-visual.mjs shows). */
export const SURFACES: Surface[] = [
  { id: "split", open: (p) => p.keyboard.press("Meta+2"), ready: ".prose-lumen h1" },
  { id: "source", open: (p) => p.keyboard.press("Meta+1"), ready: ".cm-content" },
  { id: "preview", open: (p) => p.keyboard.press("Meta+3"), ready: ".prose-lumen h1" },
  { id: "wysiwyg", open: (p) => p.keyboard.press("Meta+4"), ready: ".ProseMirror" },
  { id: "palette", open: (p) => p.keyboard.press("Meta+K"), ready: '[role="dialog"][aria-modal="true"] input' },
  { id: "shortcuts", open: (p) => p.keyboard.press("Meta+/"), ready: '[role="dialog"] kbd' },
  { id: "plugins", open: (p) => runCommand(p, "view.plugins"), ready: '[data-testid="plugin-card"]' },
  { id: "templates", open: (p) => runCommand(p, "templates.open"), ready: '[data-testid="template-card"]' },
  { id: "theme-settings", open: (p) => runCommand(p, "settings.theme"), ready: '[data-testid="theme-settings"]' },
  {
    id: "ai-settings",
    open: (p) => p.evaluate(() => window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"))),
    ready: '[data-testid="exec-status-ollama"]',
    mask: (p) => [p.locator('[data-testid^="exec-status-"]'), p.locator('[data-testid="hw-card"]')],
    settled: async (p) => {
      // The executor checks finish on their own; wait until none says "checking".
      await expect
        .poll(() => p.locator('[data-testid^="exec-status-"]').evaluateAll((els) => els.filter((e) => /…|\.\.\./.test(e.textContent ?? "")).length), { timeout: 15_000 })
        .toBe(0);
    },
  },
];

/** The note every shot shows: headings, lists, a table, code, a quote, a link. */
export const FIXTURE: Record<Variant["locale"], string> = {
  en: [
    "# Visual baseline",
    "",
    "A short paragraph with **bold**, *italic*, `inline code` and a [link](https://example.com).",
    "",
    "## Lists",
    "",
    "- First item",
    "- Second item",
    "  - Nested item",
    "1. One",
    "2. Two",
    "- [x] Done task",
    "- [ ] Open task",
    "",
    "> A quoted line.",
    "",
    "| Name | Count |",
    "| --- | ---: |",
    "| Apples | 3 |",
    "| Pears | 12 |",
    "",
    "```js",
    "const total = [1, 2, 3].reduce((a, b) => a + b, 0);",
    "```",
    "",
  ].join("\n"),
  he: [
    "# בסיס חזותי",
    "",
    "פסקה קצרה עם **מודגש**, *נטוי*, `קוד בשורה` ו[קישור](https://example.com), וגם מילה באנגלית: Lumen.",
    "",
    "## רשימות",
    "",
    "- פריט ראשון",
    "- פריט שני",
    "  - פריט מקונן",
    "1. אחת",
    "2. שתיים",
    "- [x] משימה שהושלמה",
    "- [ ] משימה פתוחה",
    "",
    "> שורה מצוטטת.",
    "",
    "| שם | כמות |",
    "| --- | ---: |",
    "| תפוחים | 3 |",
    "| אגסים | 12 |",
    "",
    "```js",
    "const total = [1, 2, 3].reduce((a, b) => a + b, 0);",
    "```",
    "",
  ].join("\n"),
};

/** Seeds the store and opens the app in the variant's language and theme. */
export async function prepare(page: Page, v: Variant, content: string = FIXTURE[v.locale]): Promise<void> {
  await page.clock.setFixedTime(new Date("2026-01-15T09:30:00Z"));
  await page.emulateMedia({ colorScheme: v.theme, reducedMotion: "reduce" });
  await page.addInitScript(
    ({ locale, theme, content }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem(
        "lumen-md",
        JSON.stringify({ state: { locale, theme, mode: "split", doc: { name: "Baseline.md", content, dirty: false, workspaceName: null } }, version: 0 }),
      );
    },
    { locale: v.locale, theme: v.theme, content },
  );
  await page.goto("/");
  await page.locator(".cm-content, .ProseMirror, .prose-lumen").first().waitFor({ state: "visible", timeout: 20_000 });
  await expect(page.locator("html")).toHaveAttribute("dir", v.locale === "he" ? "rtl" : "ltr");
}

/** Fonts loaded, the network quiet, two frames painted. */
export async function settle(page: Page): Promise<void> {
  await page.waitForLoadState("networkidle", { timeout: 15_000 }).catch(() => undefined);
  await page.evaluate(async () => {
    await document.fonts.ready;
    await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  });
}
