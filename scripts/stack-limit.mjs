#!/usr/bin/env node
/**
 * The stack limit (plan W6.22): measure the acceptance over every open PR.
 *
 *   - 100% of the PRs opened since the rule (12.11.2026, --since) are based
 *     on main or a verify/train(-N);
 *   - the maximum stack depth is 1: no PR sits on another PR, or on a branch
 *     that is neither main nor a train;
 *   - with --drift, each of those PRs is also held to pr:check's drift
 *     rules against the current train: behind it warns, a merge base older
 *     than 7 days or a criss-cross fails (the PR's head must be fetched).
 *
 * The older PRs are counted, not judged: their deepest stack is printed, so
 * the weekly restack (scripts/restack.mjs --all) can be seen to work.
 *
 *   npm run stack:limit                          # open PRs from GitHub (REST)
 *   npm run stack:limit -- --drift --fetch       # and the drift of each new PR
 *   npm run stack:limit -- --prs open.json --json
 *
 * --prs reads the REST list (`gh api repos/<repo>/pulls?state=open`), as a
 * JSON array. Reads only. Exit 0 when every new PR keeps the rule, 1 when
 * one does not, 2 on a usage or lookup error.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { MAX_AGE_DAYS, MAX_STACK_DEPTH, RULE_SINCE, currentTrain, driftVerdicts, stackReport, worst } from "./lib/trainBase.mjs";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    prs: opt("--prs"),
    since: opt("--since") ?? RULE_SINCE,
    drift: argv.includes("--drift"),
    fetch: argv.includes("--fetch"),
    json: argv.includes("--json"),
    train: opt("--train"),
    remote: opt("--remote") ?? "origin",
    repo: opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md",
    cwd: resolve(opt("--cwd") ?? process.cwd()),
    now: opt("--now") ? Date.parse(opt("--now")) : Date.now(),
  };
}

/** The REST shape → { number, head, base, created_at, title }; forks and Dependabot are left out (they cannot be restacked here). */
export function fromRest(list) {
  return list
    .filter((p) => !String(p.user?.login ?? "").includes("dependabot") && (p.head?.repo?.full_name ?? p.base?.repo?.full_name) === p.base?.repo?.full_name)
    .map((p) => ({ number: p.number, head: p.head.ref, base: p.base.ref, created_at: p.created_at, title: p.title }));
}

/** pr:check's drift rules for one PR head against the train → [{ status, line }], or null when the head is not fetched. */
export function driftOf(git, { head, train, remote, now }) {
  const H = `${remote}/${head}`;
  const T = `${remote}/${train}`;
  try {
    git("rev-parse", "--verify", "-q", `${H}^{commit}`);
  } catch {
    return null; // why: the head is not fetched; the report says so instead of guessing
  }
  const bases = git("merge-base", "--all", H, T).split("\n").filter(Boolean);
  if (!bases.length) return [{ status: "fail", line: `No merge base with \`${train}\`.` }];
  const behind = Number(git("rev-list", "--count", `${H}..${T}`));
  const ageDays = (now / 1000 - Number(git("show", "-s", "--format=%ct", bases[0]))) / 86400;
  return driftVerdicts({ base: train, behind, ageDays, mergeBases: bases.length, maxAgeDays: MAX_AGE_DAYS });
}

/** A stack as "#1 → #2 → #3"; a long one keeps its bottom and its top three. */
export const chainText = (chain) => (chain.length > 5 ? [chain[0], "…", ...chain.slice(-3)] : chain).map((n) => (n === "…" ? n : `#${n}`)).join(" → ");

export function run(opts, { log = console.log, api, git } = {}) {
  git ??= (...a) => execFileSync("git", a, { cwd: opts.cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
  api ??= (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  let rest;
  if (opts.prs) rest = JSON.parse(readFileSync(resolve(opts.cwd, opts.prs), "utf8"));
  else {
    rest = [];
    for (let page = 1; page < 50; page++) {
      const batch = api(`repos/${opts.repo}/pulls?state=open&per_page=100&page=${page}`);
      rest.push(...batch);
      if (batch.length < 100) break;
    }
  }
  const prs = fromRest(rest);
  const report = stackReport(prs, { since: opts.since });
  const drift = [];
  if (opts.drift) {
    if (opts.fetch) git("fetch", "-q", opts.remote);
    const train = opts.train ?? currentTrain(git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${opts.remote}/verify/`).split("\n").filter(Boolean).map((r) => r.slice(opts.remote.length + 1)));
    if (!train) throw new Error(`no verify/train(-N) on ${opts.remote}: pass --train`);
    for (const p of prs.filter((x) => !opts.since || String(x.created_at ?? "") >= opts.since)) {
      const rows = driftOf(git, { head: p.head, train, remote: opts.remote, now: opts.now });
      drift.push({ number: p.number, head: p.head, status: rows ? worst(rows) : "unknown", lines: rows ? rows.map((r) => r.line) : [`\`${opts.remote}/${p.head}\` is not fetched (--fetch).`] });
    }
  }
  const driftFails = drift.filter((d) => d.status === "fail");
  const ok = report.ok && driftFails.length === 0;
  if (opts.json) log(JSON.stringify({ ...report, drift, ok }, null, 2));
  else {
    const pct = report.recent ? ((100 * report.recentOnTrain) / report.recent).toFixed(0) : "100";
    const out = [
      `Stack limit (W6.22): ${report.open} open PRs, ${report.recent} opened since ${opts.since}.`,
      `${report.recentOnTrain === report.recent ? "✓" : "✗"} ${report.recentOnTrain}/${report.recent} new PRs (${pct}%) are on main or a verify/train (target 100%).`,
      `${report.maxDepth <= MAX_STACK_DEPTH ? "✓" : "✗"} Deepest new stack: ${report.maxDepth} (limit ${MAX_STACK_DEPTH}). Older PRs, not judged: deepest ${report.legacyMaxDepth}; scripts/restack.mjs --all moves them.`,
    ];
    for (const r of report.tooDeep) out.push(`  ✗ #${r.number} ${r.head} on ${r.base}: depth ${r.depth} (${chainText(r.chain)}, from ${r.root}). Restack: node scripts/restack.mjs --pr ${r.number}`);
    if (opts.drift) {
      out.push(`${driftFails.length ? "✗" : "✓"} Drift of the new PRs against the train: ${drift.filter((d) => d.status === "ok").length} up to date, ${drift.filter((d) => d.status === "warn").length} behind, ${driftFails.length} failing, ${drift.filter((d) => d.status === "unknown").length} not fetched.`);
      for (const d of drift.filter((x) => x.status === "fail" || x.status === "warn")) out.push(`  ${d.status === "fail" ? "✗" : "!"} #${d.number} ${d.head}: ${d.lines.join(" ")}`);
    }
    log(out.join("\n"));
  }
  return { ...report, drift, ok };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exitCode = run(parseArgs(process.argv.slice(2))).ok ? 0 : 1;
  } catch (e) {
    console.error(`✗ stack-limit: ${e.message}`);
    process.exitCode = 2;
  }
}
