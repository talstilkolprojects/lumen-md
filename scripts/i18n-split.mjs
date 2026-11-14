#!/usr/bin/env node
/**
 * Move the translations to the per-domain layout (plan 0.3), and keep them
 * there. Idempotent; never drops a string.
 *
 *   node scripts/i18n-split.mjs                 # migrate / normalise
 *   node scripts/i18n-split.mjs --check         # CI: fail if anything would change
 *   node scripts/i18n-split.mjs --absorb <ref>  # re-apply <ref>'s own string changes
 *
 * Migrate / normalise:
 *  1. src/i18n/index.ts: the inline `const en: Strings = { … }` block and
 *     the single-file `loadLocale()` of the old layout are replaced by the
 *     loaders of the new one (the English strings are kept, see 2).
 *  2. Every language: the old src/i18n/locales/<lang>.json (and, for
 *     English, the inline block) is merged over
 *     src/i18n/locales/<lang>/*.json and deleted. Values from the old files
 *     win, so a branch's own edits are kept.
 *  3. Every language is rewritten as one sorted file per domain
 *     (scripts/lib/i18n-files.mjs says which key goes where).
 *  4. i18n/keys/<domain>.json is regenerated; the old i18n/keys.json goes.
 *
 * --absorb <ref>, for a branch started before the split, after it was
 * rebased (or merged) onto the new layout with the base's side of every
 * i18n file: compares <ref> (the branch's old tip) with its fork point
 * (`git merge-base <ref> HEAD`), key by key and language by language, and
 * applies exactly what the branch added, changed or removed to the domain
 * files. Either commit may be in either layout. See src/i18n/locales/README.md.
 */
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import {
  KEYS_DIR,
  LOCALES_DIR,
  ROOT,
  SOURCE_LOCALE,
  buildKeyFiles,
  formatJson,
  listLocales,
  readLocale,
  splitByDomain,
} from "./lib/i18n-files.mjs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";

const argv = process.argv.slice(2);
const check = argv.includes("--check");
const absorbRef = argv.includes("--absorb") ? argv[argv.indexOf("--absorb") + 1] : null;
if (argv.includes("--absorb") && !absorbRef) {
  console.error("usage: node scripts/i18n-split.mjs --absorb <ref>");
  process.exit(2);
}

const INDEX = join(ROOT, "src", "i18n", "index.ts");
const OLD_KEYS = join(ROOT, "i18n", "keys.json");
const rel = (p) => relative(ROOT, p);

// ── 1. The index.ts codemod ────────────────────────────────────────────────

/** The old inline English block, with its declaration and trailing blank lines. */
const INLINE_EN = /^const en:\s*Strings\s*=\s*\{\n([\s\S]*?)^\};\n\n*/m;

const LOADERS = `// English, the fallback for every key, ships in the main chunk: each domain
// file of ./locales/en/ is imported eagerly, so t() stays synchronous.
// Strings are added to those JSON files, not here (plan 0.3; src/i18n/locales/README.md).
const EN_FILES = import.meta.glob<Strings>("./locales/en/*.json", { eager: true, import: "default" });
const en: Strings = Object.assign({}, ...Object.keys(EN_FILES).sort().map((f) => EN_FILES[f]));

/**
 * Every other language: one lazy chunk per domain file. A locale is loaded
 * whole (all its domains in parallel) the first time it is selected.
 */
const LAZY_FILES = import.meta.glob<Strings>(["./locales/*/*.json", "!./locales/en/*.json"], { import: "default" });

`;

/** The old single-file loadLocale(), doc comment included. */
const OLD_LOAD = /\/\*\*\n \* Lazy-load a locale's translations\. Returns the loaded bundle or\n[\s\S]*?\nexport async function loadLocale\(locale: Locale\): Promise<Strings> \{\n[\s\S]*?\n\}\n/;

