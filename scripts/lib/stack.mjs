/**
 * Pure logic of scripts/stack.mjs: the chains of open pull requests
 * (a PR whose base branch is another open PR's head sits on top of it),
 * CI status of a head, the restack plan and the push commands. Tested
 * with fixture PR JSON in src/__tests__/stack.test.ts.
 */

/** The fields we use from a REST pull request. */
const slim = (pr) => ({
  number: pr.number,
  title: pr.title ?? "",
  head: pr.head?.ref,
  headSha: pr.head?.sha ?? "",
  base: pr.base?.ref,
  draft: Boolean(pr.draft),
  url: pr.html_url ?? "",
  // A fork's branch can never be the base of a PR in this repository.
  sameRepo: !pr.head?.repo || !pr.base?.repo || pr.head.repo.full_name === pr.base.repo.full_name,
  headRepo: pr.head?.repo?.full_name ?? "",
  stack: pr.stack ?? null,
});

/**
 * Open PRs → forest of chains. A PR's parent is the open, same-repository
 * PR whose head branch is its base branch; PRs without one are roots (their
 * base is the trunk, or a branch with no open PR). Children are ordered by
 * PR number. Returns { roots, nodes, byHead }.
 */
export function buildForest(prs) {
  const nodes = prs.map((p) => ({ ...slim(p), children: [], parent: null }));
  const byHead = new Map();
  for (const n of nodes) {
    if (!n.sameRepo || !n.head) continue;
    if (!byHead.has(n.head)) byHead.set(n.head, []);
    byHead.get(n.head).push(n);
  }
  // Two open PRs from one branch is unusual; the oldest one carries the
  // chain, so every lookup by head (findNode, the CLI) takes the first.
  for (const list of byHead.values()) list.sort((a, b) => a.number - b.number);
  for (const n of nodes) {
    const candidates = (byHead.get(n.base) ?? []).filter((p) => p !== n);
    const parent = candidates[0];
    if (parent) n.parent = parent;
  }
  // A cycle (a → b → a) has no root; break it at its lowest-numbered PR.
  for (const n of nodes) {
    const seen = new Set();
    let cur = n;
    while (cur.parent && !seen.has(cur)) {
      seen.add(cur);
      cur = cur.parent;
    }
    if (cur.parent && seen.has(cur)) {
      const loop = [];
      let c = cur;
      do {
        loop.push(c);
        c = c.parent;
      } while (c !== cur);
      loop.sort((a, b) => a.number - b.number)[0].parent = null;
    }
  }
  for (const n of nodes) if (n.parent) n.parent.children.push(n);
  for (const n of nodes) n.children.sort((a, b) => a.number - b.number);
  const roots = nodes.filter((n) => !n.parent).sort((a, b) => size(b) - size(a) || a.number - b.number);
  return { roots, nodes, byHead };
}

/** Number of PRs in a node's subtree, itself included. */
export function size(node) {
  return 1 + node.children.reduce((s, c) => s + size(c), 0);
}

/** Bottom → top, depth-first (a fork's branches follow one another). */
export function flatten(root) {
  const out = [];
  const walk = (n, depth) => {
    out.push({ node: n, depth });
    for (const c of n.children) walk(c, depth + (n.children.length > 1 ? 1 : 0));
  };
  walk(root, 0);
  return out;
}

/** The root of a PR's chain. */
export const rootOf = (node) => {
  let n = node;
  while (n.parent) n = n.parent;
  return n;
};

