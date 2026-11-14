#!/usr/bin/env node
/**
 * The docs, packed into the app (plan W3.7): every page of
 * docs/src/content/docs, English and Hebrew, as JSON shards per language
 * under src/help/generated/ (help.<lang>.<n>.json). The help panel loads
 * them lazily (they are not in the startup bundle) and searches them on the
 * device, so help works offline.
 *
 * Each page keeps its Markdown body (rendered in the panel by the app's own
 * renderer) and, for search, its sections: heading, the anchor the renderer
 * gives that heading, and plain text.
 *
 *   node scripts/help-bundle.mjs           # write
 *   node scripts/help-bundle.mjs --check   # fail if the bundle is out of date with the docs
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { gzipSync } from "node:zlib";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DOCS = join(ROOT, "docs/src/content/docs");
export const OUT_DIR = "src/help/generated";
/** help.en.0.json, help.he.3.json … */
export const SHARD = /^help\.(en|he)\.(\d+)\.json$/;
/**
 * Each shard becomes its own lazy chunk, which scripts/bundle-budget.mjs
 * holds to the "lazy plugin chunk" rule: 100 KB gzipped. Shards are filled
 * up to the warning line, so each stays well under the budget however the
 * docs grow (W3.7 had one file per language, 63.6 / 69.8 KB; by train 2
 * the docs had tripled, to ~300 KB, so the bundle is sharded).
 */
export const CHUNK_BUDGET_KB = 100;
export const CHUNK_WARN_KB = 85;

/** What Vite emits for a large JSON import: JSON.parse of one string literal, gzipped, in KB. */
export function chunkKb(json) {
  return gzipSync(`export default JSON.parse(${JSON.stringify(json.trim())})`).length / 1024;
}

function walk(dir) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) out.push(...walk(p));
    else if (/\.mdx?$/.test(n)) out.push(p);
  }
  return out;
}

/** The anchor rehype-slug (github-slugger) gives a heading. */
export function slugify(text) {
  return text
    .toLowerCase()
    .replace(/[\u2000-\u206F\u2E00-\u2E7F\\'!"#$%&()*+,./:;<=>?@[\]^`{|}~’]/g, "")
    .replace(/ /g, "-");
}

/** Markdown to plain text for the search index: no code, links as their text, no markup. */
export function plainText(md) {
  return md
    .replace(/```[\s\S]*?```/g, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/`([^`\n]*)`/g, "$1")
    .replace(/^:::\w*.*$/gm, " ")
    .replace(/^\s*[|>*+-]\s?|[*_~]{1,3}|\|/gm, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** One page: slug, title, description, Markdown body, sections. */
export function readPage(file) {
  const src = readFileSync(file, "utf8").replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(src);
  const fm = m?.[1] ?? "";
  const field = (k) => (new RegExp(`^${k}:\\s*(.*)$`, "m").exec(fm)?.[1] ?? "").trim().replace(/^(["'])(.*)\1$/, "$2");
  // MDX: drop imports and component tags; keep the Markdown.
  const body = src
    .slice(m ? m[0].length : 0)
    .replace(/^import\s.+$/gm, "")
    .replace(/<\/?[A-Z][\w.]*[^>]*>/g, "")
    .trim();
  const slug = relative(DOCS, file).replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "").split("\\").join("/");
  const sections = [];
  let current = { heading: field("title"), anchor: "", lines: [] };
  let fence = false;
  for (const line of body.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{2,4})\s+(.+?)\s*#*$/.exec(line);
    if (h) {
      sections.push(current);
      current = { heading: h[2].replace(/[*_`]/g, ""), anchor: slugify(h[2].replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")), lines: [] };
    } else current.lines.push(line);
  }
  sections.push(current);
  return {
    slug,
    title: field("title"),
    description: field("description"),
    md: body,
    sections: sections.map((s) => ({ heading: s.heading, anchor: s.anchor, text: plainText(s.lines.join("\n")) })).filter((s) => s.text || s.anchor),
  };
}

