#!/usr/bin/env node
/**
 * docs-parity: the Hebrew docs say everything the English docs say.
 *
 * docs-complete checks that every page has a Hebrew twin. This checks what
 * is inside the twin, page by page (docs/src/content/docs/<slug> against
 * docs/src/content/docs/he/<slug>):
 *
 * 1. missing — an English page with no Hebrew twin.
 * 2. sections — the Hebrew page has a different heading outline (the
 *    levels of its ##, ###, #### headings, in order). The Hebrew page is the
 *    English one translated section for section: the in-app help
 *    (scripts/help-bundle.mjs) maps a Hebrew section to its English anchor
 *    only when the two outlines have the same number of sections, so a
 *    Hebrew page with fewer sections breaks every "?" that names a section.
 *    The English headings the Hebrew outline most likely lacks are listed.
 * 3. anchors — every help topic the app names (`<HelpButton topic="…">`,
 *    `learnHow("…")`, `openHelp("…")` in src/) lands on a page that exists
 *    in both languages, and its `#section` is a real English section that
 *    the Hebrew page carries (its key, as the help bundle packs it).
 * 4. links — a link with a `#section` (`](/he/ai/local-agents/#tools)`,
 *    `](#tools)`) names a section the target page has: its own anchor, or
 *    the English anchor the help bundle keys it by (the in-app help follows
 *    either).
 * 5. short — the Hebrew page has under 60% of the English page's words
 *    (code blocks, markup and front matter not counted). Hebrew runs a bit
 *    shorter than English (prefixes join the word), but not by half.
 *
 *   node scripts/docs-parity.mjs            # report only, exit 0
 *   node scripts/docs-parity.mjs --strict   # exit 1 on any problem: the gate
 *                                           # (npm run docs:parity, and inside
 *                                           # docs:complete, a Vercel preview gate, W6.28)
 *   node scripts/docs-parity.mjs --json     # the report as JSON
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { bundle, plainText, slugify } from "./help-bundle.mjs";

export const SHORT_RATIO = 0.6;

/** Front matter off, MDX imports and component tags off: the Markdown body. */
export function body(src) {
  const s = src.replace(/\r\n/g, "\n");
  const m = /^---\n([\s\S]*?)\n---\n?/.exec(s);
  return s
    .slice(m ? m[0].length : 0)
    .replace(/^import\s.+$/gm, "")
    .replace(/<\/?[A-Z][\w.]*[^>]*>/g, "");
}

/** The ##–#### headings of a Markdown body, outside code fences: level, text, anchor. */
export function outline(md) {
  const out = [];
  let fence = false;
  for (const line of md.split("\n")) {
    if (/^(```|~~~)/.test(line)) fence = !fence;
    const h = !fence && /^(#{2,4})\s+(.+?)\s*#*$/.exec(line);
    if (!h) continue;
    const heading = h[2].replace(/[*_`]/g, "").replace(/\[([^\]]+)\]\([^)]*\)/g, "$1");
    out.push({ level: h[1].length, heading, anchor: slugify(heading) });
  }
  return out;
}

/** Words of prose: no code, no markup. */
export function wordCount(md) {
  const text = plainText(md);
  return text ? text.split(/\s+/).filter((w) => /[\p{L}\p{N}]/u.test(w)).length : 0;
}

/**
 * The English headings a shorter outline most likely lacks: a longest common
 * subsequence of the two level sequences, and the English headings left out.
 */
export function unmatched(en, he) {
  const n = en.length;
  const m = he.length;
  const L = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(0));
  for (let i = n - 1; i >= 0; i--)
    for (let j = m - 1; j >= 0; j--) L[i][j] = en[i].level === he[j].level ? L[i + 1][j + 1] + 1 : Math.max(L[i + 1][j], L[i][j + 1]);
  const out = [];
  let i = 0;
  let j = 0;
  while (i < n) {
    if (j < m && en[i].level === he[j].level && L[i][j] === L[i + 1][j + 1] + 1) {
      i++;
      j++;
    } else if (j < m && L[i][j + 1] >= L[i + 1][j]) j++;
    else out.push(en[i++]);
  }
  return out;
}

/**
 * Links with a section: `](/a/b/#x)` → { target: "a/b", anchor: "x" }, and
 * `](#x)` → { target: null, anchor: "x" } (this page). Code is skipped.
 */
