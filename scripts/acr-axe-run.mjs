#!/usr/bin/env node
/**
 * The ACR's automated part on the real app (plan W3.8), for each release:
 * axe-core (the lockfile's) with the WCAG 2.0/2.1/2.2 A and AA rules on the
 * main screen and each modal surface, in Hebrew light and dark and English
 * light, every rule's result recorded, then docs/acr/axe.json written
 * (scripts/acr-axe.mjs) for `npm run acr`.
 *
 *   npm run build && npx vite preview --port 4173 &
 *   npm run acr:axe -- --url http://localhost:4173
 *
 * A script, not a spec: it records and never gates (e2e/a11y.spec.ts is
 * the gate), so it adds nothing to the e2e run or its skip count.
 */
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import { chromium } from "@playwright/test";

const require = createRequire(import.meta.url);
const AXE = readFileSync(require.resolve("axe-core/axe.min.js"), "utf8");
const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa"];
const args = process.argv.slice(2);
const url = args[args.indexOf("--url") + 1];
if (!args.includes("--url") || !url) {
  console.error("usage: npm run acr:axe -- --url http://localhost:4173 (the built app, served)");
  process.exit(2);
}

const command = (page, id) => page.evaluate((cmd) => window.dispatchEvent(new CustomEvent("lumen-run-command", { detail: { id: cmd } })), id);
const SURFACES = [
  { name: "main screen" },
  { name: "command palette", open: (p) => p.keyboard.press("ControlOrMeta+k"), scope: '[role="dialog"]' },
  { name: "search", open: (p) => command(p, "view.search"), scope: '[role="dialog"]' },
  { name: "keyboard shortcuts", open: (p) => p.keyboard.press("ControlOrMeta+/"), scope: '[role="dialog"]' },
  { name: "theme settings", open: (p) => command(p, "settings.theme"), scope: '[role="dialog"]' },
  { name: "setup", open: (p) => command(p, "help.setup"), scope: '[role="dialog"]' },
];

const browser = await chromium.launch();
const runs = [];
const failed = [];
let version = "";
let tags = {};
try {
  for (const [lang, theme] of [["he", "light"], ["he", "dark"], ["en", "light"]]) {
    const ctx = await browser.newContext({ colorScheme: theme, reducedMotion: "reduce" });
    const page = await ctx.newPage();
    await page.addInitScript(([l, th]) => {
      localStorage.setItem("lumen-tour-done", "1");
      localStorage.setItem("lumen-md", JSON.stringify({ state: { locale: l, theme: th }, version: 0 }));
    }, [lang, theme]);
    await page.goto(url);
    await page.locator(".cm-content").first().waitFor({ timeout: 30_000 });
    for (const s of SURFACES) {
      try {
        if (s.open) {
          await s.open(page);
          await page.locator('[role="dialog"][aria-modal="true"]').first().waitFor({ timeout: 10_000 });
        }
        await page.evaluate(AXE);
        const r = await page.evaluate(
          async ([sel, t]) => {
            const res = await window.axe.run(sel ? { include: [sel] } : document, { runOnly: { type: "tag", values: t } });
            return {
              version: window.axe.version,
              tags: Object.fromEntries(window.axe.getRules().map((x) => [x.ruleId, x.tags])),
              passes: res.passes.map((x) => x.id),
              incomplete: res.incomplete.map((x) => x.id),
              violations: res.violations.map((v) => ({ id: v.id, impact: v.impact ?? null, nodes: v.nodes.length })),
            };
          },
          [s.scope ?? null, TAGS],
        );
        ({ version, tags } = r);
        runs.push({ surface: s.name, lang, theme, passes: r.passes, incomplete: r.incomplete, violations: r.violations });
        if (s.open) {
          await page.keyboard.press("Escape");
          await page.locator('[role="dialog"][aria-modal="true"]').waitFor({ state: "detached", timeout: 5_000 });
        }
      } catch (e) {
        if (lang === "he" && theme === "light") failed.push(`${s.name}: ${String(e.message).split("\n")[0]}`);
      }
    }
    await ctx.close();
  }
} finally {
  await browser.close();
}
const dir = mkdtempSync(join(tmpdir(), "acr-axe-"));
const file = join(dir, "results.json");
writeFileSync(file, JSON.stringify({ version, tags, runs, failed }));
const r = spawnSync(process.execPath, [new URL("./acr-axe.mjs", import.meta.url).pathname, file, "--source", "the built app in Chromium (scripts/acr-axe-run.mjs)"], { stdio: "inherit" });
process.exit(r.status ?? 1);
