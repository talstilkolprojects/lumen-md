#!/usr/bin/env node
/**
 * Stacked pull requests: list the chains of open PRs with the CI state of
 * each head, and restack the branches above one that changed.
 *
 *   node scripts/stack.mjs list [<branch>|#<pr>] [--no-ci] [--workflow ci.yml]
 *   node scripts/stack.mjs restack <branch> [--dry-run] [--push] [--remote origin] [--old-base <sha>]
 *
 * Common flags: --repo owner/name (default: GH_REPO or the origin remote),
 * --prs <file> (read the open PRs from a JSON file instead of the API),
 * --fallback (do not use `gh stack` even when it is installed).
 *
 * GitHub's own `gh stack` extension (github/gh-stack) is used when it is
 * installed: `restack` runs `gh stack rebase --upstack <branch>` and
 * `gh stack push`, `list` prints `gh stack view --short` before the CI
 * listing. Without it, `restack` runs `git rebase --onto <new parent>
 * <old parent tip> <child>` for every PR above <branch>, parents first,
 * and prints the `git push --force-with-lease` commands; it pushes only
 * with --push. Reads use the REST API through `gh api`.
 * See docs/dev/stacking.md.
 */
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { promisify } from "node:util";
import { buildForest, ciState, findNode, flatten, formatChain, formatRows, mapLimit, pushCommands, restackPlan, rootOf, size } from "./lib/stack.mjs";

const execFileP = promisify(execFile);
const argv = process.argv.slice(2);
const cmd = argv[0];
const opt = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const VALUE_FLAGS = new Set(["--repo", "--prs", "--workflow", "--remote", "--old-base"]);
const positional = argv.slice(1).filter((a, i, all) => !a.startsWith("--") && !VALUE_FLAGS.has(all[i - 1]));

function usage(code = 0) {
  console.log(`Usage:
  node scripts/stack.mjs list [<branch>|#<pr>] [--no-ci] [--workflow ci.yml]
  node scripts/stack.mjs restack <branch> [--dry-run] [--push] [--remote origin] [--old-base <sha>]
Flags: --repo owner/name, --prs <file.json>, --fallback (ignore gh stack). See docs/dev/stacking.md.`);
  process.exit(code);
}
if (!cmd || cmd === "--help" || cmd === "-h" || cmd === "help") usage(0);
if (cmd !== "list" && cmd !== "restack") usage(1);

const git = (...a) => execFileSync("git", a, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
const gitOk = (...a) => spawnSync("git", a, { stdio: "ignore" }).status === 0;
const tryGit = (...a) => {
  try {
    return git(...a);
  } catch {
    return null;
  }
};

function repoName() {
  const r = opt("--repo") || process.env.GH_REPO || tryGit("remote", "get-url", "origin") || "talstilkol/lumen-md";
  return r.replace(/\.git$/, "").split(/[/:]/).slice(-2).join("/");
}

/** Is GitHub's gh-stack extension installed and runnable? */
function ghStackAvailable() {
  if (has("--fallback") || process.env.LUMEN_STACK_NO_GH_STACK) return false;
  return spawnSync("gh", ["stack", "--help"], { stdio: "ignore", timeout: 15_000 }).status === 0;
}

async function ghJson(path) {
  const { stdout } = await execFileP("gh", ["api", path], { maxBuffer: 64 << 20 });
  return JSON.parse(stdout);
}

async function openPrs(repo) {
  const file = opt("--prs");
  if (file) return JSON.parse(readFileSync(file, "utf8"));
  const { stdout } = await execFileP("gh", ["api", "--paginate", "--jq", ".[]", `repos/${repo}/pulls?state=open&per_page=100`], { maxBuffer: 64 << 20 });
  return stdout
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l));
}

