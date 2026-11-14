#!/usr/bin/env node
/**
 * The public page of privacy audits (plan W2.24): one row per version, from
 * the audit files in security/privacy-audits/<version>.json (written by
 * scripts/privacy/audit.mjs --publish), into the docs page in English and
 * Hebrew, between the `<!-- audits:start -->` and `<!-- audits:end -->`
 * markers.
 *
 *   node scripts/privacy/publish.mjs           # rewrite the tables
 *   node scripts/privacy/publish.mjs --check   # exit 1 when a table is out of date, or a version is missing
 *
 * "Published for every version since the first": every version in
 * CHANGELOG.md from the first audited one on must have its audit file.
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const AUDIT_FORMAT = "lumen-privacy-audit/1";
export const AUDITS_DIR = "security/privacy-audits";
export const PAGES = { en: "docs/src/content/docs/security/privacy-report.md", he: "docs/src/content/docs/he/security/privacy-report.md" };
const START = "<!-- audits:start -->";
const END = "<!-- audits:end -->";

const parts = (v) => String(v).split(/[.-]/).map((x) => (/^\d+$/.test(x) ? Number(x) : x));
export function compareVersions(a, b) {
  const x = parts(a);
  const y = parts(b);
  for (let i = 0; i < Math.max(x.length, y.length); i++) {
    const p = x[i] ?? 0;
    const q = y[i] ?? 0;
    if (p === q) continue;
    if (typeof p === "number" && typeof q === "number") return p - q;
    return String(p) < String(q) ? -1 : 1;
  }
  return 0;
}

export function readAudits(root) {
  const dir = join(root, AUDITS_DIR);
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith(".json"))
    .map((f) => ({ file: f, audit: JSON.parse(readFileSync(join(dir, f), "utf8")), signed: existsSync(join(dir, `${f}.minisig`)) }))
    .sort((a, b) => compareVersions(b.audit.version, a.audit.version));
}

/** Released versions in CHANGELOG.md (`## [x.y.z] - date`), newest first. */
export function changelogVersions(text) {
  return [...String(text).matchAll(/^## \[(\d+\.\d+\.\d+[^\]]*)\]/gm)].map((m) => m[1]);
}

/** Versions released since the first audit that have no audit file. */
export function missingVersions(released, audits) {
  if (audits.length === 0) return [];
  const first = audits.map((a) => a.audit.version).sort(compareVersions)[0];
  const have = new Set(audits.map((a) => a.audit.version));
  return released.filter((v) => compareVersions(v, first) >= 0 && !have.has(v));
}

const L = {
  en: { head: "| Version | Date | Result | Left the device (proxy / ledger) | Requests the proxy saw | Signed |", none: "_No audit published yet: the first runs with the first release after this page._", pass: "pass", fail: "FAIL", yes: "yes", no: "no" },
  he: { head: "| גרסה | תאריך | תוצאה | יצאו מהמכשיר (proxy / יומן) | בקשות שה-proxy ראה | חתום |", none: "_עדיין לא פורסמה ביקורת: הראשונה תרוץ עם השחרור הראשון אחרי הדף הזה._", pass: "עבר", fail: "נכשל", yes: "כן", no: "לא" },
};

export function renderTable(audits, lang) {
  const l = L[lang];
  if (audits.length === 0) return l.none;
  const rows = audits.map(({ audit: a, signed }) => {
    const proxy = a.observers?.find((o) => o.observer === "mitmproxy") ?? a.observers?.[0];
    const left = `${proxy?.observedNonLocal?.length ?? "?"} / ${proxy?.ledgerNonLocal?.length ?? "?"}`;
    return `| ${a.version} | ${String(a.date).slice(0, 10)} | ${a.result === "pass" ? l.pass : l.fail} | ${left} | ${proxy?.requestsSeen ?? "?"} | ${signed ? l.yes : l.no} |`;
  });
  return [l.head, "|---|---|---|---|---|---|", ...rows].join("\n");
}

export function replaceTable(page, table) {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < a) throw new Error(`The page has no ${START} … ${END} block.`);
  return `${page.slice(0, a + START.length)}\n${table}\n${page.slice(b)}`;
}

/** Rewrite (or, with check, compare) both pages. Returns the problems. */
export function publish(root, { check = false } = {}) {
  const audits = readAudits(root);
  const problems = [];
  for (const [lang, rel] of Object.entries(PAGES)) {
    const file = join(root, rel);
    const page = readFileSync(file, "utf8");
    const next = replaceTable(page, renderTable(audits, lang));
    if (next === page) continue;
    if (check) problems.push(`${rel} is out of date: run node scripts/privacy/publish.mjs`);
    else writeFileSync(file, next);
  }
  const changelog = join(root, "CHANGELOG.md");
  const missing = existsSync(changelog) ? missingVersions(changelogVersions(readFileSync(changelog, "utf8")), audits) : [];
  for (const v of missing) problems.push(`version ${v} has no privacy audit in ${AUDITS_DIR}/`);
  for (const { file, audit } of audits) {
    if (audit.format !== AUDIT_FORMAT) problems.push(`${file}: format is ${JSON.stringify(audit.format)}`);
    if (`${audit.version}.json` !== file) problems.push(`${file}: holds version ${audit.version}`);
  }
  return problems;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const problems = publish(root, { check: process.argv.includes("--check") });
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.log(`✓ privacy audits: ${readAudits(root).length} published`);
}
