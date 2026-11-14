import { test, expect, type Page } from "@playwright/test";
import { readFileSync } from "node:fs";
import { createRequire } from "node:module";

/**
 * Plan W6.30 — axe in the e2e gate, on the key Hebrew flows.
 *
 * The production build, in Hebrew (RTL), light and dark, with a Hebrew note
 * open: the main screen in source and preview, the calendar, and each
 * dialog of the everyday flows (palette, search, shortcuts, theme,
 * settings, reading options, trash, privacy ledger, AI doctor, setup).
 * axe-core runs WCAG 2.0/2.1/2.2 A and AA (2.2 adds target-size): no serious
 * or critical violation may remain. scripts/e2e-gate.mjs runs this spec by
 * default, so a preview build fails on a new blocker.
 *
 * e2e/a11y.spec.ts covers English as well and the keyboard journey; this
 * spec is the Hebrew one, kept short enough for the gate's time box.
 */

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];

type Violation = { id: string; impact: string | null; help: string; nodes: Array<{ target: string[]; summary: string }> };

async function axe(page: Page, include: string | null): Promise<Violation[]> {
  // Evaluated over the DevTools protocol: the page's CSP doesn't apply.
  await page.evaluate(AXE);
  return page.evaluate(
    async ({ sel, tags }) => {
      type Node = { target: string[]; failureSummary?: string };
      type Result = { id: string; impact: string | null; help: string; nodes: Node[] };
      const w = window as unknown as { axe: { run: (ctx: unknown, opts: unknown) => Promise<{ violations: Result[] }> } };
      const r = await w.axe.run(sel ? { include: [sel] } : document, { runOnly: { type: "tag", values: tags }, resultTypes: ["violations"] });
      return r.violations.map((v) => ({ id: v.id, impact: v.impact, help: v.help, nodes: v.nodes.slice(0, 6).map((n) => ({ target: n.target, summary: (n.failureSummary ?? "").split("\n").slice(1, 2).join("").trim() })) }));
    },
    { sel: include, tags: TAGS },
  );
}

const blocking = (vs: Violation[]) => vs.filter((v) => v.impact === "serious" || v.impact === "critical");
const report = (vs: Violation[]) => vs.map((v) => `${v.impact} ${v.id}: ${v.help}\n${v.nodes.map((n) => `    ${n.target.join(" ")} — ${n.summary}`).join("\n")}`).join("\n");
const run = (page: Page, id: string) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);

const NOTE = ["# תוכנית", "", "פסקה בעברית עם מילה English באמצע.", "", "## משימות", "", "- [ ] לקנות חלב", "- [x] לשלם חשבון", "", "| עמודה | Column |", "| --- | --- |", "| א | b |", "", "[קישור](https://example.com)", ""].join("\n");

async function boot(page: Page, theme: "light" | "dark", mode: "source" | "preview") {
  await page.addInitScript(
    ({ th, content, mode }) => {
      localStorage.clear();
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: "he", theme: th, mode, doc: { name: "תוכנית.md", content, dirty: false, workspaceName: null } }, version: 0 }));
    },
    { th: theme, content: NOTE, mode },
  );
  await page.emulateMedia({ colorScheme: theme, reducedMotion: "reduce" });
  await page.goto("/");
  await expect(page.locator("html")).toHaveAttribute("dir", "rtl");
  await expect(page.locator("html")).toHaveAttribute("lang", "he");
  if (mode === "preview") await expect(page.locator("[data-preview-root]").first()).toBeVisible({ timeout: 20_000 });
  else await expect(page.locator(".cm-content").first()).toBeVisible({ timeout: 20_000 });
}

/** Dialogs of the everyday flows: how to open each one. */
const DIALOGS: Array<{ name: string; open: (page: Page) => Promise<unknown> }> = [
  { name: "command palette", open: (p) => p.keyboard.press("ControlOrMeta+k") },
  { name: "search", open: (p) => run(p, "view.search") },
  { name: "keyboard shortcuts", open: (p) => p.keyboard.press("ControlOrMeta+/") },
  { name: "theme settings", open: (p) => run(p, "settings.theme") },
  { name: "settings", open: (p) => run(p, "settings.open") },
  { name: "reading options", open: (p) => run(p, "view.readingOptions") },
  { name: "trash", open: (p) => run(p, "file.trash") },
  { name: "privacy ledger", open: (p) => run(p, "ai.privacyLedger") },
  { name: "AI doctor", open: (p) => run(p, "ai.doctor") },
  { name: "setup", open: (p) => run(p, "help.setup") },
];

const MODAL = '[role="dialog"][aria-modal="true"]';

for (const theme of ["light", "dark"] as const) {
  test(`axe gate, Hebrew RTL ${theme}: the main screen (source, preview, calendar) and ${DIALOGS.length} dialogs`, async ({ page }) => {
    test.setTimeout(120_000);
    const found: string[] = [];
    const check = async (name: string, scope: string | null) => {
      const vs = blocking(await axe(page, scope));
      if (vs.length) found.push(`— ${name}\n${report(vs)}`);
    };

    await boot(page, theme, "preview");
    await check("main screen, preview", null);
    await run(page, "view.calendar");
    await expect(page.getByTestId("calendar")).toBeVisible({ timeout: 10_000 });
    await check("calendar", '[data-testid="calendar"]');

    await boot(page, theme, "source");
    await check("main screen, source", null);
    for (const d of DIALOGS) {
      await d.open(page);
      await expect(page.locator(MODAL).first(), `${d.name} opens a modal dialog`).toBeVisible({ timeout: 10_000 });
      await check(d.name, MODAL);
      await page.keyboard.press("Escape");
      await expect(page.locator(MODAL), `${d.name} closes on Escape`).toHaveCount(0, { timeout: 5_000 });
    }
    expect(found.join("\n"), "axe serious/critical violations").toBe("");
  });
}
