#!/usr/bin/env node
/**
 * Production-build gate for the e2e test surface (plan W1.31).
 *
 * `window.__lumen.agentReview` lets a script stage agent changes for the
 * review panel. It exists in the dev server, in vitest, and in a build made
 * with `VITE_LUMEN_TEST_SURFACE=1` (the e2e-prod job), never in a normal
 * production build. This script fails (exit 1) when a JavaScript file under
 * `dist/` still sets or reads it.
 *
 * The i18n keys (`"agentReview.title"`, …) are strings, not the surface, so
 * the match is a property access `.agentReview` not followed by `.` — or the
 * surface's `withdrawRun:` member.
 *
 * Usage: npm run build && node scripts/check-test-surface.mjs [dist]
 *        (or `npm run check:test-surface`)
 */
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const PATTERNS = [
  { rule: "agentReview-property", re: /\.agentReview\b(?![.\w-])/g },
  { rule: "withdrawRun-member", re: /\bwithdrawRun\s*:/g },
];

/** Every match in one file's text: `{rule, index, text}`. */
export function findTestSurface(text) {
  const out = [];
  for (const { rule, re } of PATTERNS) {
    for (const m of text.matchAll(re)) {
      out.push({ rule, index: m.index ?? 0, text: text.slice(Math.max(0, (m.index ?? 0) - 40), (m.index ?? 0) + 40) });
    }
  }
  return out;
}

function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const full = join(dir, name);
    if (statSync(full).isDirectory()) walk(full, out);
    else if (/\.(m?js|html)$/.test(name)) out.push(full);
  }
  return out;
}

const isMain = process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
  const dist = resolve(process.argv[2] ?? "dist");
  if (!existsSync(dist)) {
    console.error(`check-test-surface: ${dist} not found — run npm run build first`);
    process.exit(2);
  }
  const files = walk(dist);
  let bad = 0;
  for (const file of files) {
    for (const hit of findTestSurface(readFileSync(file, "utf8"))) {
      bad++;
      console.error(`::error file=${relative(process.cwd(), file)}::test surface in the production build (${hit.rule}): …${hit.text}…`);
    }
  }
  if (bad) {
    console.error(`check-test-surface: ${bad} match(es) in ${files.length} files. Build without VITE_LUMEN_TEST_SURFACE.`);
    process.exit(1);
  }
  console.log(`check-test-surface: no agentReview test surface in ${files.length} files under ${relative(process.cwd(), dist) || "."}`);
}
