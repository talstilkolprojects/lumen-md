#!/usr/bin/env node
/**
 * Run what CI runs, here, in one command (plan 0.14).
 *
 *   npm run ci:local                     every step, like the `check` job + e2e on Chromium
 *   npm run ci:local -- --changed        only what the diff can break (vs the upstream or --base)
 *   npm run ci:local -- --base origin/fix/codex-backlog --changed
 *   npm run ci:local -- --skip e2e,build --only typecheck,test --coverage --bail
 *   npm run ci:local -- --install-hook   pre-push hook: `ci:local --changed --skip e2e`
 *                                         (an existing hook of yours is kept unless --force,
 *                                         which saves it as pre-push.bak)
 *
 * Steps run in order; a failure does not stop the rest unless --bail, and the
 * exit code is 1 if any step failed. --coverage applies CI's 65% lines gate
 * to the full run. e2e serves a build of this checkout (the Build step's,
 * else a fresh one: never a dist/ left from earlier) with `vite preview` on
 * a free port and runs the Chromium project; set PW_CHROMIUM to a Chromium
 * executable when Playwright's own is not installed (playwright.config.ts
 * and a lane's playwright.lane.config.ts both read it).
 */
import { spawn, spawnSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync, writeFileSync, chmodSync, mkdirSync, renameSync } from "node:fs";
import { createServer } from "node:net";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { planSteps, e2eSpecs, i18nDrift, summary, coverageGate, hookPlan, buildState, argErrors, dynamicImportTargets } from "./lib/ciLocal.mjs";

// fileURLToPath, not `.pathname`: a checkout in "lumen md/" is "lumen%20md/" in the URL.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
const argv = process.argv.slice(2);
const badArgs = argErrors(argv);
if (badArgs.length) {
  console.error(`ci:local: ${badArgs.join("; ")}\nRun with --help for the usage.`);
  process.exit(2);
}
const flag = (name) => argv.includes(`--${name}`);
const opt = (name) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 && argv[i + 1] && !argv[i + 1].startsWith("--") ? argv[i + 1] : null;
};
const list = (name) => (opt(name) ?? "").split(",").map((s) => s.trim()).filter(Boolean);

if (flag("help") || flag("h") || argv.includes("-h")) {
  console.log(readFileSync(new URL(import.meta.url)).toString().split("*/")[0]);
  process.exit(0);
}

if (flag("install-hook")) {
  const hooks = spawnSync("git", ["rev-parse", "--git-path", "hooks"], { encoding: "utf8" }).stdout.trim();
  mkdirSync(hooks, { recursive: true });
  const file = join(hooks, "pre-push");
  const plan = hookPlan(existsSync(file) ? readFileSync(file, "utf8") : null, { force: flag("force") });
  if (plan.action === "refuse") {
    console.error(`ci:local: ${file} already exists and is not ours; not replacing it. Add \`npm run -s ci:local -- --changed --skip e2e --bail\` to it yourself, or rerun with --force to save it as pre-push.bak and install ours.`);
    process.exit(1);
  }
  if (plan.action === "backup") {
    renameSync(file, `${file}.bak`);
    console.log(`existing pre-push hook saved as ${file}.bak`);
  }
  writeFileSync(file, plan.content);
  chmodSync(file, 0o755);
  console.log(`pre-push hook written to ${file}`);
  process.exit(0);
}

