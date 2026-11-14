#!/usr/bin/env node
/**
 * Print every i18n key referenced via `t("…")` in src/ that's missing
 * from the en or he bundles. Used to drive the α.6.9 cleanup.
 */
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
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

const idx = readFileSync(join(SRC, "i18n", "index.ts"), "utf8");
const enBlock = /const en:\s*Strings\s*=\s*\{([\s\S]+?)^\};/m.exec(idx);
// Hebrew lives in src/i18n/locales/he.json (lazy chunk).
const heJson = JSON.parse(readFileSync(join(SRC, "i18n", "locales", "he.json"), "utf8"));

function parseKeys(body) {
  const out = new Set();
  const re = /^\s*"([\w.\-]+)"\s*:/gm;
  let m;
  while ((m = re.exec(body)) !== null) out.add(m[1]);
  return out;
}

const en = parseKeys(enBlock[1]);
for (const [k] of lazyEnglishEntries()) en.add(k);
const he = new Set(Object.keys(heJson));

const missingEn = [...callKeys].filter((k) => !en.has(k)).sort();
const missingHe = [...callKeys].filter((k) => !he.has(k)).sort();

console.log("# Missing in en (" + missingEn.length + "):");
for (const k of missingEn) console.log("  " + k);
console.log("\n# Missing in he (" + missingHe.length + "):");
for (const k of missingHe) console.log("  " + k);
