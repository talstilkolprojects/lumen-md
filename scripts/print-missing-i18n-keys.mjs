#!/usr/bin/env node
/**
 * Print every i18n key referenced via `t("…")` in src/ that's missing
 * from the en or he bundles. Used to drive the α.6.9 cleanup.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { readLocale } from "./lib/i18n-files.mjs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";

const SRC = resolve("src");

function listSourceFiles(dir) {
  const out = [];
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name.startsWith(".")) continue;
    if (e.name === "__tests__" || e.name === "node_modules") continue;
    const full = join(dir, e.name);
    if (e.isDirectory()) out.push(...listSourceFiles(full));
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(full);
  }
  return out;
}

function extractKeys(text) {
  const re = /\bt\(\s*["'`]([\w.\-]+)["'`]/g;
  const keys = new Set();
  let m;
  while ((m = re.exec(text)) !== null) keys.add(m[1]);
  return [...keys];
}

const callKeys = new Set();
for (const f of listSourceFiles(SRC)) {
  for (const k of extractKeys(readFileSync(f, "utf8"))) callKeys.add(k);
}

// src/i18n/locales/<lang>/<domain>.json (plan 0.3).
const en = new Set([...Object.keys(readLocale("en")), ...lazyEnglishEntries().map(([k]) => k)]);
const he = new Set(Object.keys(readLocale("he")));

const missingEn = [...callKeys].filter((k) => !en.has(k)).sort();
const missingHe = [...callKeys].filter((k) => !he.has(k)).sort();

console.log("# Missing in en (" + missingEn.length + "):");
for (const k of missingEn) console.log("  " + k);
console.log("\n# Missing in he (" + missingHe.length + "):");
for (const k of missingHe) console.log("  " + k);
