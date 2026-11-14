#!/usr/bin/env node
/**
 * Translation review agent (plan 9.4): checks every UI translation of the
 * seven locales against its English source and writes a report.
 *
 *   node scripts/i18n-review.mjs [--out report.md] [--json report.json] [--back]
 *   npm run i18n:review -- …
 *
 * Checks, per locale and key (English from i18n/keys/<domain>.json — regenerate it
 * with `node scripts/extract-i18n-keys.mjs` first):
 *   missing-var   a {placeholder} of the English is not in the translation   (error)
 *   extra-var     a {placeholder} the English doesn't have                   (error)
 *   length        the translation is far shorter or longer than the English  (warning)
 *   untranslated  the translation is the English, word for word              (warning)
 *   deviation     --back: the translation, translated back to English on
 *                 this machine (M2M100 via transformers.js, no cloud), shares
 *                 little with the English (chrF below 25)                   (warning)
 *   missing-key   no translation (the UI shows English)                      (info)
 *
 * Exit status 1 when there is any error (a variable missing or extra), so CI
 * and the tests hold "0 missing variables". Warnings only go to the report.
 */
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

export const LOCALES = ["ar", "de", "fr", "he", "ja", "ru", "zh-CN"];
const CJK = new Set(["ja", "zh-CN"]);

/** `{name}` placeholders (the `{{name}}` form counts as `name` too). */
export function placeholders(s) {
  return [...new Set([...String(s).matchAll(/\{\{?(\w+)\}?\}/g)].map((m) => m[1]))];
}

/** Words that look like product, format or key names — fine to keep in English. */
const KEEP = /^[\s\d\p{P}\p{S}]*$|^(?:[A-Z][\w.+-]*|[\w.+-]*[A-Z][\w.+-]*|⌘\w|Esc|Tab|OK|PDF|URL|API|JSON|CSV|HTML|Markdown|Mermaid|LaTeX|Git(?:Hub)?|Ollama|WebGPU|WebDAV|S3|Dropbox|Drive|Lumen|AI)(?:[\s/·:,()+-]+(?:[A-Z][\w.+-]*|[\w.+-]*[A-Z][\w.+-]*|⌘\w|\d+))*$/u;

/** Character n-gram F-score (chrF, n = 1..4, β = 2), 0..100 — the MT harness's measure. */
export function chrF(hyp, ref, n = 4, beta = 2) {
  const norm = (s) => String(s).toLowerCase().replace(/\s+/g, " ").trim();
  const h = norm(hyp);
  const r = norm(ref);
  if (!h || !r) return 0;
  let p = 0;
  let rc = 0;
  let k = 0;
  for (let i = 1; i <= n; i++) {
    const grams = (s) => {
      const m = new Map();
      for (let j = 0; j + i <= s.length; j++) m.set(s.slice(j, j + i), (m.get(s.slice(j, j + i)) ?? 0) + 1);
      return m;
    };
    const hg = grams(h);
    const rg = grams(r);
    let match = 0;
    let ht = 0;
    let rt = 0;
    for (const v of hg.values()) ht += v;
    for (const v of rg.values()) rt += v;
    for (const [g, c] of hg) match += Math.min(c, rg.get(g) ?? 0);
    if (!ht || !rt) continue;
    p += match / ht;
    rc += match / rt;
    k++;
  }
  if (!k) return 0;
  p /= k;
  rc /= k;
  if (!p && !rc) return 0;
  return (100 * (1 + beta * beta) * p * rc) / (beta * beta * p + rc);
}

/** The findings for one translation of one key (no back-translation). */
export function checkPair(locale, key, en, tr) {
  const out = [];
  if (tr === undefined || tr === null || tr === "") return [{ locale, key, kind: "missing-key", level: "info", detail: "" }];
  const want = placeholders(en);
  const have = placeholders(tr);
  for (const v of want) if (!have.includes(v)) out.push({ locale, key, kind: "missing-var", level: "error", detail: `{${v}}` });
  for (const v of have) if (!want.includes(v)) out.push({ locale, key, kind: "extra-var", level: "error", detail: `{${v}}` });
  const bare = (s) => String(s).replace(/\{\{?\w+\}?\}/g, "").trim();
  const el = bare(en).length;
  const tl = bare(tr).length;
  if (el >= 12) {
    const ratio = tl / el;
    const [lo, hi] = CJK.has(locale) ? [0.12, 2.5] : [0.3, 3];
    if (ratio < lo || ratio > hi) out.push({ locale, key, kind: "length", level: "warning", detail: `${tl} vs ${el} characters (×${ratio.toFixed(2)})` });
    if (tr.trim() === en.trim() && !KEEP.test(bare(en))) out.push({ locale, key, kind: "untranslated", level: "warning", detail: "" });
  }
  return out;
}

/** English strings, from i18n/keys/<domain>.json (the per-domain layout, plan 0.3). */
export function englishStrings(root) {
  const dir = join(root, "i18n/keys");
  const out = new Map();
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) for (const e of JSON.parse(readFileSync(join(dir, f), "utf8")).entries) out.set(e.key, e.en);
  return out;
}