async function list() {
  const repo = repoName();
  if (ghStackAvailable()) {
    console.log("gh stack (local stack):");
    spawnSync("gh", ["stack", "view", "--short"], { stdio: "inherit", env: { ...process.env, GH_STACK_NO_UPDATE_NOTIFIER: "1", GIT_PAGER: "cat", PAGER: "cat" } });
    console.log("");
  }
  const forest = buildForest(await openPrs(repo));
  let roots = forest.roots;
  if (positional[0]) {
    const node = findNode(forest, positional[0]);
    if (!node) {
      console.error(`stack: no open PR matches "${positional[0]}"`);
      process.exit(2);
    }
    roots = [rootOf(node)];
  }
  const shown = roots.flatMap((r) => flatten(r).map((x) => x.node));
  const ci = new Map();
  if (!has("--no-ci")) {
    const wf = opt("--workflow");
    await mapLimit(shown, 8, async (n) => {
      const path = wf
        ? `repos/${repo}/actions/workflows/${encodeURIComponent(wf)}/runs?branch=${encodeURIComponent(n.head)}&per_page=1`
        : `repos/${repo}/actions/runs?branch=${encodeURIComponent(n.head)}&per_page=1`;
      try {
        ci.set(n.number, ciState(await ghJson(path), n.headSha));
      } catch {
        ci.set(n.number, { state: "unknown", stale: false, name: "", url: "" });
      }
    });
  }
  const chains = roots.filter((r) => size(r) > 1);
  const singles = roots.filter((r) => size(r) === 1);
  console.log(`${repo}: ${forest.nodes.length} open PRs — ${chains.length} chain(s) of stacked PRs, ${singles.length} standalone\n`);
  for (const r of chains) console.log(formatChain(r, ci) + "\n");
  if (singles.length) {
    console.log(`Standalone PRs (${singles.length}):`);
    console.log(formatRows(singles.map((node) => ({ node, depth: 0 })), ci).join("\n"));
  }
  const states = [...ci.values()].reduce((m, c) => m.set(c.state, (m.get(c.state) ?? 0) + 1), new Map());
  if (states.size) console.log(`\nCI (newest run per head): ${[...states].map(([k, v]) => `${k} ${v}`).join(", ")}`);
}

// ── restack ──

function worktreeOwners() {
  const owners = new Map();
  let path = null;
  for (const line of (tryGit("worktree", "list", "--porcelain") ?? "").split("\n")) {
    if (line.startsWith("worktree ")) path = line.slice(9);
    else if (line.startsWith("branch refs/heads/")) owners.set(line.slice(18), path);
  }
  return owners;
}

/**
 * Uncommitted changes and untracked files of a worktree (porcelain lines;
 * null when git fails). Untracked files count: a rebase or checkout aborts
 * on one that a replayed commit would overwrite, halfway through the stack.
 */
const dirtyPaths = (dir) => {
  const out = spawnSync("git", ["-C", dir, "status", "--porcelain", "--untracked-files=normal"], { encoding: "utf8" });
  return out.status === 0 ? out.stdout.split("\n").filter(Boolean) : null;
};
const clean = (dir) => dirtyPaths(dir)?.length === 0;
const dirtyList = (dir) => {
  const lines = dirtyPaths(dir) ?? ["(git status failed)"];
  return lines.slice(0, 5).join(", ") + (lines.length > 5 ? `, … ${lines.length - 5} more` : "");
};
const isCommit = (sha) => Boolean(sha) && gitOk("cat-file", "-e", `${sha}^{commit}`);
const isAncestor = (a, b) => gitOk("merge-base", "--is-ancestor", a, b);

/** Commits in `to` that are not in `from`. */
const distance = (from, to) => Number(git("rev-list", "--count", `${from}..${to}`));

/** A path or ref as one shell word, for the commands printed to copy. */
const sh = (w) => (/^[\w@%+=:,./-]+$/.test(w) ? w : `'${w.replace(/'/g, "'\\''")}'`);

/**
 * The commit `child` was built on: its parent's tip before the parent
 * changed. Tried in order: --old-base (children of the restacked branch
 * only); of the remote-tracking branch and the parent PR's head on GitHub,
 * the one closest to the child (rebase replays every commit after the base
 * it is given, so a stale, older base would replay the parent's own newer
 * commits as the child's); the fork point in the parent's reflog; the plain
 * merge base.
 */
