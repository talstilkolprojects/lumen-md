#!/usr/bin/env node
/**
 * Extract every i18n key, its English value and its {var} placeholders
 * (β.4.1) into i18n/keys/<domain>.json: the input an external translation
 * step (scripts/translate-locale.mjs, a translator's TMS) works from.
 *
 * The English strings are read from src/i18n/locales/en/*.json (plan 0.3).
 * One file per domain, entries sorted by key, no timestamp: the files only
 * change when strings do, and two branches that add strings to different
 * domains change different files.
 *
 * Each entry is `{ key, en, vars }` so a translator can verify they kept
 * every interpolation.
 *
 * Usage:
 *   node scripts/extract-i18n-keys.mjs           # write i18n/keys/*.json (and print them)
 *   node scripts/extract-i18n-keys.mjs --check   # CI: fail if they are stale
 */

import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { KEYS_DIR, ROOT, SOURCE_LOCALE, buildKeyFiles, formatJson, readLocale } from "./lib/i18n-files.mjs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";

// English of lazily loaded domains (src/i18n/lazy/*.json) is part of the key set too.
const en = { ...readLocale(SOURCE_LOCALE), ...Object.fromEntries(lazyEnglishEntries(ROOT)) };
if (Object.keys(en).length === 0) {
  console.error("No English strings in src/i18n/locales/en/ (run `node scripts/i18n-split.mjs` on an old checkout).");
  process.exit(2);
}
const files = buildKeyFiles(en);
const count = Object.keys(en).length;
const existing = existsSync(KEYS_DIR) ? readdirSync(KEYS_DIR).filter((n) => n.endsWith(".json")) : [];
const stale = existing.filter((n) => !(n.slice(0, -5) in files));

if (process.argv.includes("--check")) {
  const problems = [];
  for (const [d, file] of Object.entries(files)) {
    const path = join(KEYS_DIR, `${d}.json`);
    if (!existsSync(path)) {
      problems.push(`missing ${relative(ROOT, path)}`);
      continue;
    }
    const committed = JSON.parse(readFileSync(path, "utf8"));
    if (JSON.stringify(committed) === JSON.stringify(file)) continue;
    const was = new Map((committed.entries ?? []).map((e) => [e.key, JSON.stringify(e)]));
    const now = new Map(file.entries.map((e) => [e.key, JSON.stringify(e)]));
    const added = [...now.keys()].filter((k) => !was.has(k));
    const removed = [...was.keys()].filter((k) => !now.has(k));
    const changed = [...now.keys()].filter((k) => was.has(k) && was.get(k) !== now.get(k));
    problems.push(
      `${relative(ROOT, path)}: ${added.length} missing, ${removed.length} removed, ${changed.length} changed` +
        ` (${[...added, ...removed, ...changed].slice(0, 8).join(", ")})`,
    );
  }
  for (const n of stale) problems.push(`stale ${relative(ROOT, join(KEYS_DIR, n))} (no strings in that domain)`);
  if (existsSync(join(ROOT, "i18n", "keys.json"))) problems.push("i18n/keys.json is the old layout: delete it");
  if (problems.length === 0) {
    console.error(`✓ i18n/keys/ is up to date (${count} entries in ${Object.keys(files).length} domains)`);
    process.exit(0);
  }
  console.error("✗ i18n/keys/ is stale:");
  for (const p of problems) console.error(`  ${p}`);
  console.error("  Run `npm run i18n:extract` and commit i18n/keys/.");
  process.exit(1);
}

mkdirSync(KEYS_DIR, { recursive: true });
for (const n of stale) rmSync(join(KEYS_DIR, n));
for (const [d, file] of Object.entries(files)) writeFileSync(join(KEYS_DIR, `${d}.json`), formatJson(file));
console.error(`✓ wrote ${count} entries to ${relative(ROOT, KEYS_DIR)}/ (${Object.keys(files).length} domains)`);
// Echo everything to stdout too, so the script can still be piped.
process.stdout.write(formatJson({ count, domains: files }));