const NEW_LOAD = `/**
 * Lazy-load a locale's translations: every domain file of the locale, in
 * parallel. Returns the loaded bundle, or falls back to \`en\` when the
 * locale has no files or any of them fails to load (offline): a locale
 * is cached only whole, so a half-loaded one is never applied.
 * Subsequent calls hit the cache.
 */
export async function loadLocale(locale: Locale): Promise<Strings> {
  const cached = BUNDLES[locale];
  if (cached) return cached;
  const prefix = \`./locales/\${locale}/\`;
  const files = Object.keys(LAZY_FILES)
    .filter((f) => f.startsWith(prefix))
    .sort();
  if (files.length === 0) return en;
  try {
    const parts = await Promise.all(files.map((f) => LAZY_FILES[f]()));
    const bundle: Strings = Object.assign({}, ...parts);
    BUNDLES[locale] = bundle;
    return bundle;
  } catch {
    return en;
  }
}
`;

/** Comments that described the old layout. */
const COMMENT_EDITS = [
  [
    ` * Tiny in-process i18n helper. Strings live in a single resource map, keyed by
 * a hierarchical id; missing keys fall back to English (and then to the id
 * itself, so the UI never goes blank).`,
    ` * Tiny in-process i18n helper. Strings are keyed by a hierarchical id and
 * live in \`./locales/<lang>/<domain>.json\` (plan 0.3, locales/README.md);
 * missing keys fall back to English (and then to the id itself, so the UI
 * never goes blank).`,
  ],
  ["// zh-CN are lazy-loaded from `src/i18n/locales/<code>.json` when one is", "// zh-CN are lazy-loaded from `src/i18n/locales/<code>/*.json` when one is"],
  [" * lives in `./locales/<code>.json` and is fetched on demand by", " * lives in `./locales/<code>/*.json` and is fetched on demand by"],
];

/** index.ts in the new layout, and the English strings its inline block held. */
function migrateIndex(text) {
  let inline = {};
  const m = INLINE_EN.exec(text);
  if (m) {
    // A plain object literal of string pairs: evaluate it rather than regex
    // it, so every JS escape (\n, …, \") comes out right.
    inline = new Function(`return {${m[1]}};`)();
    text = text.replace(INLINE_EN, text.includes("const EN_FILES = import.meta.glob") ? "" : LOADERS);
  }
  if (OLD_LOAD.test(text)) text = text.replace(OLD_LOAD, NEW_LOAD);
  for (const [from, to] of COMMENT_EDITS) text = text.replace(from, to);
  return { text, inline };
}

// ── --absorb: a commit's strings, in either layout ──────────────────────────

function git(...args) {
  return execFileSync("git", args, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 });
}

/** Every language's strings at a commit: { lang: { key: value } }. */
function stringsAt(ref) {
  const out = {};
  const files = git("ls-tree", "-r", "--name-only", ref, "--", "src/i18n/locales").split("\n").filter(Boolean);
  for (const f of files) {
    const nested = /^src\/i18n\/locales\/([^/]+)\/[^/]+\.json$/.exec(f);
    const flat = /^src\/i18n\/locales\/([^/]+)\.json$/.exec(f);
    const lang = nested?.[1] ?? flat?.[1];
    if (!lang) continue;
    Object.assign((out[lang] ??= {}), JSON.parse(git("show", `${ref}:${f}`)));
  }
  const index = git("show", `${ref}:src/i18n/index.ts`);
  Object.assign((out[SOURCE_LOCALE] ??= {}), migrateIndex(index).inline);
  return out;
}

// ── 2. + 3. + 4. Plan every file ────────────────────────────────────────────

/** path → planned text (null: delete). */
const plan = new Map();

const indexBefore = readFileSync(INDEX, "utf8");
const { text: indexAfter, inline: inlineEn } = migrateIndex(indexBefore);
if (indexAfter !== indexBefore) plan.set(INDEX, indexAfter);

const langs = new Set([SOURCE_LOCALE, ...listLocales()]);
const oldFiles = existsSync(LOCALES_DIR) ? readdirSync(LOCALES_DIR).filter((n) => n.endsWith(".json")) : [];
for (const name of oldFiles) langs.add(name.slice(0, -5));

