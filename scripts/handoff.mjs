#!/usr/bin/env node
/**
 * Write docs/dev/HANDOFF.md: everything the next agent (or person) needs to
 * pick the work up — open PRs as a stack with CI and unanswered review
 * comments, worktrees, the current task and the next step (plan 0.13).
 *
 *   npm run handoff -- --task "4.5 [[ autocomplete" --next "push and open the PR"
 *   npm run handoff -- --stdout          print instead of writing the file
 *   npm run handoff -- --no-github       local data only (no gh calls)
 *
 * Needs `gh` signed in for the PR part. Exits 1 when a branch or worktree it
 * names does not exist, after writing the file (the problems are listed in it).
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { missingRefs, parseWorktrees, renderHandoff } from "./lib/handoff.mjs";

// fileURLToPath, not `.pathname`: a checkout in "lumen md/" is "lumen%20md/" in the URL.
const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
process.chdir(root);
const argv = process.argv.slice(2);
const opt = (n) => {
  const i = argv.indexOf(`--${n}`);
  return i >= 0 ? argv[i + 1] ?? "" : null;
};
const flag = (n) => argv.includes(`--${n}`);

function sh(cmd, args) {
  const r = spawnSync(cmd, args, { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
  if (r.status !== 0) throw new Error(`${cmd} ${args.join(" ")}: ${(r.stderr || "").trim().slice(0, 300)}`);
  return r.stdout;
}
/**
 * Every item of an array endpoint, page by page on the same repos/… path
 * until a short page. Not `gh api --paginate`: it follows the Link header's
 * repositories/<id>/… URLs, which some API proxies refuse (scripts/ci-doctor.mjs does the same).
 */
function ghJson(path, perPage = 100, maxPages = 1000) {
  const out = [];
  for (let page = 1; page <= maxPages; page++) {
    const items = JSON.parse(sh("gh", ["api", `${path}${path.includes("?") ? "&" : "?"}page=${page}`]));
    if (!Array.isArray(items)) throw new Error(`${path}: expected an array`);
    out.push(...items);
    if (items.length < perPage) return out;
  }
  // Never a silently short list presented as complete (W1.32, Codex on #211).
  throw new Error(`${path}: more than ${maxPages} pages; the count would be incomplete`);
}

/** The newest CI run of a head branch: the CI workflow's own runs, not the newest ten of every workflow. */
function ciRuns(head) {
  const branch = encodeURIComponent(head);
  try {
    return JSON.parse(sh("gh", ["api", `repos/${repo}/actions/workflows/ci.yml/runs?branch=${branch}&per_page=30`])).workflow_runs ?? [];
  } catch {
    // No ci.yml (renamed?): every workflow's runs, as many as one page holds.
    return JSON.parse(sh("gh", ["api", `repos/${repo}/actions/runs?branch=${branch}&per_page=100`])).workflow_runs ?? [];
  }
}

function repoName() {
  const url = sh("git", ["remote", "get-url", "origin"]).trim();
  const m = /github\.com[:/](.+?)(\.git)?$/.exec(url) ?? /\/git\/([^/]+\/[^/]+?)(\.git)?$/.exec(url);
  return m ? m[1] : url;
}

const repo = repoName();
const worktrees = parseWorktrees(sh("git", ["worktree", "list", "--porcelain"]));
// A locked worktree whose directory is gone (an unmounted disk) is "locked", not "prunable".
for (const w of worktrees) if (!w.prunable && !existsSync(w.path)) w.prunable = w.locked ? "locked, and its directory is missing" : "its directory is missing";
const branches = sh("git", ["for-each-ref", "--format=%(refname)", "refs/heads", "refs/remotes/origin"])
  .split("\n")
  .filter(Boolean)
  .map((r) => r.replace(/^refs\/heads\//, "").replace(/^refs\/remotes\/origin\//, ""));

let prs = [];
if (!flag("no-github")) {
  // headRepo: a fork's head is a branch of the fork (null when the fork was deleted).
  prs = ghJson(`repos/${repo}/pulls?state=open&per_page=100`).map((p) => ({ number: p.number, title: p.title, head: p.head.ref, headRepo: p.head.repo?.full_name ?? null, base: p.base.ref }));
  for (const p of prs) {
    try {
      // Other workflows (Tauri runs on every label event) would push the CI run out of a short list.
      const runs = ciRuns(p.head);
      // A same-named branch of this repository is not a fork PR's head.
      const ci = runs.find((r) => r.name === "CI" && (r.head_repository?.full_name ?? repo) === (p.headRepo ?? repo));
      p.ci = ci ? (ci.status === "completed" ? ci.conclusion : null) : undefined;
      p.ciSha = ci?.head_sha?.slice(0, 8);
      const comments = ghJson(`repos/${repo}/pulls/${p.number}/comments?per_page=100`);
      const replied = new Set(comments.map((c) => c.in_reply_to_id).filter(Boolean));
      p.unanswered = comments.filter((c) => !c.in_reply_to_id && !replied.has(c.id)).length;
    } catch (e) {
      p.ci = undefined;
      p.unanswered = undefined;
      console.error(`handoff: PR #${p.number}: ${e.message}`);
    }
  }
}

const problems = missingRefs({ prs, worktrees, branches, repo });
const md = renderHandoff({
  now: new Date().toISOString().replace(/\.\d+Z$/, "Z"),
  repo,
  task: opt("task"),
  next: opt("next"),
  prs,
  worktrees,
  problems,
});
if (flag("stdout")) process.stdout.write(md);
else {
  const file = resolve(root, "docs/dev/HANDOFF.md");
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, md);
  console.log(`handoff: wrote docs/dev/HANDOFF.md (${prs.length} PRs, ${worktrees.length} worktrees${problems.length ? `, ${problems.length} problems` : ""})`);
}
// exitCode, not an immediate exit: on a pipe that is asynchronous (macOS, Windows) exiting
// at once can cut a long --stdout document short.
process.exitCode = problems.length ? 1 : 0;
