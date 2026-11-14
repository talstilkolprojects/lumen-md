#!/usr/bin/env node
/**
 * `npm run budget:ratchet` (plan W6.26): after each train, lower the budgets
 * to what the train measured plus a small margin. They never go up.
 *
 *   npm run budget:ratchet -- --sizes reports/bundle-sizes.json [--perf perf-gate.json] [--first-party startup.log] [--train train-3 --sha <sha>] [--write]
 *   npm run budget:ratchet -- --sizes-log vercel-build.log …   (the `bundle-sizes:` line of a build log)
 *   npm run budget:history [-- --since <ref> | --since all]     (every commit of the budget files since the ratchet began: 0 raises)
 *
 * --sizes is the budget gate's receipt (`bundle-budget.mjs --json`, which
 * scripts/vercel-build.mjs writes to reports/bundle-sizes.json and prints as
 * a `bundle-sizes: {…}` line). --perf is `perf-gate.mjs --json` (FCP and LCP
 * of plan 8.3). --first-party is the offline startup measure's log
 * ("startup first-party: … KB gz"); it is recorded in the history, since the
 * Vite build can't split first-party from package bytes.
 *
 * Without --write it prints what would change and writes nothing.
 * Exit 1 when --history finds a raise.
 */
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { BUDGETS_PATH, PERF_CONFIG_PATH, RATCHET_FILES, measuredFromSizes, parseFirstParty, raiseLine, raisesFor, ratchet, ratchetPerf, validateBudgets } from "./lib/budgetRatchet.mjs";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    sizes: opt("--sizes"),
    sizesLog: opt("--sizes-log"),
    perf: opt("--perf"),
    firstParty: opt("--first-party"),
    train: opt("--train"),
    sha: opt("--sha"),
    date: opt("--date") ?? new Date().toISOString().slice(0, 10),
    write: argv.includes("--write"),
    history: argv.includes("--history"),
    since: opt("--since"),
    cwd: resolve(opt("--cwd") ?? process.cwd()),
  };
}