function oldBaseFor(parent, child, remote, explicit) {
  const local = git("rev-parse", parent.head);
  if (explicit) return { sha: git("rev-parse", explicit), how: "--old-base" };
  const tracking = tryGit("rev-parse", "--verify", "-q", `refs/remotes/${remote}/${parent.head}`);
  const candidates = [
    tracking ? { sha: tracking, how: `${remote}/${parent.head}` } : null,
    parent.headSha && isCommit(parent.headSha) ? { sha: parent.headSha, how: `PR #${parent.number} head on GitHub` } : null,
  ].filter((c) => c && c.sha !== local && isAncestor(c.sha, child));
  if (candidates.length) return candidates.reduce((best, c) => (distance(c.sha, child) < distance(best.sha, child) ? c : best));
  const fork = tryGit("merge-base", "--fork-point", parent.head, child);
  if (fork) return { sha: fork, how: "fork-point (reflog)" };
  return { sha: git("merge-base", parent.head, child), how: "merge-base" };
}

/** Did `branch` ever point at `sha` here (its reflog)? */
const inReflog = (branch, sha) => (tryGit("reflog", "show", "--format=%H", `refs/heads/${branch}`) ?? "").split("\n").includes(sha);

/**
 * Why force-pushing local `branch` over GitHub's `remoteSha` would lose
 * commits, or null when it is safe: the local branch contains that head, or
 * was rewritten here from it. Behind GitHub, or diverged from a head it never
 * had, is refused.
 */
function leaseProblem(branch, number, remoteSha) {
  const local = git("rev-parse", branch);
  if (!remoteSha || local === remoteSha) return null;
  const head = `#${number}'s head on GitHub (${remoteSha.slice(0, 8)})`;
  if (!isCommit(remoteSha)) return `${head} is not in this clone: fetch it (git fetch ${opt("--remote") ?? "origin"} ${branch}) and compare it with your ${branch} first.`;
  if (isAncestor(remoteSha, local)) return null;
  if (isAncestor(local, remoteSha)) return `${branch} is behind ${head}: a force-push would delete the commits only GitHub has. Update it first (git merge --ff-only ${remoteSha.slice(0, 8)} on ${branch}), then restack.`;
  if (inReflog(branch, remoteSha)) return null;
  return `${branch} has diverged from ${head}, which was never its tip here (pushed from elsewhere?): a force-push would delete it. Rebase ${branch} onto it first, then restack.`;
}

