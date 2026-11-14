#!/usr/bin/env node
/**
 * `npm run security:audit-claims` (plan W11.S1): no user-facing text calls
 * Lumen's cryptography audited while no external audit report is published.
 *
 * Lumen's encryption is written in this repo and has had no external
 * security audit (security/crypto-audit.json). A sentence that puts an audit
 * word ("audited", "security audit", "Cure53", "מבוקר", "ביקורת אבטחה" …)
 * next to a crypto word ("encrypt", "E2EE", "crypto", "הצפנה" …) fails,
 * unless the sentence says the opposite ("not audited", "unaudited",
 * "לא עבר ביקורת") or security/crypto-audit.json names a published report.
 *
 *   node scripts/security/audit-claims.mjs [--json]
 */
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { auditPublished } from "../lib/flags.mjs";

/** The user-facing text: docs, READMEs, launch copy, static pages and every UI string. */
export const SCAN = [
  "README.md",
  "README.en.md",
  "PRIVACY.md",
  "SECURITY.md",
  "docs/src/content/docs",
  "launch",
  "public",
  "src/i18n",
  "store",
  "fastlane",
];
const EXT = /\.(md|mdx|html|json|txt)$/i;
/** Not user-facing: generated help (built from the docs scanned here) and data files. */
const SKIP = [/^src\/help\/generated\//, /^public\/dict\//, /^public\/plugins\//, /^public\/models?\//, /\.min\./];

const AUDIT_EN = /\b(audited|audit(?:s|ed)? (?:by|from)|security[- ]audit(?:ed)?|external(?:ly)? (?:audit|review)(?:ed)?|independent(?:ly)? (?:audit|review)(?:ed)?|third[- ]party (?:audit|review)(?:ed)?|cure53|trail of bits|pen(?:etration)?[- ]?test(?:ed)?)\b/i;
const AUDIT_HE = /(מבוקר|מבוקרת|עבר(?:ה)? ביקורת|ביקורת אבטחה|ביקורת חיצונית|נבדק(?:ה)? על ידי|נבדק(?:ה)? ע״י|מבדק חדירה)/;
const CRYPTO = /(\bencrypt\w*|\bcrypto\w*|\bcipher\w*|\be2ee\b|end[- ]to[- ]end|\bargon2\w*|\bchacha\w*|\bkeyring\b|הצפנ\w*|מוצפ\w*|קריפטו\w*|צופן)/i;
const NEGATION = /(\bnot\b|\bno\b|\bunaudited\b|\bnever\b|\bwithout\b|\buntil\b|\bnor\b|\bhasn'?t\b|\bisn'?t\b|\byet to\b|(?:^|[\s״"(])(?:לא|טרם|ללא|בלי|אין|עד ש)(?=[\s,.;:)]|$))/i;

/** The sentences of a text. */
const sentences = (text) => text.split(/(?<=[.!?:;])\s+|\n+/).map((s) => s.trim()).filter(Boolean);

/** Sentences of `text` that call the cryptography audited. */
export function auditClaims(text) {
  return sentences(text).filter((s) => (AUDIT_EN.test(s) || AUDIT_HE.test(s)) && CRYPTO.test(s) && !NEGATION.test(s));
}

function* walk(root, dir) {
  let st;
  try {
    st = statSync(join(root, dir));
  } catch {
    return;
  }
  if (st.isFile()) {
    if (EXT.test(dir)) yield dir;
    return;
  }
  for (const name of readdirSync(join(root, dir))) {
    if (name === "node_modules" || name.startsWith(".")) continue;
    yield* walk(root, join(dir, name));
  }
}

/** JSON string files: scan the values only (keys are ids). */
function textOf(file, raw) {
  if (!/\.json$/i.test(file)) return raw;
  try {
    const out = [];
    const visit = (v) => (typeof v === "string" ? out.push(v) : v && typeof v === "object" ? Object.values(v).forEach(visit) : null);
    visit(JSON.parse(raw));
    return out.join("\n");
  } catch {
    return raw;
  }
}

/** Every claim in the repo at `root`: [{file, sentence}]. Empty when an external audit is published. */
export function scanRepo(root, { audit = JSON.parse(readFileSync(join(root, "security/crypto-audit.json"), "utf8")) } = {}) {
  if (auditPublished(audit)) return [];
  const out = [];
  for (const start of SCAN) {
    for (const file of walk(root, start)) {
      const rel = relative(root, join(root, file)).split("\\").join("/");
      if (SKIP.some((r) => r.test(rel))) continue;
      for (const sentence of auditClaims(textOf(rel, readFileSync(join(root, rel), "utf8")))) out.push({ file: rel, sentence });
    }
  }
  return out;
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const found = scanRepo(process.cwd());
  if (process.argv.includes("--json")) console.log(JSON.stringify(found, null, 2));
  else if (found.length) {
    for (const f of found) console.error(`✖ ${f.file}: "${f.sentence.slice(0, 200)}"`);
    console.error(`✖ ${found.length} sentence(s) call the cryptography audited, and security/crypto-audit.json names no published external audit.`);
  } else console.log("✓ no user-facing text calls the cryptography audited (no external audit published yet)");
  process.exit(found.length ? 1 : 0);
}
