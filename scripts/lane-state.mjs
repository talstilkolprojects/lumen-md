#!/usr/bin/env node
/**
 * Resume a lane from its STATE.md without redoing work or pushing twice (W8.10).
 *
 *   node scripts/lane-state.mjs resume <STATE.md>              one action per branch
 *   node scripts/lane-state.mjs resume <STATE.md> --no-github  git only (no PR lookup)
 *   node scripts/lane-state.mjs table <STATE.md>                the Branches table with the
 *                                                               current origin heads filled in
 *   node scripts/lane-state.mjs check <STATE.md> [--now <ISO>]  the file itself: written within the
 *                                                               hour, no sha pushed twice, bases on a train
 *   node scripts/lane-state.mjs prompt <STATE.md> --lane <X>    the resume instruction for that lane
 *
 * Reads only (git fetch of the listed branches, ls-remote, gh api GET);
 * it never pushes, merges or opens a PR. The template and the resume
 * instruction are in docs/dev/lane-state.md.
 * Exit 0: every branch is "nothing", "push" or "open-pr". Exit 1: a branch needs a person ("look"),
 * or STATE.md is stale ("record").
 */
import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { checkState, parseBranches, renderBranches, resumeAction, resumePrompt } from "./lib/lane-state.mjs";

const [cmd, file] = process.argv.slice(2);
const flag = (n) => process.argv.includes(`--${n}`);
const REPO = process.env.LUMEN_REPO ?? "talstilkol/lumen-md";

function sh(args, cwd) {
  const r = spawnSync(args[0], args.slice(1), { cwd, encoding: "utf8" });
  return r.status === 0 ? r.stdout.trim() : null;
}

function facts(row) {
  // The branch's own head, not the worktree's HEAD: a worktree may have another branch checked out (one worktree, several branches).
  const local = existsSync(row.worktree) ? (sh(["git", "rev-parse", "--verify", "-q", `refs/heads/${row.branch}`], row.worktree) ?? sh(["git", "rev-parse", "HEAD"], row.worktree)) : null;
  const cwd = local ? row.worktree : process.cwd();
  const remote = (sh(["git", "ls-remote", "origin", `refs/heads/${row.branch}`], cwd) ?? "").split(/\s+/)[0] || null;
  let ahead = null;
  let behind = null;
  if (local && remote && sh(["git", "fetch", "-q", "origin", row.branch], cwd) !== null) {
    const n = sh(["git", "rev-list", "--left-right", "--count", `${remote}...${local}`], cwd);
    if (n) [behind, ahead] = n.split(/\s+/).map(Number);
  }
  let prs = [];
  if (!flag("no-github")) {
    const out = sh(["gh", "api", `repos/${REPO}/pulls?state=all&head=${REPO.split("/")[0]}:${row.branch}`, "--jq", ".[].number"]);
    prs = (out ?? "").split("\n").filter(Boolean).map(Number);
  }
  return { local, remote, prs, ahead, behind };
}

function main() {
  if (!["resume", "table", "check", "prompt"].includes(cmd) || !file) {
    console.error("usage: node scripts/lane-state.mjs resume|table|check|prompt <STATE.md> [--no-github] [--now <ISO>] [--lane <X>]");
    return 2;
  }
  const opt = (n) => (process.argv.includes(`--${n}`) ? process.argv[process.argv.indexOf(`--${n}`) + 1] : undefined);
  if (cmd === "prompt") {
    console.log(resumePrompt({ lane: opt("lane") ?? "<X>", state: file, repo: REPO }));
    return 0;
  }
  const md = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (cmd === "check") {
    const problems = checkState(md, { now: opt("now") ? Date.parse(opt("now")) : Date.now() });
    for (const p of problems) console.log(`${p.level === "fail" ? "✗" : "!"} ${p.line}`);
    if (!problems.length) console.log(`✓ ${file}: current, no sha pushed twice, every base on main or a train`);
    return problems.some((p) => p.level === "fail") ? 1 : 0;
  }
  const rows = parseBranches(md);
  if (!rows.length) {
    console.error(`${file}: no "## Branches" table (docs/dev/lane-state.md has the template)`);
    return 2;
  }
  if (cmd === "table") {
    console.log(renderBranches(rows.map((r) => ({ ...r, pushed: (sh(["git", "ls-remote", "origin", `refs/heads/${r.branch}`]) ?? "").split(/\s+/)[0].slice(0, 10) || null }))));
    return 0;
  }
  let bad = 0;
  for (const row of rows) {
    const { action, why } = resumeAction(row, facts(row));
    if (action === "look" || action === "record") bad++;
    console.log(`${action.padEnd(8)} ${row.branch}: ${why}`);
  }
  return bad ? 1 : 0;
}

process.exitCode = main();