async function restack() {
  const branch = positional[0];
  if (!branch) usage(1);
  const remote = opt("--remote") ?? "origin";
  const dry = has("--dry-run");
  const doPush = has("--push");
  if (!gitOk("rev-parse", "--git-dir")) {
    console.error("stack: not inside a git repository");
    process.exit(1);
  }

  const forest = buildForest(await openPrs(repoName()));
  const { start, steps, foreign } = restackPlan(forest, branch);
  // gh stack stacks are linear (one child per branch): a PR tree that forks
  // above `branch` would be only partly rebased by it, so the fallback takes it.
  const forks = [start, ...steps.map((s) => forest.byHead.get(s.branch)?.[0])].filter((n) => n && n.children.filter((c) => c.sameRepo).length > 1);
  const linear = forks.length === 0;
  const useGhStack = !dry && ghStackAvailable();
  // gh stack has no old-base override: an explicit --old-base is honoured by the fallback only.
  if (opt("--old-base") && useGhStack) console.log("--old-base: gh stack has no equivalent; using git rebase --onto.\n");
  else if (!linear && useGhStack) console.log(`${forks.map((n) => n.head).join(", ")} ${forks.length > 1 ? "have" : "has"} more than one PR on top; gh stack stacks are linear, so using git rebase --onto.\n`);
  if (!opt("--old-base") && linear && useGhStack) {
    const env = { ...process.env, GH_STACK_NO_UPDATE_NOTIFIER: "1" };
    // The same remote for the fetch the rebase starts from as for the push.
    const r = spawnSync("gh", ["stack", "rebase", "--upstack", "--remote", remote, branch], { stdio: "inherit", env });
    if (r.status === 0) {
      if (doPush) process.exit(spawnSync("gh", ["stack", "push", "--remote", remote], { stdio: "inherit", env }).status ?? 1);
      // The push goes to the remote the rebase used, not one gh stack guesses.
      console.log(`\nRebased with gh stack. To push: gh stack push --remote ${sh(remote)}`);
      return;
    }
    // 2 = "not in a stack": the branches are not tracked by gh stack, use the fallback.
    if (r.status !== 2) process.exit(r.status ?? 1);
    console.log(`gh stack does not track "${branch}" (run \`gh stack init\` to adopt the branches); using git rebase --onto.\n`);
  }

  for (const f of foreign) console.log(`  #${f.number} ${f.branch} (from ${f.repo || "a fork"}): a fork's PR on ${f.parent}, not restacked here; its author rebases it.`);
  if (!steps.length) {
    console.log(`Nothing is stacked on ${branch} (#${start.number})${foreign.length ? " in this repository" : ""}.`);
    // An amended top branch still has its own push to make (below).
    const local = gitOk("rev-parse", "--verify", "-q", `refs/heads/${start.head}`);
    if (!local && doPush) {
      console.error(`stack: --push: branch ${start.head} is not local, so there is nothing to push. Fetch it first: git fetch ${remote} ${start.head}:${start.head}`);
      process.exit(1);
    }
    const amended = start.headSha && local && git("rev-parse", start.head) !== start.headSha;
    if (!amended) return;
  }
  for (const b of [start.head, ...steps.map((s) => s.branch)]) {
    if (!gitOk("rev-parse", "--verify", "-q", `refs/heads/${b}`)) {
      console.error(`stack: branch ${b} is not local. Fetch it first: git fetch ${remote} ${b}:${b}`);
      process.exit(1);
    }
  }
  const here = git("rev-parse", "--show-toplevel");
  if (steps.length && !dry && !clean(here)) {
    console.error(`stack: this worktree has uncommitted changes or untracked files (${dirtyList(here)}); commit, move or remove them first (the restack checks branches out here).`);
    process.exit(1);
  }
  const owners = worktreeOwners();
  /** The other worktree a branch is checked out in (it must be rebased there), or null. */
  const ownerOf = (b) => {
    const o = owners.get(b);
    return o && o !== here ? o : null;
  };
  const original = tryGit("symbolic-ref", "-q", "--short", "HEAD") ?? git("rev-parse", "HEAD");
  const oldTip = new Map(steps.map((s) => [s.branch, git("rev-parse", s.branch)]));
  const nodeOf = (head) => (forest.byHead.get(head) ?? [])[0];
  // The new parent by name: it resolves to the parent's tip after its own rebase.
  const argsOf = (s, base) => {
    const o = ownerOf(s.branch);
    return o ? ["-C", o, "rebase", "--onto", s.parent, base] : ["rebase", "--onto", s.parent, base, s.branch];
  };
  const command = (p) => `git ${argsOf(p.s, p.oldBase).map(sh).join(" ")}`;

  if (steps.length) console.log(`Restack ${steps.length} PR(s) above ${start.head} (#${start.number})${dry ? " — dry run" : ""}:`);
  // The whole plan first, before anything moves: a layer's old base is
  // known up front (branches this run moves were built on the tip recorded
  // above), so every worktree can be checked and every recovery command is exact.
  const moving = new Set();
  const plan = [];
  // Already on its parent, but changed here since its PR head (amended):
  // nothing to rebase, but it is pushed with the layers above it, or their
  // PRs would carry its change in their own diff.
  const changedOnly = [];
  for (const s of steps) {
    const parentMoves = moving.has(s.parent);
    if (!parentMoves && isAncestor(s.parent, s.branch)) {
      const changed = Boolean(s.remoteSha) && git("rev-parse", s.branch) !== s.remoteSha;
      console.log(`  #${s.number} ${s.branch}: already on ${s.parent}${changed ? " (changed here since its PR head: pushed with the rest)" : ""}`);
      if (changed) changedOnly.push(s);
      continue;
    }
    // A moving parent's recorded tip is the old base only if the child was
    // built on it: a parent amended after the child branched is not in the
    // child's history, so the old base is found from the child as for the first layer.
    const tip = oldTip.get(s.parent);
    const { sha: oldBase, how } =
      parentMoves && isAncestor(tip, s.branch)
        ? { sha: tip, how: `old tip of ${s.parent}` }
        : oldBaseFor(nodeOf(s.parent), s.branch, remote, s.parent === start.head ? opt("--old-base") : undefined);
    const p = { s, oldBase, owner: ownerOf(s.branch) };
    console.log(`  #${s.number} ${command(p)}   # old base: ${how}`);
    moving.add(s.branch);
    plan.push(p);
  }
  // Every branch that will be force-pushed must contain its GitHub head, or
  // have been rewritten here from it (amend, rebase): a lease on the sha
  // GitHub has does not protect commits only GitHub has.
  const problems = [
    start.headSha && git("rev-parse", start.head) !== start.headSha ? leaseProblem(start.head, start.number, start.headSha) : null,
    ...plan.map((p) => leaseProblem(p.s.branch, p.s.number, p.s.remoteSha)),
    ...changedOnly.map((s) => leaseProblem(s.branch, s.number, s.remoteSha)),
  ].filter(Boolean);
  if (problems.length) {
    console.error(`\nstack: nothing was rebased.\n  ${problems.join("\n  ")}`);
    process.exit(1);
  }
  if (!dry) {
    const dirty = plan.filter((p) => p.owner && !clean(p.owner));
    if (dirty.length) {
      console.error(`\nstack: nothing was rebased. ${dirty.map((p) => `${p.s.branch} is checked out in ${p.owner} with uncommitted changes or untracked files (${dirtyList(p.owner)})`).join("; ")}: clean ${dirty.length > 1 ? "them" : "it"}, then run the restack again.`);
      process.exit(1);
    }
    for (let i = 0; i < plan.length; i++) {
      const p = plan[i];
      const r = spawnSync("git", argsOf(p.s, p.oldBase), { stdio: "inherit" });
      if (r.status !== 0) {
        const rest = plan.slice(i + 1).map(command);
        console.error(`\nstack: the rebase of ${p.s.branch} stopped (conflict?). Resolve it in ${p.owner ?? here}, run \`git rebase --continue\` (or --abort), then:`);
        console.error(rest.length ? "  " + rest.join("\n  ") : "  (nothing else to rebase)");
        process.exit(3);
      }
    }
    const now = tryGit("symbolic-ref", "-q", "--short", "HEAD") ?? git("rev-parse", "HEAD");
    if (now !== original) spawnSync("git", ["checkout", "-q", original], { stdio: "inherit" });
  }
  // Bottom to top, as the stack is: rebased layers and changed-only ones.
  const pushed = new Set([...plan.map((p) => p.s.branch), ...changedOnly.map((s) => s.branch)]);
  const moved = steps.filter((s) => pushed.has(s.branch));

  const startLocal = git("rev-parse", start.head);
  const toPush = [...(start.headSha && startLocal !== start.headSha ? [{ branch: start.head, remoteSha: start.headSha }] : []), ...moved.map((s) => ({ branch: s.branch, remoteSha: s.remoteSha }))];
  if (!toPush.length) {
    console.log("\nNothing to push.");
    return;
  }
  const cmds = pushCommands(toPush, remote);
  if (doPush && !dry) {
    for (const c of cmds) {
      console.log(`$ ${c}`);
      const [, ...a] = c.split(" ");
      const r = spawnSync("git", a, { stdio: "inherit" });
      if (r.status !== 0) process.exit(r.status ?? 1);
    }
    return;
  }
  console.log(`\nPush when ready (not run; pass --push to run them):\n  ${cmds.join("\n  ")}`);
}

(cmd === "list" ? list() : restack()).catch((e) => {
  console.error(`stack: ${e.stderr?.toString().trim() || e.message}`);
  process.exit(1);
});