function git(...args) {
  const r = spawnSync("git", args, { encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

/** Files changed against the base (committed, staged and unstaged; deleted ones too), or null for a full run. */
function changedFiles() {
  if (!flag("changed")) return null;
  const base = opt("base") ?? (git("rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}") ? "@{upstream}" : "origin/main");
  const mergeBase = git("merge-base", "HEAD", base);
  if (!mergeBase) {
    console.error(`ci:local: cannot find a merge base with ${base}; pass --base <ref>`);
    process.exit(2);
  }
  // --no-renames: a moved file is its deletion plus its addition, so the old
  // path (say public/templates/x.md, still referenced by name) is planned too.
  const files = new Set([
    // New files not yet staged count too (untracked, not ignored).
    ...(git("ls-files", "--others", "--exclude-standard") ?? "").split("\n"),
    ...(git("diff", "--name-only", "--no-renames", mergeBase, "HEAD") ?? "").split("\n"),
    ...(git("diff", "--name-only", "--no-renames") ?? "").split("\n"),
    ...(git("diff", "--name-only", "--no-renames", "--cached") ?? "").split("\n"),
  ]);
  files.delete("");
  const deleted = [...files].filter((f) => !existsSync(f)).length;
  console.log(`ci:local --changed: ${files.size} files vs ${base} (${mergeBase.slice(0, 8)})${deleted ? `, ${deleted} deleted` : ""}`);
  if (flag("coverage")) console.log("ci:local: --coverage needs a full run; with --changed the 65% gate is not checked");
  return [...files];
}

function run(cmd, extraEnv = {}) {
  return new Promise((resolveRun) => {
    const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env: { ...process.env, ...extraEnv } });
    child.on("close", (code) => resolveRun(code ?? 1));
    child.on("error", () => resolveRun(1));
  });
}

function freePort() {
  return new Promise((res) => {
    const s = createServer();
    s.listen(0, () => {
      const { port } = s.address();
      s.close(() => res(port));
    });
  });
}

async function i18nDriftStep() {
  const code = await run(["node", "scripts/extract-i18n-keys.mjs", "--check"]);
  if (code !== 0) return code;
  // Per-domain layout (plan 0.3): i18n/keys/<domain>.json and src/i18n/locales/he/<domain>.json.
  const jsonIn = (dir) => readdirSync(dir).filter((n) => n.endsWith(".json")).map((n) => JSON.parse(readFileSync(`${dir}/${n}`, "utf8")));
  const en = jsonIn("i18n/keys").reduce((sum, f) => sum + f.entries.length, 0);
  const he = jsonIn("src/i18n/locales/he").reduce((sum, f) => sum + Object.keys(f).length, 0);
  const d = i18nDrift(en, he);
  console.log(`i18n keys — en: ${en}, he: ${he}, diff: ${d.diff}`);
  if (!d.ok) console.error("i18n drift > 10 keys; run `node scripts/print-missing-i18n-keys.mjs` and fix.");
  return d.ok ? 0 : 1;
}

/** Vitest, then (with --coverage) CI's lines gate on the summary it wrote. */
async function testStep(step) {
  const code = await run(step.cmd);
  if (code !== 0 || !step.coverageMin) return code;
  const file = "coverage/coverage-summary.json";
  const gate = coverageGate(existsSync(file) ? readFileSync(file, "utf8") : null, step.coverageMin);
  (gate.ok ? console.log : console.error)(gate.message);
  return gate.ok ? 0 : 1;
}

/** Budget and e2e need this run's build (buildState): build first when there is none, never reuse an old dist/. */
async function ensureBuild(step, state) {
  if (state === "fresh") return 0;
  if (state === "failed") {
    console.error(`${step}: the Build step failed; nothing to ${step === "e2e" ? "serve" : "measure"}`);
    return 1;
  }
  console.log(`${step}: building this checkout first (a dist/ from an earlier build may not match it)`);
  return run(["npm", "run", "-s", "build"]);
}

async function budgetStep(s, state) {
  const b = await ensureBuild("budget", state);
  return b !== 0 ? b : run(s.cmd);
}

async function e2eStep(changed, state) {
  const b = await ensureBuild("e2e", state);
  if (b !== 0) return b;
  const port = await freePort();
  const preview = spawn("npx", ["vite", "preview", "--port", String(port), "--strictPort"], { stdio: "ignore", detached: false });
  try {
    const url = `http://localhost:${port}`;
    for (let i = 0; i < 60; i++) {
      try {
        if ((await fetch(url)).ok) break;
      } catch {
        /* not up yet */
      }
      await new Promise((r) => setTimeout(r, 500));
    }
    const config = existsSync("playwright.lane.config.ts") ? "playwright.lane.config.ts" : "playwright.config.ts";
    const all = readdirSync("e2e").filter((f) => f.endsWith(".spec.ts")).map((f) => `e2e/${f}`);
    const specs = e2eSpecs(changed, all);
    return await run(["npx", "playwright", "test", "-c", config, "--project=chromium", ...specs], { PLAYWRIGHT_BASE_URL: url });
  } finally {
    preview.kill();
  }
}

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
const changed = changedFiles();
/** src/ sources, for the modules reached only by a dynamic import (changed mode). */
function sourcesUnder(dir) {
  const out = [];
  const walk = (d) => {
    let entries = [];
    try {
      entries = readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = `${d}/${e.name}`;
      if (e.isDirectory()) {
        if (e.name !== "node_modules" && !e.name.startsWith(".")) walk(p);
      } else if (/\.(m?[jt]sx?)$/.test(e.name)) out.push({ path: p, text: readFileSync(p, "utf8") });
    }
  };
  walk(dir);
  return out;
}
const dynamicTargets = changed === null ? undefined : dynamicImportTargets(sourcesUnder("src"));
const steps = planSteps({ pkg, exists: existsSync, changed, dynamicTargets, flags: { skip: list("skip"), only: list("only"), coverage: flag("coverage") } });
const results = [];
let failed = false;
for (const s of steps) {
  if (s.skipReason || (failed && flag("bail"))) {
    results.push({ title: s.title, status: "skip", reason: s.skipReason ?? "after a failure (--bail)" });
    continue;
  }
  console.log(`\n▶ ${s.title}`);
  const t0 = Date.now();
  const code =
    s.id === "i18n" ? await i18nDriftStep()
    : s.id === "e2e" ? await e2eStep(changed, buildState(results))
    : s.id === "budget" ? await budgetStep(s, buildState(results))
    : s.id === "test" ? await testStep(s)
    : await run(s.cmd);
  // A build made by budget or e2e serves the steps after it.
  if ((s.id === "budget" || s.id === "e2e") && code === 0 && buildState(results) === "none") results.push({ id: "build", title: "Build (for " + s.id + ")", status: "pass", hidden: true });
  const status = code === 0 ? "pass" : "fail";
  if (status === "fail") failed = true;
  results.push({ id: s.id, title: s.title, status, ms: Date.now() - t0 });
}
const shown = results.filter((r) => !r.hidden);
// A gate that ran nothing (every selected step skipped or "not here") is not a pass.
if (!failed && !shown.some((r) => r.status === "pass")) {
  console.error(`\nci:local: no step ran\n${summary(shown)}`);
  process.exit(1);
}
console.log(`\nci:local ${failed ? "FAILED" : "passed"}\n${summary(shown)}`);
process.exit(failed ? 1 : 0);
