#!/usr/bin/env node
/**
 * `npm run train:build` (plan W6.42): build an integration train, the
 * procedure lanes T and T2 ran by hand for trains 1 and 2, as one command.
 *
 *   npm run train:build -- --train verify/train-3 --onto origin/verify/train-2 --prs 464-494 --max 31
 *   npm run train:build -- --train verify/train-4 --onto origin/verify/train-3 --from-api      (the weekly train)
 *   npm run train:build -- --continue                                                           (after a MANUAL stop)
 *   npm run train:build -- … --dry-run                                                          (print the queue only)
 *
 * In the current checkout (a worktree of its own): switch to --train,
 * creating it at --onto when it doesn't exist. Then merge each PR in
 * ascending number with `git merge --no-ff` and the subject
 * "Merge #N branch [skip ci]". A PR already in the train is skipped.
 * On a conflict, scripts/train/resolve.mjs runs, then scripts/train/check.mjs
 * on the TypeScript it touched. When either needs a person, the merge is
 * left in progress with the MANUAL lines printed. Fix the files, then
 * `--continue`. Each merge commit carries a `Train-Resolution:` trailer
 * (clean, auto or manual, with the files), which is the ledger
 * `npm run train:status` counts.
 *
 * The queue comes from:
 *   --prs 464-494,497   numbers; branches from the GitHub REST API
 *   --list <file>       lines "number branch"
 *   --from-api          every open PR whose base is --onto's branch or main, oldest first
 * PRs listed in --exclude are skipped (#109, the old domain PR, always is).
 * A weekly train holds at most 15 PRs (--max raises it for a catch-up train).
 *
 * It never pushes. Push the train once, when it is complete
 * (docs: contributing/train).
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { checkFiles } from "./check.mjs";
import { mergeSubject, trailerLine } from "./lib.mjs";
import { resolveConflicts } from "./resolve.mjs";
import { loadTs } from "./ts.mjs";

/** PRs never merged into a train: #109 carries the old domain. */
export const NEVER = [109];
export const WEEKLY_MAX = 15;

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    train: opt("--train"),
    onto: opt("--onto"),
    prs: opt("--prs"),
    list: opt("--list"),
    fromApi: argv.includes("--from-api"),
    exclude: (opt("--exclude") ?? "").split(",").filter(Boolean).map(Number),
    max: opt("--max") ? Number(opt("--max")) : WEEKLY_MAX,
    continue: argv.includes("--continue"),
    dryRun: argv.includes("--dry-run"),
    remote: opt("--remote") ?? "origin",
    repo: opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md",
    cwd: resolve(opt("--cwd") ?? process.cwd()),
  };
}

/** "464-470,497" → [464, …, 470, 497]. */
export function parseRange(spec) {
  const out = [];
  for (const part of String(spec).split(",").filter(Boolean)) {
    const m = /^(\d+)(?:-(\d+))?$/.exec(part.trim());
    if (!m) throw new Error(`not a PR number or range: ${part}`);
    const a = Number(m[1]);
    const b = Number(m[2] ?? m[1]);
    for (let n = Math.min(a, b); n <= Math.max(a, b); n++) out.push(n);
  }
  return out;
}

/** The queue: unique, ascending, minus the excluded and the never-merged. */
export function queueOf(items, exclude = []) {
  const skip = new Set([...NEVER, ...exclude]);
  const seen = new Set();
  return items
    .filter((x) => !skip.has(x.number) && !seen.has(x.number) && seen.add(x.number))
    .sort((a, b) => a.number - b.number);
}

const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 1 << 28, stdio: ["ignore", "pipe", "pipe"] }).trim();
const tryGit = (git, ...a) => {
  try {
    return git(...a);
  } catch {
    return null; // why: the caller treats a failed probe (missing ref, not an ancestor) as "no"
  }
};
const ghApi = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 1 << 28 }));

/** Where --continue finds the run: inside the git dir, so it never gets committed. */
const statePath = (git) => resolve(git("rev-parse", "--absolute-git-dir"), "lumen-train.json");

// Merge commits carry PRs that were already checked: no pre-commit hooks on them.
// The identity is the caller's own git config (or GIT_AUTHOR_* / GIT_COMMITTER_*).
const COMMIT = ["-c", "core.hooksPath=/dev/null"];

