#!/usr/bin/env node
/**
 * Two-way sync of the UI strings with Hosted Weblate (plan W6.32).
 *
 *   node scripts/weblate.mjs --write    # write i18n/weblate/en/<domain>.json, Weblate's English base
 *   node scripts/weblate.mjs --check    # (default) the config, the base and every locale file are fit for Weblate
 *   node scripts/weblate.mjs --print    # the settings to enter in Weblate, one component per domain
 *   node scripts/weblate.mjs --queue ar # the review queue of one language: startup strings first, per domain
 *
 * Why a base of its own: the English strings live in two places, the startup
 * set (src/i18n/locales/en/<domain>.json, bundled) and the lazy set
 * (src/i18n/lazy/*.json, shipped with their chunk), but every other language
 * keeps both in one file per domain. Weblate's "Cleanup translation files"
 * add-on keeps only the keys of the base, so a base made of the startup set
 * alone would delete every lazy translation. The base here is both, per
 * domain, sorted, written exactly as the layout writes JSON.
 *
 * Why this stays green after a Weblate pull request: Weblate writes JSON with
 * translate-toolkit (json.dumps, ensure_ascii off, separators ", " / ": ",
 * then a newline). With json_indent 2 and json_sort_keys case_sensitive that
 * is byte for byte what scripts/lib/i18n-files.mjs writes, so
 * `npm run i18n:check` passes on Weblate's files as they are. --check also
 * refuses an empty translation (t() would show it empty: `""` is not
 * missing), which the "Remove blank strings" add-on prevents.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { DOMAINS, LOCALES_DIR, ROOT, SOURCE_LOCALE, domainOf, formatJson, listLocales, placeholders, sortedObject } from "./lib/i18n-files.mjs";
import { lazyEnglishEntries } from "./lib/i18n-lazy.mjs";

const CONFIG_FILE = join(ROOT, "i18n/weblate/config.json");
const BASE_DIR = join(ROOT, "i18n/weblate/en");
const argv = process.argv.slice(2);
const mode = argv.includes("--write") ? "write" : argv.includes("--print") ? "print" : argv.includes("--queue") ? "queue" : "check";

const readJson = (f) => JSON.parse(readFileSync(f, "utf8"));
const config = readJson(CONFIG_FILE);
const domains = Object.keys(DOMAINS).sort();

/** The startup English of one domain (bundled). */
const startup = (d) => {
  const f = join(LOCALES_DIR, SOURCE_LOCALE, `${d}.json`);
  return existsSync(f) ? readJson(f) : {};
};
/** Weblate's base: startup + lazy English, by domain. */
export function baseByDomain() {
  const out = Object.fromEntries(domains.map((d) => [d, { ...startup(d) }]));
  for (const [k, v] of lazyEnglishEntries(ROOT)) {
    const d = domainOf(k);
    if (!(k in out[d])) out[d][k] = v;
  }
  for (const d of domains) out[d] = sortedObject(out[d]);
  return out;
}

if (mode === "write") {
  mkdirSync(BASE_DIR, { recursive: true });
  const base = baseByDomain();
  let changed = 0;
  for (const d of domains) {
    const f = join(BASE_DIR, `${d}.json`);
    const text = formatJson(base[d]);
    if (!existsSync(f) || readFileSync(f, "utf8") !== text) {
      writeFileSync(f, text);
      changed++;
    }
  }
  console.log(`✓ Weblate base: ${domains.length} domains, ${Object.values(base).reduce((n, m) => n + Object.keys(m).length, 0)} English strings; ${changed} file(s) written`);
  process.exit(0);
}

if (mode === "print") {
  const c = config.component;
  console.log(`Weblate project "${config.project.name}" (${config.project.slug}) on ${config.instance}`);
  console.log(`Repository ${config.repository.url}, branch ${config.repository.branch}, version control "GitHub pull request" (${config.repository.access})\n`);
  console.log("| Component | File mask | Monolingual base language file | Strings |");
  console.log("|---|---|---|---|");
  const base = baseByDomain();
  for (const d of domains) console.log(`| ${d} | \`${c.filemask.replace("{domain}", d)}\` | \`${c.template.replace("{domain}", d)}\` | ${Object.keys(base[d]).length} |`);
  console.log(`\nEvery component: file format "JSON file" (${c.file_format}); file format parameters ${JSON.stringify(c.file_format_params)};`);
  console.log(`language filter ${c.language_regex}; edit base file: ${c.edit_template ? "on" : "off"}; adding new translation: ${c.new_lang === "none" ? "off" : c.new_lang};`);
  console.log(`translation flags ${c.check_flags}; reviews ${c.enable_review ? "on" : "off"}; licence ${c.license}; add-ons ${c.addons.join(", ")}.`);
  process.exit(0);
}

