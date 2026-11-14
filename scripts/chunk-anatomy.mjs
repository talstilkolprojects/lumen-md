#!/usr/bin/env node
/**
 * What a built chunk is made of (plan W1.36). Step 1 of shrinking
 * Excalidraw's core chunk: which packages it inlines, any package inlined
 * twice, and any embedded wasm/font/base64 payload.
 *
 *   node scripts/chunk-anatomy.mjs <file.js | dir> [...] [--top N] [--json out.json]
 *
 * A directory means every .js file in it, biggest first (--files N, default 5).
 * Excalidraw's dist/prod is minified, so the per-package view needs the same
 * chunk from dist/dev, which esbuild leaves with a `// path` mark per module:
 *
 *   npm ci
 *   node scripts/chunk-anatomy.mjs node_modules/@excalidraw/excalidraw/dist/dev
 *   npm run build && node scripts/chunk-anatomy.mjs dist/assets/vendor-excalidraw-chunk-*.js
 *
 * Exit 0 always: this measures, it does not gate (the budget does).
 */
import { readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { anatomy, reportLines } from "./lib/chunkAnatomy.mjs";

const argv = process.argv.slice(2);
const opt = (n, d) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : d);
const top = Number(opt("--top", 25));
const nFiles = Number(opt("--files", 5));
const jsonOut = opt("--json");
const skip = new Set([opt("--top"), opt("--files"), jsonOut].filter(Boolean));
const inputs = argv.filter((a) => !a.startsWith("--") && !skip.has(a));
if (!inputs.length) {
  console.error("usage: node scripts/chunk-anatomy.mjs <file.js | dir> [...] [--top N] [--files N] [--json out.json]");
  process.exit(2);
}

const files = [];
for (const p of inputs) {
  if (statSync(p).isDirectory()) {
    const js = readdirSync(p)
      .filter((f) => /\.m?js$/.test(f))
      .map((f) => join(p, f))
      .sort((a, b) => statSync(b).size - statSync(a).size);
    files.push(...js.slice(0, nFiles));
  } else files.push(p);
}

const record = {};
for (const f of files) {
  const a = anatomy(readFileSync(f, "utf8"), { top });
  record[f] = a;
  console.log(reportLines(f, a).join("\n"));
}
if (jsonOut) writeFileSync(jsonOut, JSON.stringify(record, null, 2) + "\n");