/** The queue from --prs, --list or --from-api → [{ number, branch }]. */
export function loadQueue(opts, api = ghApi) {
  if (opts.list) {
    return readFileSync(resolve(opts.cwd, opts.list), "utf8")
      .split("\n")
      .map((l) => l.trim().split(/\s+/))
      .filter((p) => /^\d+$/.test(p[0] ?? "") && p[1])
      .map(([n, b]) => ({ number: Number(n), branch: b }));
  }
  if (opts.prs) return parseRange(opts.prs).map((n) => ({ number: n, branch: api(`repos/${opts.repo}/pulls/${n}`).head.ref }));
  if (opts.fromApi) {
    const bases = new Set([opts.onto.replace(new RegExp(`^${opts.remote}/`), ""), "main"]);
    const all = [];
    for (let page = 1; page < 50; page++) {
      const batch = api(`repos/${opts.repo}/pulls?state=open&sort=created&direction=asc&per_page=100&page=${page}`);
      all.push(...batch);
      if (batch.length < 100) break;
    }
    return all.filter((p) => bases.has(p.base.ref) && !String(p.user?.login ?? "").includes("dependabot") && !p.draft).map((p) => ({ number: p.number, branch: p.head.ref }));
  }
  throw new Error("pass --prs <range>, --list <file> or --from-api");
}

/** Merge each PR of `queue` from index `from`. → { stopped: item | null, log: [{ number, branch, result }] } */
export function mergeQueue({ git, cwd, remote, queue, from = 0, ts, out = console.log, log = [] }) {
  for (let i = from; i < queue.length; i++) {
    const { number, branch } = queue[i];
    const dirty = git("status", "--porcelain", "--untracked-files=no");
    if (dirty) throw new Error(`the tree is dirty before #${number}:\n${dirty}`);
    const ref = `${remote}/${branch}`;
    if (tryGit(git, "rev-parse", "--verify", "-q", `${ref}^{commit}`) === null) tryGit(git, "fetch", "-q", remote, `${branch}:refs/remotes/${remote}/${branch}`);
    if (tryGit(git, "rev-parse", "--verify", "-q", `${ref}^{commit}`) === null) {
      log.push({ number, branch, result: "missing" });
      out(`? #${number} ${branch}: not on ${remote}, skipped`);
      continue;
    }
    if (tryGit(git, "merge-base", "--is-ancestor", ref, "HEAD") !== null) {
      log.push({ number, branch, result: "skip" });
      out(`= #${number} ${branch}: already in the train`);
      continue;
    }
    const subject = mergeSubject(number, branch);
    const m = spawnSync("git", [...COMMIT, "merge", "-q", "--no-ff", "--no-edit", "-m", subject, "-m", trailerLine("clean"), ref], { cwd, encoding: "utf8" });
    if (m.status === 0) {
      log.push({ number, branch, result: "clean" });
      out(`✓ #${number} ${branch}`);
      continue;
    }
    if (!existsSync(resolve(git("rev-parse", "--absolute-git-dir"), "MERGE_HEAD"))) throw new Error(`git merge of #${number} failed without a conflict:\n${m.stderr}`);
    const files = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    const r = resolveConflicts(cwd, ts);
    for (const l of r.lines) out(`    ${l}`);
    const checked = r.ok ? checkStaged(git, ts) : { bad: 0, lines: [] };
    if (!r.ok || checked.bad) {
      for (const l of checked.lines.filter((x) => !x.startsWith("checked "))) out(`    ${l}`);
      return { stopped: { index: i, number, branch, files }, log };
    }
    commitMerge(git, cwd, subject, trailerLine("auto", files));
    log.push({ number, branch, result: "auto", files });
    out(`✓ #${number} ${branch} (resolved: ${files.join(", ")})`);
  }
  return { stopped: null, log };
}

/** check.mjs on the TypeScript a merge staged (tests aside). */
function checkStaged(git, ts) {
  if (!ts) return { bad: 0, lines: ["(no TypeScript: check skipped)"] };
  const files = git("diff", "--cached", "--name-only", "--diff-filter=AM").split("\n").filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__"));
  return files.length ? checkFiles(ts, files, git("rev-parse", "--show-toplevel")) : { bad: 0, lines: [] };
}