if (mode === "queue") {
  const lang = argv[argv.indexOf("--queue") + 1];
  if (!lang || !listLocales().includes(lang) || lang === SOURCE_LOCALE) {
    console.error(`usage: node scripts/weblate.mjs --queue <lang>; one of ${listLocales().filter((l) => l !== SOURCE_LOCALE).join(", ")}`);
    process.exit(2);
  }
  const rows = [];
  for (const d of domains) {
    const st = startup(d);
    const tr = existsSync(join(LOCALES_DIR, lang, `${d}.json`)) ? readJson(join(LOCALES_DIR, lang, `${d}.json`)) : {};
    rows.push({ d, startup: Object.keys(st).length, translated: Object.keys(st).filter((k) => tr[k]).length });
  }
  const total = rows.reduce((n, r) => n + r.startup, 0);
  console.log(`Review queue for ${lang}: the ${total} startup strings first (the UI before any lazy screen opens), largest domain first.`);
  console.log("| Weblate component | Startup strings | Translated now |\n|---|---|---|");
  for (const r of rows.sort((a, b) => b.startup - a.startup)) console.log(`| ${r.d} | ${r.startup} | ${r.translated} |`);
  console.log("\nIn Weblate: open each component in this order, filter \"Strings waiting for review\", and approve or fix each one.");
  process.exit(0);
}

// --check
const problems = [];
const c = config.component;
const expectedParams = { json_indent: 2, json_indent_style: "spaces", json_sort_keys: "case_sensitive", json_use_compact_separators: false };
for (const [k, v] of Object.entries(expectedParams)) if (c.file_format_params?.[k] !== v) problems.push(`config: file_format_params.${k} must be ${JSON.stringify(v)} so Weblate writes the layout's JSON`);
if (c.file_format !== "json") problems.push(`config: file_format must be "json" (flat keys), not ${c.file_format}`);
for (const a of ["weblate.cleanup.generic", "weblate.cleanup.blank"]) if (!c.addons?.includes(a)) problems.push(`config: the ${a} add-on is required`);
if (c.edit_template !== false) problems.push("config: English is edited in the code, not in Weblate (edit_template false)");
const re = new RegExp(c.language_regex);
if (re.test(SOURCE_LOCALE)) problems.push("config: language_regex must leave English out");
const locales = listLocales().filter((l) => l !== SOURCE_LOCALE);
for (const l of locales) if (!re.test(l)) problems.push(`config: language_regex leaves out ${l}`);
for (const l of config.languages) if (!locales.includes(l)) problems.push(`config: ${l} has no folder under src/i18n/locales`);

const base = baseByDomain();
for (const d of domains) {
  const f = join(BASE_DIR, `${d}.json`);
  if (!existsSync(f)) problems.push(`i18n/weblate/en/${d}.json is missing: run node scripts/weblate.mjs --write`);
  else if (readFileSync(f, "utf8") !== formatJson(base[d])) problems.push(`i18n/weblate/en/${d}.json is out of date: run node scripts/weblate.mjs --write`);
}
const extra = existsSync(BASE_DIR) ? readdirSync(BASE_DIR).filter((f) => !domains.includes(f.replace(/\.json$/, ""))) : [];
for (const f of extra) problems.push(`i18n/weblate/en/${f} is not a domain`);

let files = 0;
let stale = 0;
for (const l of locales)
  for (const d of domains) {
    const f = join(LOCALES_DIR, l, `${d}.json`);
    if (!existsSync(f)) continue;
    files++;
    const text = readFileSync(f, "utf8");
    const m = JSON.parse(text);
    if (text !== formatJson(sortedObject(m))) problems.push(`${l}/${d}.json is not written as Weblate will write it (sorted, 2 spaces, newline at the end)`);
    for (const [k, v] of Object.entries(m)) {
      if (typeof v !== "string") problems.push(`${l}/${d}.json: ${k} is not a string (the "json" format is flat)`);
      else if (v === "") problems.push(`${l}/${d}.json: ${k} is empty, which the UI would show as empty`);
      else if (k in base[d]) {
        const want = placeholders(base[d][k]).sort().join(",");
        if (placeholders(v).sort().join(",") !== want) problems.push(`${l}/${d}.json: ${k} has placeholders {${placeholders(v).join("}, {")}}, English {${placeholders(base[d][k]).join("}, {")}}`);
      } else stale++;
    }
  }
for (const p of problems) console.log(`✗ ${p}`);
if (problems.length) process.exit(1);
console.log(`✓ Weblate: ${domains.length} components, ${Object.values(base).reduce((n, m) => n + Object.keys(m).length, 0)} English strings in the base, ${files} translation files fit for two-way sync${stale ? ` (${stale} key(s) no longer in English; Weblate's cleanup add-on drops them)` : ""}`);