/** A node by "#123", "123" or a head branch name. */
export function findNode(forest, key) {
  const k = String(key).replace(/^#/, "");
  if (/^\d+$/.test(k)) return forest.nodes.find((n) => n.number === Number(k)) ?? null;
  return (forest.byHead.get(k) ?? [])[0] ?? null;
}

/** Every PR above `node`, parents before children (breadth-first). */
export function descendants(node) {
  const out = [];
  const queue = [...node.children];
  while (queue.length) {
    const n = queue.shift();
    out.push(n);
    queue.push(...n.children);
  }
  return out;
}

/**
 * CI state of a head from `actions/runs?branch=<b>&per_page=1`: the newest
 * run's conclusion (or its status while it runs). `stale` = that run is
 * for another commit than the PR's head.
 */
export function ciState(runsResponse, headSha) {
  const run = runsResponse?.workflow_runs?.[0];
  if (!run) return { state: "none", stale: false, name: "", url: "" };
  const state = run.status === "completed" ? (run.conclusion ?? "unknown") : run.status;
  return { state, stale: Boolean(headSha && run.head_sha && run.head_sha !== headSha), name: run.name ?? "", url: run.html_url ?? "" };
}

const MARK = { success: "✓", failure: "✗", cancelled: "∅", timed_out: "✗", action_required: "!", neutral: "·", skipped: "·", stale: "~", none: "–", in_progress: "…", queued: "…", waiting: "…", pending: "…", requested: "…" };

/** One aligned line per PR: `rows` = [{ node, depth }], `ci` = Map(number → ciState). */
export function formatRows(rows, ci = new Map()) {
  const headW = Math.min(48, Math.max(...rows.map((r) => r.node.head.length + r.depth * 2)));
  const baseW = Math.min(40, Math.max(...rows.map((r) => r.node.base.length)));
  return rows.map(({ node, depth }) => {
    const c = ci.get(node.number);
    const state = c ? `${MARK[c.state] ?? "?"} ${c.state}${c.stale ? " (older commit)" : ""}` : "";
    const head = ("  ".repeat(depth) + node.head).padEnd(headW);
    const stack = node.stack ? `  [stack ${node.stack.number} ${node.stack.position}/${node.stack.size}]` : "";
    return `  #${String(node.number).padEnd(4)} ${head}  ← ${node.base.padEnd(baseW)}  ${node.headSha.slice(0, 8)}  ${state}${node.draft ? "  draft" : ""}${stack}`.trimEnd();
  });
}

/** Text listing of one chain, bottom first, under a one-line header. */
export function formatChain(root, ci = new Map()) {
  const rows = flatten(root);
  const top = rows[rows.length - 1].node;
  const header = rows.length > 1 ? `Chain of ${rows.length} PRs on ${root.base}: #${root.number} (bottom) … #${top.number} (top)` : `#${root.number} on ${root.base}`;
  return [header, ...formatRows(rows, ci)].join("\n");
}

/**
 * The restack of everything above `branch`: one step per descendant,
 * parents first. Each step rebases `branch` from its parent's old tip onto
 * the parent's new tip: `git rebase --onto <parent> <oldBase> <branch>`.
 * A fork's PR can target a branch of the stack, but its head lives in
 * another repository (a local branch of the same name is not it): it is
 * listed in `foreign`, never a step. A fork's head is never a parent, so
 * nothing sits above one.
 */
export function restackPlan(forest, branch) {
  const start = findNode(forest, branch);
  if (!start) throw new Error(`no open PR has head "${branch}"`);
  const all = descendants(start);
  return {
    start,
    steps: all.filter((n) => n.sameRepo).map((n) => ({ branch: n.head, parent: n.parent.head, number: n.number, remoteSha: n.headSha })),
    foreign: all.filter((n) => !n.sameRepo).map((n) => ({ branch: n.head, parent: n.parent.head, number: n.number, repo: n.headRepo })),
  };
}

/** `git push --force-with-lease` for each moved branch, leased on the sha GitHub has. */
export function pushCommands(moved, remote = "origin") {
  return moved.map(({ branch, remoteSha }) => (remoteSha ? `git push --force-with-lease=${branch}:${remoteSha} ${remote} ${branch}` : `git push --force-with-lease ${remote} ${branch}`));
}

/** Map with at most `limit` promises in flight. */
export async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  const worker = async () => {
    while (i < items.length) {
      const k = i++;
      out[k] = await fn(items[k], k);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
  return out;
}