export function sectionLinks(md) {
  const text = md.replace(/```[\s\S]*?```/g, "").replace(/`[^`\n]*`/g, "");
  const out = [];
  for (const m of text.matchAll(/\]\((\/[^)\s#?]*)?#([^)\s]+)\)/g)) {
    const target = m[1] === undefined ? null : m[1].replace(/^\/+|\/+$/g, "");
    if (target !== null && /\.[a-z0-9]+$/i.test(target)) continue;
    out.push({ target, anchor: decodeURIComponent(m[2]) });
  }
  return out;
}

/** Help topics the app's source names: `slug` or `slug#anchor`, with the file. */
export function helpTopics(files) {
  const out = [];
  const re = /(?:<HelpButton\s+topic=|\blearnHow\(\s*|\bopenHelp\(\s*)"([a-z0-9-]+(?:\/[a-z0-9-]+)+(?:#[a-z0-9-]+)?)"/g;
  for (const { rel, text } of files) for (const m of text.matchAll(re)) out.push({ topic: m[1], file: rel });
  return out;
}

/**
 * The report. `pages.en` / `pages.he`: slug → { outline, words, keys } where
 * `keys` is the set of section keys the help bundle packs for that page.
 */
export function parity({ pages, topics = [], ratio = SHORT_RATIO }) {
  const report = { missing: [], sections: [], anchors: [], links: [], short: [] };
  for (const [slug, en] of [...pages.en].sort(([a], [b]) => a.localeCompare(b))) {
    const he = pages.he.get(slug);
    if (!he) {
      report.missing.push({ slug, words: en.words });
      continue;
    }
    const same = en.outline.length === he.outline.length && en.outline.every((s, i) => s.level === he.outline[i].level);
    if (!same) {
      report.sections.push({
        slug,
        en: en.outline.length,
        he: he.outline.length,
        lacking: he.outline.length < en.outline.length ? unmatched(en.outline, he.outline).map((s) => `${"#".repeat(s.level)} ${s.heading}`) : [],
      });
    }
    if (en.words > 0 && he.words < en.words * ratio) report.short.push({ slug, en: en.words, he: he.words, ratio: +(he.words / en.words).toFixed(2) });
  }
  for (const lang of ["en", "he"]) {
    for (const [slug, page] of [...pages[lang]].sort(([a], [b]) => a.localeCompare(b))) {
      for (const { target, anchor } of page.links ?? []) {
        const he = target === null ? lang === "he" : target === "he" || target.startsWith("he/");
        const dest = pages[he ? "he" : "en"].get(target === null ? slug : target.replace(/^he\/?/, ""));
        if (!dest) continue; // a missing page is docs-complete's to report
        if (!dest.anchors?.has(anchor) && !dest.keys.has(anchor)) report.links.push({ slug, lang, link: `${target === null ? "" : `/${target}/`}#${anchor}` });
      }
    }
  }
  const seen = new Set();
  for (const { topic, file } of topics) {
    if (seen.has(topic)) continue;
    seen.add(topic);
    const [slug, anchor] = topic.split("#");
    for (const lang of ["en", "he"]) {
      const page = pages[lang].get(slug);
      if (!page) report.anchors.push({ topic, file, lang, problem: "no such page" });
      else if (anchor && !page.keys.has(anchor)) report.anchors.push({ topic, file, lang, problem: `no section #${anchor}` });
    }
  }
  return report;
}

/** One line per problem. */
export function lines(report) {
  return [
    ...report.missing.map((p) => `missing   ${p.slug}: no Hebrew page (${p.words} English words)`),
    ...report.sections.map((p) => `sections  ${p.slug}: English ${p.en} sections, Hebrew ${p.he}${p.lacking.length ? ` — lacks ${p.lacking.join(" · ")}` : ""}`),
    ...report.anchors.map((p) => `anchor    ${p.topic} (${p.lang}, ${p.file}): ${p.problem}`),
    ...report.links.map((p) => `link      ${p.lang === "he" ? "he/" : ""}${p.slug}: ${p.link} — no such section`),
    ...report.short.map((p) => `short     ${p.slug}: Hebrew ${p.he} words, English ${p.en} (${Math.round(p.ratio * 100)}%)`),
  ];
}

function walk(dir, skip = () => false) {
  const out = [];
  for (const n of readdirSync(dir).sort()) {
    const p = join(dir, n);
    if (statSync(p).isDirectory()) {
      if (!skip(n)) out.push(...walk(p, skip));
    } else out.push(p);
  }
  return out;
}

export function load(root) {
  const DOCS = join(root, "docs/src/content/docs");
  const keys = { en: new Map(), he: new Map() };
  for (const lang of ["en", "he"]) for (const p of bundle(lang).pages) keys[lang].set(p.slug, new Set(p.sections.map((s) => s.key)));
  const pages = { en: new Map(), he: new Map() };
  for (const file of walk(DOCS).filter((f) => /\.mdx?$/.test(f))) {
    const rel = relative(DOCS, file).split("\\").join("/");
    const lang = rel.startsWith("he/") ? "he" : "en";
    const slug = rel.replace(/^he\//, "").replace(/\.mdx?$/, "").replace(/(^|\/)index$/, "");
    const md = body(readFileSync(file, "utf8"));
    const out = outline(md);
    pages[lang].set(slug, { outline: out, anchors: new Set(out.map((h) => h.anchor)), links: sectionLinks(md), words: wordCount(md), keys: keys[lang].get(slug) ?? new Set() });
  }
  const src = walk(join(root, "src"), (n) => n === "__tests__" || n === "generated")
    .filter((f) => /\.(tsx?|mjs)$/.test(f) && !/\.(test|spec)\.tsx?$/.test(f))
    .map((f) => ({ rel: relative(root, f).split("\\").join("/"), text: readFileSync(f, "utf8") }));
  return { pages, topics: helpTopics(src) };
}

function main() {
  const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const report = parity(load(ROOT));
  if (process.argv.includes("--json")) {
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    return;
  }
  const out = lines(report);
  const strict = process.argv.includes("--strict");
  if (!out.length) {
    process.stdout.write("✓ docs-parity: every Hebrew page has its English page's sections, help anchors and most of its words\n");
    return;
  }
  console.error(out.join("\n"));
  const n = (k) => report[k].length;
  console.error(
    `\n${strict ? "✗" : "⚠"} docs-parity: ${n("missing")} missing, ${n("sections")} with other sections, ${n("anchors")} help anchors, ${n("links")} section links, ${n("short")} short (under ${Math.round(SHORT_RATIO * 100)}%)${strict ? "" : " — report only; --strict (npm run docs:complete) fails"}`,
  );
  if (strict) process.exit(1);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
