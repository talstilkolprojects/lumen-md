#!/usr/bin/env node
/**
 * Dependency audit gate (plan 2.8). Fails on any high or critical advisory
 * in the lockfile of the current directory, except for advisories listed in
 * security/audit-ignore.json for this directory and not yet expired.
 *
 *   node scripts/audit-gate.mjs           npm: `npm audit --audit-level=high`
 *   node scripts/audit-gate.mjs --cargo   Cargo.lock: `cargo audit`, failing on
 *                                         CVSS >= 7.0 or no CVSS score at all
 *
 * An exception needs an advisory id (GHSA-… for npm, RUSTSEC-… for cargo), a
 * reason and an expiry date at most 90 days from today. An expired, malformed
 * or too-distant one fails the gate, so an ignore can never become permanent
 * by being forgotten or by a far-off date.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const MAX_IGNORE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;
const ID_RE = { npm: /^GHSA-[\w-]+$/, cargo: /^RUSTSEC-\d{4}-\d{4}$/ };

/**
 * The exceptions that apply to `dir` today, and what is wrong with the rest.
 * @param {Array<Record<string, string>>} entries security/audit-ignore.json's `ignore`
 * @param {{ dir: string, ecosystem: "npm" | "cargo", today: string }} at
 * @returns {{ active: Map<string, Record<string, string>>, errors: string[] }}
 */
export function checkIgnores(entries, { dir, ecosystem, today }) {
  const active = new Map();
  const errors = [];
  const latest = new Date(Date.parse(today) + MAX_IGNORE_DAYS * DAY_MS).toISOString().slice(0, 10);
  for (const e of entries) {
    const eco = e.id?.startsWith("RUSTSEC-") ? "cargo" : "npm";
    if (!ID_RE[eco].test(e.id ?? "") || !e.reason || !/^\d{4}-\d{2}-\d{2}$/.test(e.expires ?? "") || Number.isNaN(Date.parse(e.expires))) {
      errors.push(`audit-ignore.json: entry ${JSON.stringify(e)} needs id (GHSA-… or RUSTSEC-…), reason and expires (YYYY-MM-DD)`);
    } else if (e.expires > latest) {
      errors.push(`audit-ignore.json: the exception for ${e.id} expires on ${e.expires}, more than ${MAX_IGNORE_DAYS} days out (latest allowed: ${latest})`);
    } else if (eco !== ecosystem || (e.dir ?? ".") !== dir) {
      continue;
    } else if (e.expires < today) {
      errors.push(`audit-ignore.json: the exception for ${e.id} expired on ${e.expires}; fix it or renew it with a new reason`);
    } else {
      active.set(e.id, e);
    }
  }
  return { active, errors };
}

/** The high / critical findings of an `npm audit --json` report. */
export function npmFindings(report) {
  const out = [];
  for (const [name, v] of Object.entries(report.vulnerabilities ?? {})) {
    for (const via of v.via) {
      if (typeof via !== "object" || !["high", "critical"].includes(via.severity)) continue;
      out.push({
        id: via.url?.match(/GHSA-[\w-]+/)?.[0] ?? String(via.source),
        what: `${via.severity} in ${name} ${v.range}: ${via.title} (fix: ${JSON.stringify(v.fixAvailable)})`,
      });
    }
  }
  return out;
}