/** A locale's translations: its domain files (src/i18n/locales/<locale>/*.json) and, when present, its lazy files (src/i18n/lazy/<locale>/*.json). */
export function localeStrings(root, locale) {
  const dir = join(root, "src/i18n/locales", locale);
  const out = {};
  for (const f of readdirSync(dir).filter((n) => n.endsWith(".json")).sort()) Object.assign(out, JSON.parse(readFileSync(join(dir, f), "utf8")));
  const lazyDir = join(root, "src/i18n/lazy", locale);
  if (existsSync(lazyDir)) for (const f of readdirSync(lazyDir).filter((n) => n.endsWith(".json"))) Object.assign(out, JSON.parse(readFileSync(join(lazyDir, f), "utf8")));
  return out;
}

/** Review every locale. `back(locale, texts)` → English texts (optional back-translation). */
export async function review(root, { back = null, deviationBelow = 25, sample = Infinity } = {}) {
  const en = englishStrings(root);
  const findings = [];
  const stats = {};
  for (const locale of LOCALES) {
    const tr = localeStrings(root, locale);
    let translated = 0;
    const candidates = [];
    for (const [key, source] of en) {
      const f = checkPair(locale, key, source, tr[key]);
      findings.push(...f);
      if (tr[key]) translated++;
      if (back && tr[key] && source.length >= 12 && !f.some((x) => x.level === "error")) candidates.push([key, source, tr[key]]);
    }
    if (back && candidates.length) {
      const picked = candidates.slice(0, sample);
      const english = await back(locale, picked.map(([, , t]) => t.replace(/\{\{?(\w+)\}?\}/g, "$1")));
      picked.forEach(([key, source], i) => {
        const score = chrF(english[i] ?? "", source.replace(/\{\{?(\w+)\}?\}/g, "$1"));
        if (score < deviationBelow) findings.push({ locale, key, kind: "deviation", level: "warning", detail: `chrF ${score.toFixed(1)}: “${english[i] ?? ""}”` });
      });
      stats[locale] = { keys: en.size, translated, backTranslated: picked.length };
    } else stats[locale] = { keys: en.size, translated };
  }
  return { findings, stats };
}

export function formatReport({ findings, stats }) {
  const count = (kind, locale) => findings.filter((f) => f.kind === kind && (!locale || f.locale === locale)).length;
  const kinds = ["missing-var", "extra-var", "length", "untranslated", "deviation", "missing-key"];
  const lines = [
    "# Translation review (plan 9.4)",
    "",
    `Missing variables: **${count("missing-var")}** · extra variables: **${count("extra-var")}**`,
    "",
    `| locale | translated | ${kinds.join(" | ")} |`,
    `|---|---|${kinds.map(() => "---").join("|")}|`,
    ...LOCALES.map((l) => `| ${l} | ${stats[l]?.translated ?? 0} / ${stats[l]?.keys ?? 0} | ${kinds.map((k) => count(k, l)).join(" | ")} |`),
  ];
  for (const level of ["error", "warning"]) {
    const list = findings.filter((f) => f.level === level);
    if (!list.length) continue;
    lines.push("", `## ${level === "error" ? "Errors" : "Warnings"}`, "");
    for (const f of list.slice(0, 500)) lines.push(`- \`${f.locale}\` \`${f.key}\` — ${f.kind}${f.detail ? `: ${f.detail}` : ""}`);
    if (list.length > 500) lines.push(`- … ${list.length - 500} more`);
  }
  return lines.join("\n") + "\n";
}

/** Back-translation on this machine: M2M100 (MIT) through transformers.js. Downloads the model once. */
async function m2m100Back() {
  const { pipeline } = await import("@huggingface/transformers");
  const translator = await pipeline("translation", "Xenova/m2m100_418M", { dtype: "q8" });
  const code = (l) => (l === "zh-CN" ? "zh" : l);
  return async (locale, texts) => {
    const out = [];
    for (const t of texts) {
      const r = await translator(t, { src_lang: code(locale), tgt_lang: "en" });
      out.push(Array.isArray(r) ? (r[0]?.translation_text ?? "") : "");
    }
    return out;
  };
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const opt = (flag) => {
    const i = args.indexOf(flag);
    return i >= 0 ? args[i + 1] : undefined;
  };
  const root = process.cwd();
  const back = args.includes("--back") ? await m2m100Back() : null;
  const result = await review(root, { back, sample: Number(opt("--sample") ?? Infinity) });
  const md = formatReport(result);
  if (opt("--out")) writeFileSync(opt("--out"), md);
  if (opt("--json")) writeFileSync(opt("--json"), JSON.stringify(result, null, 2) + "\n");
  // hygiene-allow: the report is the output of this CLI
  console.log(md);
  process.exit(result.findings.some((f) => f.level === "error") ? 1 : 0);
}
