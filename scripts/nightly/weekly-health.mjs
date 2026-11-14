#!/usr/bin/env node
/**
 * Weekly dependency health (plan 0.11): npm audit over every lockfile, cargo
 * audit over Cargo.lock (when cargo-audit is on PATH), `npm outdated` for the
 * app, and the licence check when the repo has one. Report only: the gates
 * live in the PR workflows. Writes reports/weekly-health.{json,md} and the
 * job summary.
 *
 *   node scripts/nightly/weekly-health.mjs
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { summary, table, writeReport } from "./lib.mjs";

const NPM_DIRS = [".", "sync-server", "mcp-server", "packages/create-lumen-plugin", "docs"].filter((d) => existsSync(join(d, "package-lock.json")));
const CARGO_DIRS = ["src-tauri"].filter((d) => existsSync(join(d, "Cargo.lock")));

/** Run a command; JSON from stdout even when it exits non-zero (audit / outdated do). */
function json(cmd, args, cwd) {
  const r = spawnSync(cmd, args, { cwd, encoding: "utf8", maxBuffer: 64 << 20 });
  if (r.error) return { error: String(r.error.message) };
  try {
    return JSON.parse(r.stdout || "{}");
  } catch {
    return { error: (r.stderr || r.stdout || `exit ${r.status}`).trim().split("\n").slice(-3).join(" ") };
  }
}

const npmAudit = NPM_DIRS.map((dir) => {
  const r = json("npm", ["audit", "--package-lock-only", "--json"], dir);
  const c = r.metadata?.vulnerabilities ?? {};
  const top = Object.entries(r.vulnerabilities ?? {})
    .filter(([, v]) => ["high", "critical"].includes(v.severity))
    .map(([n, v]) => `${n} (${v.severity})`);
  return { dir, error: r.error?.summary ?? (typeof r.error === "string" ? r.error : undefined), counts: c, highOrCritical: top };
});

const hasCargoAudit = spawnSync("cargo", ["audit", "--version"], { encoding: "utf8" }).status === 0;
const cargoAudit = CARGO_DIRS.map((dir) => {
  if (!hasCargoAudit) return { dir, error: "cargo-audit not installed" };
  const r = json("cargo", ["audit", "--json", "--file", "Cargo.lock"], dir);
  return {
    dir,
    error: r.error,
    vulnerabilities: (r.vulnerabilities?.list ?? []).map((v) => `${v.advisory.id} ${v.package.name} ${v.package.version}`),
    warnings: Object.entries(r.warnings ?? {}).flatMap(([kind, ws]) => ws.map((w) => `${kind}: ${w.advisory?.id ?? ""} ${w.package.name} ${w.package.version}`.replace(/\s+/g, " "))),
    crates: r.lockfile?.["dependency-count"] ?? null,
  };
});

const outdatedRaw = json("npm", ["outdated", "--json"], ".");
const outdated = outdatedRaw.error
  ? { error: outdatedRaw.error, packages: [] }
  : {
      packages: Object.entries(outdatedRaw)
        .map(([name, o]) => ({ name, current: o.current ?? "(not installed)", wanted: o.wanted, latest: o.latest, major: o.current && o.latest && o.current.split(".")[0] !== o.latest.split(".")[0] }))
        .sort((a, b) => Number(b.major) - Number(a.major) || a.name.localeCompare(b.name)),
    };

// Plan 0.10's licence gate, when this checkout has it.
const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const licenceScript = ["licenses", "licences", "license-check", "licenses:check"].find((s) => pkg.scripts?.[s]);
let licences;
if (licenceScript) {
  const r = spawnSync("npm", ["run", "-s", licenceScript], { encoding: "utf8", maxBuffer: 64 << 20 });
  licences = { script: licenceScript, ok: r.status === 0, tail: (r.stdout + r.stderr).trim().split("\n").slice(-5) };
} else {
  licences = { skipped: "no licence script on this branch (plan 0.10, #199, is not merged)" };
}

writeReport("weekly-health.json", { date: new Date().toISOString(), npmAudit, cargoAudit, outdated, licences });

const n = (c, k) => c?.[k] ?? 0;
const lines = ["## Weekly dependency health", "", "**npm audit**", "", table(["lockfile", "critical", "high", "moderate", "low", "high / critical packages"], npmAudit.map((a) => [a.dir, a.error ? `error: ${a.error}` : n(a.counts, "critical"), n(a.counts, "high"), n(a.counts, "moderate"), n(a.counts, "low"), a.highOrCritical.join(", ") || "–"]))];
lines.push("", "**cargo audit**", "", table(["lockfile", "crates", "vulnerabilities", "warnings"], cargoAudit.map((c) => [c.dir, c.crates ?? "–", c.error ? `error: ${c.error}` : c.vulnerabilities.join(", ") || "0", (c.warnings ?? []).join("; ") || "–"])));
const majors = outdated.packages.filter((p) => p.major);
lines.push("", `**npm outdated** (app): ${outdated.error ? `error: ${outdated.error}` : `${outdated.packages.length} outdated, ${majors.length} behind a major`}`);
if (outdated.packages.length) lines.push("", table(["package", "current", "wanted", "latest", "major behind"], outdated.packages.slice(0, 40).map((p) => [p.name, p.current, p.wanted, p.latest, p.major ? "yes" : ""])));
if (outdated.packages.length > 40) lines.push("", `… and ${outdated.packages.length - 40} more in weekly-health.json.`);
lines.push("", `**licences**: ${licences.skipped ? `skipped: ${licences.skipped}` : `\`npm run ${licences.script}\` ${licences.ok ? "passed" : "FAILED"}`}`);
const md = lines.join("\n") + "\n";
writeReport("weekly-health.md", md);
summary(md);