function commitMerge(git, cwd, subject, trailer) {
  const r = spawnSync("git", [...COMMIT, "commit", "-q", "--no-edit", "-m", subject, "-m", trailer], { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`commit failed: ${r.stderr || r.stdout}`);
}

const summary = (log) => {
  const c = { clean: 0, auto: 0, manual: 0, skip: 0, missing: 0 };
  for (const x of log) c[x.result]++;
  return `${c.clean + c.auto + c.manual} merged (${c.clean} clean, ${c.auto} by the resolver, ${c.manual} by hand), ${c.skip} already in, ${c.missing} missing. Hand resolutions: ${c.manual} (weekly target ≤ 10).`;
};

export function run(opts, out = console.log, api = ghApi) {
  const git = gitIn(opts.cwd);
  const ts = loadTs(process.env, opts.cwd);
  const sp = statePath(git);
  let state;
  if (opts.continue) {
    if (!existsSync(sp)) throw new Error("no train run to continue");
    state = JSON.parse(readFileSync(sp, "utf8"));
    const s = state.stopped;
    const left = git("diff", "--name-only", "--diff-filter=U").split("\n").filter(Boolean);
    if (left.length) throw new Error(`still unmerged: ${left.join(", ")}`);
    // Generated keys follow the hand-merged sources.
    if (existsSync(resolve(opts.cwd, "scripts/extract-i18n-keys.mjs"))) {
      spawnSync(process.execPath, ["scripts/extract-i18n-keys.mjs"], { cwd: opts.cwd, stdio: "ignore" });
      tryGit(git, "add", "-A", "--", "i18n");
    }
    const checked = checkStaged(git, ts);
    if (checked.bad) {
      for (const l of checked.lines) out(`    ${l}`);
      throw new Error("the check fails: fix the files, then --continue again");
    }
    commitMerge(git, opts.cwd, mergeSubject(s.number, s.branch), trailerLine("manual", s.files));
    state.log.push({ number: s.number, branch: s.branch, result: "manual", files: s.files });
    out(`✓ #${s.number} ${s.branch} (by hand: ${s.files.join(", ")})`);
    state.from = s.index + 1;
  } else {
    if (!opts.train || !opts.onto) throw new Error("pass --train <branch> and --onto <ref>");
    const queue = queueOf(loadQueue(opts, api), opts.exclude);
    if (queue.length > opts.max) throw new Error(`${queue.length} PRs is more than ${opts.max} (a weekly train holds ≤ ${WEEKLY_MAX}); pass --max ${queue.length} for a catch-up train`);
    out(`Train ${opts.train} onto ${opts.onto}: ${queue.length} PRs (${queue.map((q) => `#${q.number}`).join(" ")})`);
    if (opts.dryRun) return { stopped: null, log: [], queue };
    const current = git("rev-parse", "--abbrev-ref", "HEAD");
    if (current !== opts.train) {
      if (tryGit(git, "rev-parse", "--verify", "-q", `refs/heads/${opts.train}`) !== null) git("switch", "-q", opts.train);
      else git("switch", "-q", "-c", opts.train, opts.onto);
    }
    state = { train: opts.train, onto: opts.onto, remote: opts.remote, queue, from: 0, log: [] };
  }
  const r = mergeQueue({ git, cwd: opts.cwd, remote: state.remote, queue: state.queue, from: state.from, ts, out, log: state.log });
  if (r.stopped) {
    writeFileSync(sp, JSON.stringify({ ...state, stopped: r.stopped, log: r.log }, null, 2));
    out(`\nSTOP at #${r.stopped.number} ${r.stopped.branch}: resolve the MANUAL files by meaning (git checkout --conflict=diff3 <file> restores the markers), git add them, then: npm run train:build -- --continue`);
    return { stopped: r.stopped, log: r.log, queue: state.queue };
  }
  rmSync(sp, { force: true });
  out(`\nDone: ${summary(r.log)}\nNext: npm run train:status, then push ${state.train} once.`);
  return { stopped: null, log: r.log, queue: state.queue };
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    const r = run(parseArgs(process.argv.slice(2)));
    process.exit(r.stopped ? 1 : 0);
  } catch (e) {
    console.error(`✗ train:build: ${e.message}`);
    process.exit(2);
  }
}