const pagesOf = (lang) =>
  walk(DOCS)
    .filter((f) => {
      const rel = relative(DOCS, f).split("\\").join("/");
      return lang === "he" ? rel.startsWith("he/") : !rel.startsWith("he/");
    })
    .map(readPage)
    .map((p) => ({ ...p, slug: lang === "he" ? p.slug.replace(/^he\/?/, "") : p.slug }));

/**
 * Each section gets a `key`: the English anchor of the same section, so a
 * "?" button names one section for both languages. The Hebrew page is the
 * English one translated, section for section; when the counts differ the
 * key is the page's own anchor.
 */
export function bundle(lang) {
  const pages = pagesOf(lang);
  const en = lang === "en" ? pages : pagesOf("en");
  for (const p of pages) {
    const twin = en.find((x) => x.slug === p.slug);
    const parallel = twin && twin.sections.length === p.sections.length;
    p.sections = p.sections.map((s, i) => ({ ...s, key: parallel ? twin.sections[i].anchor : s.anchor }));
  }
  return { version: 1, lang, pages };
}

/** Split a bundle into shards, in page order, each under CHUNK_WARN_KB gzipped. */
export function shards(b) {
  const out = [];
  let pages = [];
  const text = (ps) => `${JSON.stringify({ version: b.version, lang: b.lang, pages: ps })}\n`;
  for (const p of b.pages) {
    if (pages.length && chunkKb(text([...pages, p])) > CHUNK_WARN_KB) {
      out.push(text(pages));
      pages = [];
    }
    pages.push(p);
  }
  if (pages.length) out.push(text(pages));
  return out;
}

/** The shard files on disk for a language, in order. */
export function shardFiles(lang, root = ROOT) {
  const dir = join(root, OUT_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .map((n) => SHARD.exec(n))
    .filter((m) => m && m[1] === lang)
    .sort((a, b) => Number(a[2]) - Number(b[2]))
    .map((m) => join(dir, m[0]));
}

/** The bundle as packed on disk: every shard of a language, joined. */
export function readBundle(lang, root = ROOT) {
  const parts = shardFiles(lang, root).map((f) => JSON.parse(readFileSync(f, "utf8")));
  return { version: parts[0]?.version ?? 1, lang, pages: parts.flatMap((p) => p.pages) };
}

function main() {
  const check = process.argv.includes("--check");
  let stale = 0;
  for (const lang of ["en", "he"]) {
    const want = shards(bundle(lang));
    const have = shardFiles(lang);
    want.forEach((json, i) => {
      const rel = `${OUT_DIR}/help.${lang}.${i}.json`;
      const kb = chunkKb(json);
      if (kb > CHUNK_BUDGET_KB) {
        console.error(`✖ ${rel}: ~${kb.toFixed(1)} KB gzipped, over the ${CHUNK_BUDGET_KB} KB lazy-chunk budget: one page is too large, split it`);
        stale++;
      } else if (check) console.error(`  ${rel}: ~${kb.toFixed(1)} KB gzipped / ${CHUNK_BUDGET_KB} KB`);
      const path = join(ROOT, rel);
      if (existsSync(path) && readFileSync(path, "utf8") === json) return;
      if (check) {
        console.error(`✖ ${rel} is out of date with the docs: run node scripts/help-bundle.mjs`);
        stale++;
      } else {
        mkdirSync(dirname(path), { recursive: true });
        writeFileSync(path, json);
        console.error(`wrote ${rel} (${(json.length / 1024).toFixed(0)} KB)`);
      }
    });
    for (const extra of have.slice(want.length)) {
      if (check) {
        console.error(`✖ ${relative(ROOT, extra)} is left over: run node scripts/help-bundle.mjs`);
        stale++;
      } else unlinkSync(extra);
    }
    // The single-file bundle of W3.7.
    const legacy = join(ROOT, OUT_DIR, `help.${lang}.json`);
    if (existsSync(legacy)) {
      if (check) {
        console.error(`✖ ${OUT_DIR}/help.${lang}.json is the old single-file bundle: run node scripts/help-bundle.mjs`);
        stale++;
      } else unlinkSync(legacy);
    }
  }
  if (stale) process.exit(1);
  if (check) console.error("✓ help bundle: the in-app docs match docs/src/content/docs");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
