#!/usr/bin/env node
/**
 * Restack onto the train head (plan W6.22): print the commands that move a
 * stacked pull request off its feature-branch base and onto the current
 * train. A dry run. It reads git and the GitHub REST API and changes
 * nothing; you run the commands it prints.
 *
 *   node scripts/restack.mjs --branch <head> --base <old base> [--train verify/train-2] [--fetch]
 *   node scripts/restack.mjs --pr <number> [--fetch]
 *   node scripts/restack.mjs --all [--prs open-prs.json]       (every open PR not on the train or main, parents first)
 *
 * The plan replays only the branch's own commits (old base..branch) onto
 * the train, into a new branch restack/<head>: no force-push, and no PR's
 * base changes. The new branch gets a PR that supersedes the old one.
 * A branch whose old base is not in the train yet is reported as blocked:
 * restack the base first. The current train is the highest-numbered
 * verify/train(-N) on the remote, unless --train names one.
 * See docs/src/content/docs/contributing/train-base.md.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { buildForest, flatten } from "./lib/stack.mjs";
import { TRUNKS, currentTrain, restackCommands } from "./lib/trainBase.mjs";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    branch: opt("--branch"),
    base: opt("--base"),
    pr: opt("--pr") ? Number(opt("--pr")) : null,
    all: argv.includes("--all"),
    prs: opt("--prs"),
    train: opt("--train"),
    remote: opt("--remote") ?? "origin",
    repo: opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md",
    fetch: argv.includes("--fetch"),
    cwd: resolve(opt("--cwd") ?? process.cwd()),
  };
}

const gitIn = (cwd) => (...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));

/** The current train on `remote`: the highest verify/train(-N) it has. */
export function trainOf(git, remote) {
  const refs = git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}/verify/`).split("\n").filter(Boolean);
  return currentTrain(refs.map((r) => r.slice(remote.length + 1)));
}

const has = (git, ref) => {
  try {
    git("rev-parse", "--verify", "-q", `${ref}^{commit}`);
    return true;
  } catch {
    return false; // why: the ref isn't fetched; the caller says so
  }
};

/** What git knows about one branch → the input of restackCommands, or { missing }. */
export function inspect(git, { branch, oldBase, train, remote }) {
  const R = (b) => `${remote}/${b}`;
  const missing = [train, oldBase, branch].filter((b) => !has(git, R(b)));
  if (missing.length) return { missing };
  let parentInTrain = false;
  try {
    git("merge-base", "--is-ancestor", R(oldBase), R(train));
    parentInTrain = true;
  } catch {
    // why: not an ancestor; the base may still be in the train by patch (a train merges, it may also have ported)
    const unmerged = git("cherry", R(train), R(oldBase)).split("\n").filter((l) => l.startsWith("+"));
    parentInTrain = unmerged.length === 0;
  }
  const ownCommits = Number(git("rev-list", "--count", `${R(oldBase)}..${R(branch)}`));
  const merges = Number(git("rev-list", "--count", "--merges", `${R(oldBase)}..${R(branch)}`));
  const alreadyInTrain = git("cherry", R(train), R(branch), R(oldBase)).split("\n").filter((l) => l.startsWith("-")).length;
  return { parentInTrain, ownCommits, merges, alreadyInTrain };
}

/** The plan for one branch, as printable lines. */
export function planLines(git, { branch, oldBase, train, remote, pr }) {
  const head = `${pr ? `#${pr} ` : ""}${branch} (base ${oldBase}) → ${train}`;
  if (oldBase === train || TRUNKS.includes(oldBase)) return [`✓ ${head}: already on ${oldBase === train ? "the train" : "the trunk"}, nothing to do.`];
  const facts = inspect(git, { branch, oldBase, train, remote });
  if (facts.missing) return [`? ${head}: not fetched: ${facts.missing.map((b) => `${remote}/${b}`).join(", ")}. Run with --fetch, or:`, `    git fetch ${remote} ${facts.missing.join(" ")}`];
  const plan = restackCommands({ branch, oldBase, train, remote, pr, ...facts });
  if (plan.blocked) return [`✗ ${head}: blocked.`, ...plan.notes.map((n) => `    ${n}`)];
  return [`→ ${head}: into ${plan.target}.`, ...plan.notes.map((n) => `    ${n}`), ...plan.commands.map((c) => `    ${c}`)];
}

export function run(opts, log = console.log, api = gh) {
  const git = gitIn(opts.cwd);
  if (opts.fetch) git("fetch", "-q", opts.remote);
  const train = opts.train ?? trainOf(git, opts.remote);
  if (!train) throw new Error(`no verify/train(-N) branch on ${opts.remote}: pass --train`);
  const out = [`Restack onto ${train} (dry run: nothing is changed).`, ""];
  let targets = [];
  if (opts.all) {
    let prs = [];
    if (opts.prs) prs = JSON.parse(readFileSync(resolve(opts.cwd, opts.prs), "utf8"));
    else
      for (let page = 1; page < 50; page++) {
        const batch = api(`repos/${opts.repo}/pulls?state=open&per_page=100&page=${page}`);
        prs.push(...batch);
        if (batch.length < 100) break;
      }
    // Parents first, so each base is restacked before what sits on it.
    const forest = buildForest(prs.filter((p) => !String(p.user?.login ?? "").includes("dependabot")));
    for (const root of forest.roots) for (const { node: n } of flatten(root)) if (n.base !== train && !TRUNKS.includes(n.base) && n.sameRepo) targets.push({ branch: n.head, oldBase: n.base, pr: n.number });
  } else if (opts.pr) {
    const p = api(`repos/${opts.repo}/pulls/${opts.pr}`);
    targets = [{ branch: p.head.ref, oldBase: p.base.ref, pr: p.number }];
  } else if (opts.branch && opts.base) targets = [{ branch: opts.branch, oldBase: opts.base, pr: null }];
  else throw new Error("pass --branch <head> --base <old base>, --pr <n>, or --all");
  const counts = { move: 0, blocked: 0, ok: 0, missing: 0 };
  for (const t of targets) {
    const lines = planLines(git, { ...t, train, remote: opts.remote });
    counts[{ "→": "move", "✗": "blocked", "✓": "ok", "?": "missing" }[lines[0][0]]]++;
    out.push(...lines, "");
  }
  out.push(`${targets.length} PR${targets.length === 1 ? "" : "s"}: ${counts.move} to restack, ${counts.blocked} blocked on their base, ${counts.ok} already on the train or main, ${counts.missing} not fetched.`);
  log(out.join("\n"));
  return counts;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    run(parseArgs(process.argv.slice(2)));
  } catch (e) {
    console.error(`✗ restack: ${e.message}`);
    process.exit(2);
  }
}
