/**
 * A lane's STATE.md, and what a resumed lane does next (W8.10).
 *
 * A session can stop at any point (an API limit, a lost context). Each lane
 * keeps one STATE.md (docs/dev/lane-state.md has the template) whose
 * "Branches" table says, per branch, the head the lane last pushed. On
 * resume, `node scripts/lane-state.mjs resume <STATE.md>` compares that
 * table with git and GitHub and prints one action per branch, so finished
 * work is not redone and nothing is pushed twice.
 *
 * Pure functions here; scripts/lane-state.mjs runs git and gh.
 */

/** The columns of the Branches table, in order. */
export const BRANCH_COLUMNS = ["branch", "worktree", "base", "pushed", "pr"];

const SHA = /^[0-9a-f]{7,40}$/;
const clean = (cell) => cell.replace(/`/g, "").trim();

/**
 * The rows of the "## Branches" table of a STATE.md:
 * [{ branch, worktree, base, pushed: sha|null, pr: number|null }].
 * A "—" (or empty, or "none") pushed cell means never pushed; a pr cell
 * "#512" is that PR. Rows that are not a branch (the header, the rule) are skipped.
 */
export function parseBranches(md) {
  const lines = String(md).split("\n");
  const start = lines.findIndex((l) => /^##\s+Branches\b/i.test(l));
  if (start < 0) return [];
  const rows = [];
  for (const line of lines.slice(start + 1)) {
    if (/^##\s/.test(line)) break;
    if (!line.trim().startsWith("|")) continue;
    const cells = line.trim().replace(/^\||\|$/g, "").split("|").map(clean);
    if (cells.length < BRANCH_COLUMNS.length || /^-+$/.test(cells[0].replace(/[:\s]/g, "")) || cells[0].toLowerCase() === "branch") continue;
    const [branch, worktree, base, pushed, pr] = cells;
    rows.push({
      branch,
      worktree,
      base,
      pushed: SHA.test(pushed) ? pushed : null,
      pr: /^#?\d+$/.test(pr) ? Number(pr.replace("#", "")) : null,
    });
  }
  return rows;
}

const same = (a, b) => Boolean(a && b) && (a.startsWith(b) || b.startsWith(a));

/**
 * What to do with one branch on resume.
 *   row:   its STATE.md row
 *   facts: { local: sha|null (the worktree's HEAD), remote: sha|null (origin's head),
 *            prs: [numbers of open or closed PRs whose head is the branch],
 *            ahead / behind: commits local has that remote lacks, and the reverse (null: unknown) }
 * → { action, why }, action one of
 *   "nothing"    origin already has the local head: do not push again
 *   "push"       local commits origin lacks: run the pre-push check, then push once
 *   "open-pr"    pushed, but no PR has this head yet (and STATE.md names none)
 *   "record"     origin is ahead of STATE.md (another session pushed): update STATE.md, push nothing
 *   "look"       the worktree is gone, or origin moved away from local: a person decides
 */
export function resumeAction(row, facts) {
  const { local, remote, prs = [], ahead = null, behind = null } = facts;
  if (!local) return { action: "look", why: `no worktree at ${row.worktree}: recreate it from origin/${row.branch} before any work` };
  const hasPr = prs.length > 0 || row.pr != null;
  if (remote && same(local, remote)) {
    if (!same(row.pushed ?? "", remote)) return { action: "record", why: `origin/${row.branch} is at ${remote.slice(0, 10)}, STATE.md says ${row.pushed ?? "never pushed"}: write the new head into STATE.md` };
    return hasPr ? { action: "nothing", why: `pushed ${remote.slice(0, 10)}${prs.length ? `, PR #${prs[0]}` : row.pr ? `, PR #${row.pr}` : ""}: nothing to push` } : { action: "open-pr", why: `pushed ${remote.slice(0, 10)}, no PR yet: open one (do not push again)` };
  }
  if (!remote && row.pushed) return { action: "look", why: `STATE.md says ${row.pushed} was pushed, but origin has no ${row.branch}: check the branch name before pushing` };
  if (remote && behind) return { action: "look", why: `origin/${row.branch} (${remote.slice(0, 10)}) has ${behind} commit(s) the worktree (${local.slice(0, 10)}) lacks: fetch and merge, never force` };
  if (remote && row.pushed && !same(row.pushed, remote)) return { action: "look", why: `origin/${row.branch} moved to ${remote.slice(0, 10)} since STATE.md's ${row.pushed}: fetch and merge before pushing` };
  return { action: "push", why: `${ahead ?? "unpushed"} local commit(s) not on origin${remote ? "" : " (the branch is not on origin yet)"}: prepush, then one push, then write the new head into STATE.md` };
}

/** A fresh Branches table for STATE.md from rows (after a push, write this back). */
export function renderBranches(rows) {
  const head = `| ${BRANCH_COLUMNS.join(" | ")} |`;
  const rule = `| ${BRANCH_COLUMNS.map(() => "---").join(" | ")} |`;
  const body = rows.map((r) => `| ${r.branch} | ${r.worktree} | ${r.base} | ${r.pushed ?? "—"} | ${r.pr != null ? `#${r.pr}` : "—"} |`);
  return [head, rule, ...body].join("\n");
}
