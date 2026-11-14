#!/usr/bin/env node
/**
 * Draft translations for new i18n keys in every language (plan 9.6).
 *
 *   npm run i18n:draft                         every English key a language lacks
 *   npm run i18n:draft -- --keys=a.b,c.d       only these keys
 *   npm run i18n:draft -- --engine=fake        no model: "[he] English" (dry run, tests)
 *   npm run i18n:draft -- --model=qwen2.5:7b   the Ollama model (OLLAMA_HOST for the address)
 *   npm run i18n:draft -- --approve=he [--keys=…]   mark drafts as reviewed
 *   npm run i18n:draft -- --list               what still needs review
 *
 * Drafts go into src/i18n/locales/<lang>/<domain>.json and are listed in
 * i18n/needs-review/<domain>.json; the values gate counts a listed draft as
 * untranslated until it is approved. A draft that loses a {placeholder} or
 * `code` is not written. --locales and --review point at other trees (tests).
 */
import { argv, env, exit } from "node:process";
import { resolve } from "node:path";
import { LOCALES_DIR, readLocale, writeLocale } from "./lib/i18n-files.mjs";
import { DRAFT_LOCALES, REVIEW_DIR, approve, draftMissing, fakeEngine, ollamaEngine, readNeedsReview, unreviewed, writeNeedsReview } from "./lib/i18n-draft.mjs";

const args = {};
for (const a of argv.slice(2)) {
  const m = /^--([\w-]+)(?:=(.*))?$/.exec(a);
  if (m) args[m[1]] = m[2] === undefined ? true : m[2];
}
const localesDir = resolve(args.locales ?? LOCALES_DIR);
const reviewDir = resolve(args.review ?? REVIEW_DIR);
const keys = typeof args.keys === "string" ? args.keys.split(",").map((k) => k.trim()).filter(Boolean) : undefined;
const langs = typeof args.lang === "string" ? args.lang.split(",") : DRAFT_LOCALES;

const en = readLocale("en", localesDir);
const review = readNeedsReview(reviewDir);

if (args.list) {
  let total = 0;
  for (const lang of langs) {
    const left = unreviewed(lang, en, review);
    total += left.length;
    if (left.length) console.log(`${lang}: ${left.length} — ${left.slice(0, 10).join(", ")}${left.length > 10 ? ", …" : ""}`);
  }
  console.log(`${total} draft(s) need review`);
  exit(0);
}

if (typeof args.approve === "string") {
  const n = approve(review, args.approve, keys);
  writeNeedsReview(review, reviewDir);
  console.log(`✓ ${n} ${args.approve} draft(s) approved`);
  exit(0);
}

const engine =
  args.engine === "fake"
    ? fakeEngine()
    : ollamaEngine({ host: env.OLLAMA_HOST ?? "http://127.0.0.1:11434", model: typeof args.model === "string" ? args.model : "qwen2.5:7b" });

const locales = Object.fromEntries(langs.map((l) => [l, readLocale(l, localesDir)]));
const { drafts, rejected } = await draftMissing({ en, locales, engine, keys, review });

let written = 0;
for (const [lang, map] of Object.entries(drafts)) {
  writeLocale(lang, { ...locales[lang], ...map }, localesDir);
  written += Object.keys(map).length;
}
writeNeedsReview(review, reviewDir);

for (const r of rejected) console.error(`  ✗ ${r.lang} ${r.key}: ${r.reason}`);
console.log(`✓ ${written} draft(s) written with ${engine.id} — marked needs-review (${rejected.length} rejected)`);
exit(rejected.length && !written ? 1 : 0);
