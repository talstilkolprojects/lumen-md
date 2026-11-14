#!/usr/bin/env node
/**
 * Build public/lexicon/he-wiktionary.json (plan W5.26) from a Hebrew
 * Wiktionary dump:
 *
 *   curl -LO https://dumps.wikimedia.org/hewiktionary/latest/hewiktionary-latest-pages-articles.xml.bz2
 *   node scripts/build-hebrew-lexicon.mjs hewiktionary-latest-pages-articles.xml.bz2 [YYYYMMDD]
 *
 * Streams the dump (bzip2 through `bunzip2 -c` when the name ends in .bz2),
 * keeps namespace-0 Hebrew pages, and writes the pack plus its size and
 * sha256 into public/lexicon/manifest.json, which the app checks the
 * download against (src/lexicon/store.ts). Text: CC BY-SA 4.0.
 */
import { spawn } from "node:child_process";
import { createReadStream, mkdirSync, writeFileSync } from "node:fs";
import { createHash } from "node:crypto";
import { basename, join, resolve } from "node:path";
import { buildPack, pagesOf, parsePage } from "./lib/hewiktionary.mjs";

const [dump, dateArg] = process.argv.slice(2);
if (!dump) {
  console.error("usage: node scripts/build-hebrew-lexicon.mjs <hewiktionary-…-pages-articles.xml[.bz2]> [YYYYMMDD]");
  process.exit(2);
}
const date = dateArg ?? /(\d{8})/.exec(basename(dump))?.[1] ?? "latest";
const input = dump.endsWith(".bz2") ? spawn("bunzip2", ["-c", dump], { stdio: ["ignore", "pipe", "inherit"] }).stdout : createReadStream(dump);
input.setEncoding("utf8");

const entries = [];
let buf = "";
let pages = 0;
for await (const chunk of input) {
  buf += chunk;
  const end = buf.lastIndexOf("</page>");
  if (end < 0) continue;
  const done = buf.slice(0, end + 7);
  buf = buf.slice(end + 7);
  for (const [title, ns, text] of pagesOf(done)) {
    pages++;
    if (ns === "0") entries.push(...parsePage(title, text));
  }
}

const pack = buildPack(entries, { source: `hewiktionary-${date}-pages-articles`, built: new Date().toISOString().slice(0, 10) });
const out = resolve(process.cwd(), "public/lexicon");
mkdirSync(out, { recursive: true });
const json = JSON.stringify(pack);
writeFileSync(join(out, "he-wiktionary.json"), json);
const sha256 = createHash("sha256").update(json).digest("hex");
const manifest = { file: "he-wiktionary.json", bytes: Buffer.byteLength(json), sha256, count: pack.count, words: pack.words, source: pack.source, license: pack.license };
writeFileSync(join(out, "manifest.json"), JSON.stringify(manifest, null, 2) + "\n");
console.log(`${pages} pages → ${pack.count} entries (${pack.words} words), ${(manifest.bytes / 1e6).toFixed(1)} MB, sha256 ${sha256}`);
if (pack.count < 20000) console.warn("fewer than 20,000 entries: plan W5.26 asks for at least 20,000");