const strings = {};
for (const lang of langs) {
  const merged = readLocale(lang);
  const oldPath = join(LOCALES_DIR, `${lang}.json`);
  if (existsSync(oldPath)) {
    Object.assign(merged, JSON.parse(readFileSync(oldPath, "utf8")));
    plan.set(oldPath, null);
  }
  if (lang === SOURCE_LOCALE) Object.assign(merged, inlineEn);
  strings[lang] = merged;
}

const absorbed = [];
if (absorbRef) {
  const forkPoint = git("merge-base", absorbRef, "HEAD").trim();
  const before = stringsAt(forkPoint);
  const after = stringsAt(absorbRef);
  for (const lang of new Set([...Object.keys(before), ...Object.keys(after)])) {
    const b = before[lang] ?? {};
    const a = after[lang] ?? {};
    const target = (strings[lang] ??= {});
    langs.add(lang);
    let added = 0;
    let changed = 0;
    let removed = 0;
    for (const [k, v] of Object.entries(a)) {
      if (b[k] === v) continue;
      if (k in b) changed++;
      else added++;
      target[k] = v;
    }
    for (const k of Object.keys(b)) {
      if (!(k in a) && k in target) {
        delete target[k];
        removed++;
      }
    }
    if (added || changed || removed) absorbed.push(`${lang}: +${added} ~${changed} -${removed}`);
  }
  console.error(`absorbing ${absorbRef} since ${forkPoint.slice(0, 8)}: ${absorbed.join(", ") || "no string changes"}`);
}

for (const lang of [...langs].sort()) {
  const folder = join(LOCALES_DIR, lang);
  const parts = splitByDomain(strings[lang]);
  if (existsSync(folder)) {
    for (const name of readdirSync(folder).filter((n) => n.endsWith(".json"))) {
      if (!(name.slice(0, -5) in parts)) plan.set(join(folder, name), null);
    }
  }
  for (const [d, part] of Object.entries(parts)) plan.set(join(folder, `${d}.json`), formatJson(part));
}

// The key files cover the English of lazily loaded domains too (src/i18n/lazy/*.json),
// which stays out of locales/en/ so it ships with its own chunk.
const keyFiles = buildKeyFiles({ ...strings[SOURCE_LOCALE], ...Object.fromEntries(lazyEnglishEntries(ROOT)) });
if (existsSync(KEYS_DIR)) {
  for (const name of readdirSync(KEYS_DIR).filter((n) => n.endsWith(".json"))) {
    if (!(name.slice(0, -5) in keyFiles)) plan.set(join(KEYS_DIR, name), null);
  }
}
for (const [d, file] of Object.entries(keyFiles)) plan.set(join(KEYS_DIR, `${d}.json`), formatJson(file));
if (existsSync(OLD_KEYS)) plan.set(OLD_KEYS, null);

// Keep only real changes.
const changes = [...plan].filter(([path, text]) =>
  text === null ? existsSync(path) : !existsSync(path) || readFileSync(path, "utf8") !== text,
);
const en = strings[SOURCE_LOCALE];

if (check) {
  if (changes.length === 0) {
    console.error(`✓ i18n layout is current (${Object.keys(en).length} keys, ${langs.size} languages)`);
    process.exit(0);
  }
  console.error(`✗ i18n layout is stale: ${changes.length} file(s) would change. Run \`node scripts/i18n-split.mjs\`.`);
  for (const [path, text] of changes.slice(0, 20)) console.error(`  ${text === null ? "delete" : "write "} ${rel(path)}`);
  process.exit(1);
}

for (const [path, text] of changes) {
  if (text === null) rmSync(path);
  else {
    mkdirSync(join(path, ".."), { recursive: true });
    writeFileSync(path, text);
  }
}
console.error(
  `✓ i18n: ${Object.keys(en).length} keys in ${Object.keys(keyFiles).length} domains, ${langs.size} languages` +
    (changes.length ? `; ${changes.length} file(s) changed` : "; nothing to change"),
);
for (const lang of [...langs].sort()) {
  if (lang === SOURCE_LOCALE) continue;
  const missing = Object.keys(en).filter((k) => !(k in strings[lang])).length;
  if (missing) console.error(`  ${lang}: ${missing} key(s) still untranslated (English is used)`);
}
