#!/usr/bin/env node
/**
 * Hebrew docs search (plan W1.28): 20 golden queries (docs/search-golden.json),
 * each must bring its page into the top 3 among the Hebrew pages.
 *
 *   node scripts/docs-search.mjs                  # on the sources: an index model
 *   node scripts/docs-search.mjs --site docs/dist # on the built site: Pagefind itself (Playwright)
 *
 * The model reads each Hebrew page as Pagefind would index it — the title
 * (weight 10, as Starlight's <h1>), the body text without code, and the
 * bare forms the rehype plugin adds (title forms 5, body forms 0.5) — and matches a query word
 * against the start of every indexed word, as Pagefind does. It ranks by
 * the weighted count of matches over the page's length. It is a model, not
 * Pagefind: --site is the real check.
 */
import { existsSync, readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DOCS = join(ROOT, "docs/src/content/docs");

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir)) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.mdx?$/.test(n)) out.push(p);
  }
  return out;
}

const tokens = (s) => [...String(s).normalize("NFC").replace(/[\u{0591}-\u{05C7}]/gu, "").toLowerCase().matchAll(/[\p{L}\p{N}][\p{L}\p{N}"'׳״]*/gu)].map((m) => m[0].replace(/["'׳״]+$/u, ""));

/** Query words: Hebrew prefixes are left as typed; a hyphen splits "מ-Notion" into "מ" and "notion". */
export function queryWords(q) {
  return tokens(q.replace(/-/g, " ")).filter((w) => w.length > 1);
}

export async function modelIndex() {
  const { hebrewBaseForms } = await import(pathToFileURL(join(ROOT, "docs/src/plugins/hebrew-forms.mjs")).href);
  const pages = [];
  for (const p of walk(join(DOCS, "he"))) {
    const src = readFileSync(p, "utf8");
    const fm = /^---\n([\s\S]*?)\n---/.exec(src)?.[1] ?? "";
    const title = /^title:\s*(.+)$/m.exec(fm)?.[1] ?? "";
    const body = src.slice(fm ? fm.length + 8 : 0).replace(/```[\s\S]*?```/g, " ").replace(/`[^`\n]*`/g, " ").replace(/^import .*$/gm, " ");
    const titleForms = hebrewBaseForms(title);
    const words = [
      ...tokens(title).map((w) => [w, 10]),
      ...tokens(body).map((w) => [w, 1]),
      ...titleForms.map((w) => [w, 5]),
      ...hebrewBaseForms(`${title} ${body}`).filter((f) => !titleForms.includes(f)).map((w) => [w, 0.5]),
    ];
    pages.push({ page: relative(DOCS, p).replace(/\.mdx?$/, "").split("\\").join("/"), words, length: Math.max(50, words.length) });
  }
  return pages;
}

export function rank(pages, q) {
  const terms = queryWords(q);
  return pages
    .map((p) => {
      let score = 0;
      let all = true;
      for (const t of terms) {
        let s = 0;
        for (const [w, weight] of p.words) if (w.startsWith(t)) s += weight;
        if (!s) all = false;
        score += s;
      }
      return { page: p.page, score: all ? score / Math.log2(p.length) : 0 };
    })
    .filter((r) => r.score > 0)
    .sort((a, b) => b.score - a.score);
}

async function site(dist) {
  const { createRequire } = await import("node:module");
  const require = createRequire(join(ROOT, "package.json"));
  const { chromium } = require("playwright");
  const { createServer } = await import("node:http");
  const types = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".wasm": "application/wasm" };
  const server = createServer((req, res) => {
    let p = join(dist, decodeURIComponent(new URL(req.url, "http://x").pathname));
    if (existsSync(p) && statSync(p).isDirectory()) p = join(p, "index.html");
    if (!existsSync(p)) return void res.writeHead(404).end();
    res.writeHead(200, { "content-type": types[p.slice(p.lastIndexOf("."))] ?? "application/octet-stream" }).end(readFileSync(p));
  }).listen(0);
  const port = server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage();
  await page.goto(`http://127.0.0.1:${port}/he/`);
  const out = [];
  for (const { q } of golden().queries) {
    out.push(
      await page.evaluate(async (query) => {
        const pf = await import("/pagefind/pagefind.js");
        await pf.options({ language: "he" });
        const r = await pf.search(query);
        const top = await Promise.all(r.results.slice(0, 3).map((x) => x.data()));
        return top.map((d) => d.url.replace(/^\/|\/$/g, ""));
      }, q),
    );
  }
  await browser.close();
  server.close();
  return out;
}

const golden = () => JSON.parse(readFileSync(join(ROOT, "docs/search-golden.json"), "utf8"));

async function main() {
  const at = process.argv.indexOf("--site");
  const { queries } = golden();
  const tops = at > 0 ? await site(resolve(process.argv[at + 1])) : null;
  const pages = at > 0 ? null : await modelIndex();
  let ok = 0;
  queries.forEach(({ q, page }, i) => {
    const top = tops ? tops[i] : rank(pages, q).slice(0, 3).map((r) => r.page);
    const hit = top.includes(page);
    if (hit) ok++;
    else console.error(`✗ "${q}" → ${page} not in the top 3: ${top.join(", ") || "(nothing)"}`);
  });
  console.error(`${ok === queries.length ? "✓" : "✗"} docs search (${at > 0 ? "Pagefind, built site" : "index model"}): ${ok}/${queries.length} golden Hebrew queries find their page`);
  if (ok !== queries.length) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) await main();
