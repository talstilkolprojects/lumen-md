/**
 * Pure parts of the handoff generator (plan 0.13): parsing git output and
 * writing the Markdown, so they can be tested without git or GitHub.
 */

/**
 * `git worktree list --porcelain` → [{ path, branch, head, prunable?, locked? }].
 * `prunable` (git's reason) marks a worktree whose directory is gone; a
 * locked one is never prunable, so the CLI also checks that the path exists.
 */
export function parseWorktrees(text) {
  const out = [];
  let cur = null;
  for (const line of text.split("\n")) {
    if (line.startsWith("worktree ")) {
      cur = { path: line.slice(9), branch: null, head: null };
      out.push(cur);
    } else if (cur && line.startsWith("HEAD ")) cur.head = line.slice(5, 13);
    else if (cur && line.startsWith("branch ")) cur.branch = line.slice(7).replace(/^refs\/heads\//, "");
    else if (cur && (line === "prunable" || line.startsWith("prunable "))) cur.prunable = line.slice(9).trim() || "prunable";
    else if (cur && (line === "locked" || line.startsWith("locked "))) cur.locked = line.slice(7).trim() || true;
  }
  return out;
}

/** The PR stack as a tree: each PR under the PR whose head is its base. Roots are PRs on a branch no open PR provides. */
export function prTree(prs) {
  const byHead = new Map(prs.map((p) => [p.head, p]));
  const children = new Map();
  const roots = [];
  for (const p of prs) {
    const parent = byHead.get(p.base);
    if (parent && parent !== p) {
      if (!children.has(parent.number)) children.set(parent.number, []);
      children.get(parent.number).push(p);
    } else roots.push(p);
  }
  const sort = (a) => a.sort((x, y) => x.number - y.number);
  const lines = [];
  const seen = new Set();
  const walk = (p, depth) => {
    if (seen.has(p.number)) return;
    seen.add(p.number);
    lines.push({ depth, pr: p });
    for (const c of sort(children.get(p.number) ?? [])) walk(c, depth + 1);
  };
  for (const r of sort(roots)) walk(r, 0);
  // PRs based on one another's heads (a cycle) have no root: show each such
  // component from its lowest number rather than drop it (W1.32, Codex on #211).
  for (const p of sort([...prs])) walk(p, 0);
  return lines;
}

const CI_MARK = { success: "✅", failure: "❌", cancelled: "⚪", null: "⏳", undefined: "—" };

/** A PR whose head lives in another repository (a fork; `headRepo` null = a deleted fork). */
export const isForkPr = (p, repo) => p.headRepo !== undefined && p.headRepo !== repo;

/**
 * Names mentioned in the handoff that do not exist (a stale handoff is worse
 * than none). A fork PR's head is a branch of the fork, which GitHub just
 * returned, never a local or origin ref, so it is not checked here.
 */
export function missingRefs({ prs, worktrees, branches, repo }) {
  const known = new Set(branches);
  const problems = [];
  for (const p of prs) {
    // A deleted fork (headRepo null) has no head branch anywhere (W1.32, Codex on #211).
    if (p.headRepo === null) problems.push(`PR #${p.number}: its fork was deleted, so branch ${p.head} exists nowhere (close or recreate the PR)`);
    else if (!isForkPr(p, repo) && !known.has(p.head)) problems.push(`PR #${p.number}: branch ${p.head} is not here (git fetch?)`);
  }
  for (const w of worktrees) {
    if (w.prunable) problems.push(`worktree ${w.path}: the directory is gone (${w.prunable}); git worktree prune`);
    else if (w.branch && !known.has(w.branch)) problems.push(`worktree ${w.path}: branch ${w.branch} is gone`);
  }
  return problems;
}

/** Text for a Markdown table cell: a "|" would end the cell. */
const cell = (v) => String(v).replace(/\|/g, "\\|");

/** The Markdown document. */
export function renderHandoff({ now, repo, task, next, prs, worktrees, problems }) {
  const o = [];
  o.push(`# Handoff — ${repo}`, "", `Generated ${now} by \`npm run handoff\` (plan 0.13). Regenerate after every PR; do not edit by hand.`, "");
  o.push("## Now", "", `- **Current task:** ${task || "—"}`, `- **Next step:** ${next || "—"}`, "");
  o.push(`## Open PRs (${prs.length}) — as a stack`, "", "Indented PRs are based on the PR above them. CI is the latest run on the head branch.", "");
  o.push("| PR | Branch → base | CI | Unanswered review comments | Title |", "|---|---|---|---|---|");
  for (const { depth, pr } of prTree(prs)) {
    const ci = `${CI_MARK[pr.ci] ?? pr.ci}${pr.ciSha ? ` \`${pr.ciSha}\`` : ""}`;
    const indent = depth === 0 ? "" : depth <= 3 ? "↳ ".repeat(depth) : `↳${depth} `;
    const head = isForkPr(pr, repo) ? `${pr.headRepo ? pr.headRepo.split("/")[0] : "(deleted fork)"}:${pr.head}` : pr.head;
    // A git ref may contain "|", which would end the table cell even inside backticks (W1.32, Codex on #211).
    o.push(`| ${indent}#${pr.number} | \`${cell(head)}\` → \`${cell(pr.base)}\` | ${ci} | ${pr.unanswered ?? "?"} | ${cell(pr.title)} |`);
  }
  o.push("", "\"Unanswered\" counts top-level review comments that have no reply yet. GitHub's REST API does not expose whether a thread is resolved, so this is an upper bound.", "");
  o.push(`## Worktrees (${worktrees.length})`, "", "| Path | Branch | HEAD |", "|---|---|---|");
  for (const w of worktrees) o.push(`| \`${w.path}\`${w.prunable ? " (directory gone)" : ""} | ${w.branch ? `\`${w.branch}\`` : "(detached)"} | \`${w.head ?? ""}\` |`);
  o.push("", "## To continue", "", "```sh", "git fetch origin", "gh pr checks <N>                      # CI of a PR", "npm run ci:local -- --changed       # if plan 0.14 is merged", "scripts/lane.sh <branch> <base>     # a new lane (docs/dev/lanes.md)", "```", "");
  o.push("## Checks", "");
  if (problems.length) for (const p of problems) o.push(`- ⚠️ ${p}`);
  else o.push("- Every branch and worktree named above exists.");
  o.push("");
  return o.join("\n");
}
