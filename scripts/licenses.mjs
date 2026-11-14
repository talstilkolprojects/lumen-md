#!/usr/bin/env node
/**
 * Licence gate (task 0.10): npm production dependencies, the models and
 * data files in models/registry.json, and the eval datasets.
 *
 *   npm run licenses                 # table of everything that is not ok
 *   node scripts/licenses.mjs --all  # every row, ok ones included
 *   node scripts/licenses.mjs --json out.json   # report path (default reports/licenses.json)
 *
 * Fails (exit 1) on: GPL / AGPL / SSPL / BUSL / Commons Clause / Elastic /
 * CC-BY-NC / UNLICENSED / missing licences in production dependencies, a
 * known hidden-copyleft package, a `forbidden` registry model that app code
 * references, an eval/golden/<set>/ without SOURCES.md + LICENSE or whose
 * SOURCES.md declares a licence a dataset may not carry (NonCommercial,
 * NoDerivatives, ShareAlike outside a ShareAlike folder, none), or an
 * invalid registry / allowlist. Warns on LGPL, "SEE LICENSE IN", unknown
 * models. Documented exceptions live in licenses.allow.json.
 *
 * Offline: it reads package-lock.json (and node_modules/<pkg>/package.json
 * only for a licence the lock lacks). The rules are in scripts/lib/licenses.mjs.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { applyAllowlist, checkDatasets, checkModels, checkNpm, formatTable, summarize } from "./lib/licenses.mjs";

const args = process.argv.slice(2);
const flag = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? (args[i + 1] ?? "") : undefined;
};
const root = resolve(flag("--root") ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
const outPath = resolve(root, flag("--json") ?? "reports/licenses.json");
const showAll = args.includes("--all");

const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const posix = (p) => p.split(sep).join("/");

// ── npm ──
const lock = readJson(join(root, "package-lock.json"));
const readPackage = (path) => {
  const p = join(root, path, "package.json");
  try {
    return existsSync(p) ? readJson(p) : null;
  } catch {
    return null;
  }
};
const readLicenseFile = (path) => {
  const dir = join(root, path);
  try {
    const f = readdirSync(dir).find((n) => /^(licen[cs]e|copying)(\.md|\.txt)?$/i.test(n));
    return f ? readFileSync(join(dir, f), "utf8") : null;
  } catch {
    return null;
  }
};
const npmFindings = checkNpm(lock, { readPackage, readLicenseFile });

// ── models ── app code = src/, minus tests and eval harnesses.
const SKIP_DIR = new Set(["__tests__", "node_modules", "fixtures"]);
const TEST_FILE = /\.(test|spec|eval)\.[cm]?[jt]sx?$/;
function walk(dir, out = []) {
  for (const name of readdirSync(dir)) {
    const p = join(dir, name);
    const st = statSync(p);
    if (st.isDirectory()) {
      if (!SKIP_DIR.has(name)) walk(p, out);
    } else if (/\.([cm]?[jt]sx?|json)$/.test(name) && !TEST_FILE.test(name)) out.push(p);
  }
  return out;
}
const srcDir = join(root, "src");
const sources = existsSync(srcDir) ? walk(srcDir).map((p) => ({ file: posix(relative(root, p)), text: readFileSync(p, "utf8") })) : [];
const registryPath = join(root, "models", "registry.json");
let modelFindings;
try {
  modelFindings = checkModels(readJson(registryPath), sources);
} catch (e) {
  modelFindings = [{ area: "model", name: "models/registry.json", license: "", level: "fail", reason: `cannot read the registry: ${e.message}`, refs: [] }];
}

// ── datasets ──
const goldenDir = join(root, "eval", "golden");
const datasetDirs = existsSync(goldenDir)
  ? readdirSync(goldenDir)
      .filter((n) => statSync(join(goldenDir, n)).isDirectory())
      .map((name) => {
        const dir = join(goldenDir, name);
        const files = readdirSync(dir);
        const read = (f) => (files.includes(f) ? readFileSync(join(dir, f), "utf8") : undefined);
        return { name, files, sources: read("SOURCES.md"), license: read(files.find((f) => /^LICEN[CS]E(\.md|\.txt)?$/.test(f)) ?? "") };
      })
  : [];
const datasetFindings = checkDatasets(datasetDirs);

// ── allowlist ──
const allowPath = join(root, "licenses.allow.json");
let allow = { exceptions: [] };
const allowProblems = [];
if (existsSync(allowPath)) {
  try {
    allow = readJson(allowPath);
  } catch (e) {
    allowProblems.push({ area: "allowlist", name: "licenses.allow.json", license: "", level: "fail", reason: `invalid JSON: ${e.message}` });
  }
}
const findings = [...applyAllowlist([...npmFindings, ...modelFindings, ...datasetFindings], allow), ...allowProblems];
const counts = summarize(findings);

// ── output ──
const ORDER = { fail: 0, warn: 1, notice: 2, ok: 3 };
const shown = findings.filter((f) => showAll || f.level !== "ok").sort((a, b) => ORDER[a.level] - ORDER[b.level] || a.area.localeCompare(b.area) || a.name.localeCompare(b.name));

// npm rows that differ only by package name (platform builds of one binary) collapse into one.
const rows = [];
const groups = new Map();
for (const f of shown) {
  const detail = [f.reason, f.allowed ? `ALLOWLISTED: ${f.allowed}` : ""].filter(Boolean).join(" | ");
  const where = f.area === "npm" ? (f.via && f.via !== f.name ? `via ${f.via}` : "direct") : f.refs?.length ? `${f.refs[0].file}${f.refs[0].line ? ":" + f.refs[0].line : ""}${f.refs.length > 1 ? ` (+${f.refs.length - 1})` : ""}` : "";
  const key = f.area === "npm" ? `${f.level}|${f.license}|${detail}|${where}` : null;
  if (key && groups.has(key)) {
    groups.get(key).names.push(f.name);
    continue;
  }
  const row = { level: f.level.toUpperCase(), area: f.area, names: [f.name], license: f.license, where, detail };
  if (key) groups.set(key, row);
  rows.push(row);
}
for (const r of rows) r.item = r.names.length > 2 ? `${r.names[0]} (+${r.names.length - 1} like it)` : r.names.join(", ");

const npmTotal = npmFindings.length;
const models = modelFindings.filter((f) => f.class);
const byClass = (c) => models.filter((m) => m.class === c).length;
console.log(`Licence gate — ${npmTotal} production npm packages, ${models.length} registry models/data files, ${datasetDirs.length} eval datasets`);
console.log(`registry classes: allowed ${byClass("allowed")}, conditional ${byClass("conditional")}, forbidden ${byClass("forbidden")}, unknown ${byClass("unknown")}\n`);
if (rows.length) {
  console.log(
    formatTable(rows, [
      { key: "level", label: "LEVEL" },
      { key: "area", label: "AREA" },
      { key: "item", label: "ITEM", max: 48 },
      { key: "license", label: "LICENCE", max: 34 },
      { key: "where", label: "WHERE", max: 40 },
      { key: "detail", label: "DETAIL", max: 120 },
    ]),
  );
  console.log("");
}
console.log(`fail ${counts.fail} · warn ${counts.warn} · notice ${counts.notice} · ok ${counts.ok}`);

const byLicense = {};
for (const f of npmFindings) byLicense[f.license] = (byLicense[f.license] ?? 0) + 1;
mkdirSync(dirname(outPath), { recursive: true });
writeFileSync(
  outPath,
  JSON.stringify(
    {
      generatedAt: new Date().toISOString(),
      summary: counts,
      npm: { total: npmTotal, byLicense, findings: npmFindings.filter((f) => f.level !== "ok" || f.allowed) },
      models: modelFindings,
      datasets: datasetFindings,
      allowlist: findings.filter((f) => f.area === "allowlist"),
      failures: findings.filter((f) => f.level === "fail"),
    },
    null,
    2,
  ) + "\n",
);
console.log(`report: ${posix(relative(process.cwd(), outPath)) || outPath}`);
process.exit(counts.fail ? 1 : 0);