/** CVSS v3 base score from a vector, or null. Only the base metrics. */
export function cvss3Score(vector) {
  const m = Object.fromEntries((vector ?? "").split("/").slice(1).map((p) => p.split(":")));
  const W = {
    AV: { N: 0.85, A: 0.62, L: 0.55, P: 0.2 },
    AC: { L: 0.77, H: 0.44 },
    UI: { N: 0.85, R: 0.62 },
    C: { H: 0.56, L: 0.22, N: 0 },
  };
  if (!/^CVSS:3\.[01]\//.test(vector ?? "") || !(m.AV in W.AV) || !(m.AC in W.AC) || !(m.UI in W.UI) || !["U", "C"].includes(m.S)) return null;
  const changed = m.S === "C";
  const pr = { N: 0.85, L: changed ? 0.68 : 0.62, H: changed ? 0.5 : 0.27 }[m.PR];
  const [c, i, a] = [W.C[m.C], W.C[m.I], W.C[m.A]];
  if (pr === undefined || [c, i, a].includes(undefined)) return null;
  const iss = 1 - (1 - c) * (1 - i) * (1 - a);
  const impact = changed ? 7.52 * (iss - 0.029) - 3.25 * (iss - 0.02) ** 15 : 6.42 * iss;
  if (impact <= 0) return 0;
  const expl = 8.22 * W.AV[m.AV] * W.AC[m.AC] * pr * W.UI[m.UI];
  const up = (x) => Math.ceil(x * 10 - 1e-9) / 10;
  return up(Math.min(changed ? 1.08 * (impact + expl) : impact + expl, 10));
}

/**
 * The high / critical findings of a `cargo audit --json` report: CVSS >= 7.0,
 * or no usable CVSS (RustSec often has none; unscored counts as high until
 * someone reads it and, if it is minor, ignores it with a reason).
 */
export function cargoFindings(report) {
  const out = [];
  for (const v of report.vulnerabilities?.list ?? []) {
    const a = v.advisory ?? {};
    const score = cvss3Score(a.cvss);
    if (score !== null && score < 7) continue;
    out.push({
      id: a.id,
      what: `${score === null ? "unscored" : `CVSS ${score}`} in ${v.package?.name} ${v.package?.version}: ${a.title} (patched: ${JSON.stringify(v.versions?.patched ?? [])})`,
    });
  }
  return out;
}

function run() {
  const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
  const dir = relative(root, process.cwd()) || ".";
  const ecosystem = process.argv.includes("--cargo") ? "cargo" : "npm";
  const today = new Date().toISOString().slice(0, 10);
  let failed = false;
  const fail = (msg) => {
    console.error(`::error::${msg}`);
    failed = true;
  };

  const { ignore } = JSON.parse(readFileSync(join(root, "security/audit-ignore.json"), "utf8"));
  const { active, errors } = checkIgnores(ignore, { dir, ecosystem, today });
  errors.forEach(fail);

  // Both tools exit non-zero when they find anything; the JSON is what counts.
  const [cmd, args] = ecosystem === "cargo" ? ["cargo", ["audit", "--json", "--file", "Cargo.lock"]] : ["npm", ["audit", "--package-lock-only", "--json"]];
  let out;
  try {
    out = execFileSync(cmd, args, { encoding: "utf8", maxBuffer: 64 << 20 });
  } catch (err) {
    out = err.stdout;
  }
  let report;
  try {
    report = JSON.parse(out);
  } catch {
    fail(`${cmd} audit in ${dir} gave no JSON report`);
    process.exit(1);
  }
  if (report.error) fail(`npm audit failed in ${dir}: ${report.error.summary ?? JSON.stringify(report.error)}`);

  const findings = ecosystem === "cargo" ? cargoFindings(report) : npmFindings(report);
  const summary =
    ecosystem === "cargo"
      ? `${report.vulnerabilities?.count ?? 0} vulnerabilities (${findings.length} high, critical or unscored), ${Object.values(report.warnings ?? {}).flat().length} warnings, ${report.lockfile?.["dependency-count"] ?? "?"} crates`
      : (({ total = 0, critical = 0, high = 0, moderate = 0, low = 0 }) => `${total} advisories: ${critical} critical, ${high} high, ${moderate} moderate, ${low} low`)(report.metadata?.vulnerabilities ?? {});
  console.log(`${cmd} audit in ${dir}: ${summary}`);
  // The counts as an annotation, readable from the API.
  if (process.env.GITHUB_ACTIONS) console.log(`::notice title=${cmd} audit (${dir})::${summary}; ${active.size} active exception(s)`);

  for (const f of findings) {
    if (active.has(f.id)) console.log(`  ignored until ${active.get(f.id).expires}: ${f.id} ${f.what}: ${active.get(f.id).reason}`);
    else fail(`${dir}: ${f.id} ${f.what}`);
  }
  process.exit(failed ? 1 : 0);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) run();