/** The last `bundle-sizes: {…}` record in a build log. */
export function sizesFromLog(text) {
  const lines = String(text).split("\n").filter((l) => l.includes("bundle-sizes: {"));
  if (!lines.length) throw new Error("no `bundle-sizes:` line in the log (a build before W6.26?)");
  return JSON.parse(lines.at(-1).slice(lines.at(-1).indexOf("{")));
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/**
 * Every commit that changed a ratchet file, oldest first, checked against
 * its parent → { commits, raises: [{ sha, subject, path, line }] }.
 */
export function checkHistory(cwd, since) {
  const raises = [];
  let commits = 0;
  for (const path of RATCHET_FILES) {
    const range = since && since !== "all" ? [`${since}..HEAD`] : ["HEAD"];
    const shas = git(cwd, "log", "--reverse", "--format=%H%x09%s", ...range, "--", path).split("\n").filter(Boolean);
    for (const row of shas) {
      const [sha, subject] = row.split("\t");
      commits++;
      let before = null;
      try {
        before = git(cwd, "show", `${sha}^:${path}`);
      } catch {
        continue; // why: the commit adds the file (or is a root commit): nothing to raise from
      }
      let after;
      try {
        after = git(cwd, "show", `${sha}:${path}`);
      } catch {
        raises.push({ sha, subject, path, line: `- \`${path}\` was deleted` });
        continue;
      }
      for (const x of raisesFor(path, before, after)) raises.push({ sha, subject, path, line: raiseLine(path, x) });
    }
  }
  return { commits, raises };
}

/** The parent of the commit that added bundle-budgets.json (the ratchet's start), or null (root commit / not found). */
export function ratchetStart(cwd) {
  const added = git(cwd, "log", "--diff-filter=A", "--format=%H", "HEAD", "--", BUDGETS_PATH).split("\n").filter(Boolean).at(-1);
  if (!added) return null;
  try {
    return git(cwd, "rev-parse", "--verify", "-q", `${added}^`).trim();
  } catch {
    return null; // why: the file came with the root commit, so the whole history is the ratchet's
  }
}

export function run(opts, log = console.log) {
  if (opts.history) {
    // From the commit that started the ratchet (the one adding bundle-budgets.json), unless --since says otherwise.
    const since = opts.since ?? ratchetStart(opts.cwd);
    const r = checkHistory(opts.cwd, since);
    log(`budget history since ${since === "all" ? "the first commit" : since ? `${since.slice(0, 9)} (the ratchet's start)` : "the first commit"}:`);
    if (r.raises.length) {
      log(`✗ budget history: ${r.raises.length} raise${r.raises.length === 1 ? "" : "s"} in ${r.commits} commits of ${RATCHET_FILES.join(", ")}:`);
      for (const x of r.raises) log(`  ${x.sha.slice(0, 9)} ${x.subject}\n    ${x.line}`);
    } else log(`✓ budget history: ${r.commits} commits of ${RATCHET_FILES.join(", ")}, 0 raises.`);
    return r.raises.length ? 1 : 0;
  }
  const budgetsFile = join(opts.cwd, BUDGETS_PATH);
  const budgets = JSON.parse(readFileSync(budgetsFile, "utf8"));
  const shape = validateBudgets(budgets);
  if (shape.length) throw new Error(`${BUDGETS_PATH}: ${shape.join("; ")}`);
  if (!opts.sizes && !opts.sizesLog && !opts.perf) throw new Error("pass --sizes <bundle-sizes.json>, --sizes-log <build log> or --perf <perf-gate.json>");
  const lines = [];
  let changed = 0;
  if (opts.sizes || opts.sizesLog) {
    const sizes = opts.sizes ? JSON.parse(readFileSync(resolve(opts.cwd, opts.sizes), "utf8")) : sizesFromLog(readFileSync(resolve(opts.cwd, opts.sizesLog), "utf8"));
    const measured = measuredFromSizes(sizes);
    if (measured.startupKb == null && !Object.keys(measured.rules).length) throw new Error("the sizes record has no per-file maxima: it comes from a bundle-budget.mjs before W6.26");
    let firstPartyKb = null;
    if (opts.firstParty) firstPartyKb = /^[\d.]+$/.test(opts.firstParty) ? Number(opts.firstParty) : parseFirstParty(readFileSync(resolve(opts.cwd, opts.firstParty), "utf8"));
    const entry = { date: opts.date, ...(opts.train ? { train: opts.train } : {}), ...(opts.sha ? { sha: opts.sha } : {}), startupKb: measured.startupKb, ...(firstPartyKb != null ? { firstPartyKb } : {}) };
    const r = ratchet(budgets, measured, entry);
    changed += r.changes.length;
    lines.push(`Bundle budgets (${BUDGETS_PATH}), margin ${budgets.margin?.pct ?? 2}% / at least ${budgets.margin?.minKb ?? 1} KB:`);
    for (const c of r.changes) lines.push(`  ↓ ${c.name}: ${c.before} → ${c.after} KB (measured ${c.measured} KB)`);
    if (!r.changes.length) lines.push("  nothing to lower: every budget is already within measured + margin");
    if (r.unmeasured.length) lines.push(`  not in this build (unchanged): ${r.unmeasured.join(", ")}`);
    if (firstPartyKb != null) lines.push(`  first-party startup (offline measure): ${firstPartyKb} KB, recorded in history`);
    if (opts.write && r.changes.length) writeFileSync(budgetsFile, JSON.stringify(r.budgets, null, 2) + "\n");
  }
  if (opts.perf) {
    const cfgFile = join(opts.cwd, PERF_CONFIG_PATH);
    const cfg = JSON.parse(readFileSync(cfgFile, "utf8"));
    const report = JSON.parse(readFileSync(resolve(opts.cwd, opts.perf), "utf8"));
    const r = ratchetPerf(cfg, report);
    changed += r.changes.length;
    lines.push(`Performance gate (${PERF_CONFIG_PATH}), FCP and LCP, margin 2% / at least 50 ms:`);
    for (const c of r.changes) lines.push(`  ↓ ${c.name}: ${c.before} → ${c.after} ms (median run ${c.measured} ms)`);
    if (!r.changes.length) lines.push("  nothing to lower");
    if (opts.write && r.changes.length) writeFileSync(cfgFile, JSON.stringify(r.config, null, 2) + "\n");
  }
  lines.push(changed ? (opts.write ? `✓ lowered ${changed} limit${changed === 1 ? "" : "s"}; commit the files.` : `${changed} limit${changed === 1 ? "" : "s"} would go down: rerun with --write.`) : "✓ nothing to lower.");
  log(lines.join("\n"));
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(run(parseArgs(process.argv.slice(2))));
  } catch (e) {
    console.error(`✗ budget:ratchet: ${e.message}`);
    process.exit(2);
  }
}
