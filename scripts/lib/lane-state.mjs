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

// ───────────── checking the file itself (W8.10 steps 2 and 3) ─────────────

/** How old STATE.md may get, in minutes: the lane writes it at least every hour. */
export const MAX_STATE_AGE_MIN = 60;
/** Pushes per branch: one, plus at most one fix push (the lanes' brief). */
export const MAX_PUSHES_PER_BRANCH = 2;

const sectionLines = (md, name) => {
  const lines = String(md).split("\n");
  const start = lines.findIndex((l) => new RegExp(`^##\\s+${name}\\b`, "i").test(l));
  if (start < 0) return null;
  const end = lines.findIndex((l, i) => i > start && /^##\s/.test(l));
  return lines.slice(start + 1, end < 0 ? undefined : end);
};

/** The time on the "Updated:" line, as ms since the epoch, or null. Accepts 2026-11-14T22:55Z and 2026-11-14 22:55 UTC. */
export function parseUpdated(md) {
  const m = /^Updated:\s*(\d{4}-\d{2}-\d{2})[T ](\d{1,2}:\d{2}(?::\d{2})?)\s*(?:Z|UTC)?/im.exec(String(md));
  if (!m) return null;
  const t = Date.parse(`${m[1]}T${m[2].padStart(5, "0")}Z`);
  return Number.isNaN(t) ? null : t;
}

/**
 * The "## Pushes" log → [{ branch, sha, line }]: one per bullet line that
 * names a branch (one of `branches`, or else a token with a slash) and a
 * sha. Lines that are prose, or a "fix" note without a sha, are skipped.
 */
export function parsePushes(md, branches = []) {
  const lines = sectionLines(md, "Pushes") ?? [];
  const out = [];
  for (const line of lines) {
    if (!/^\s*[-*]\s/.test(line)) continue;
    const words = line.replace(/`/g, "").split(/[\s,;()]+/);
    const branch = branches.find((b) => words.includes(b)) ?? words.find((w) => /^[\w.-]+\/[\w./-]+$/.test(w) && !/^https?:/.test(w) && !/^\d/.test(w));
    const sha = words.find((w) => SHA.test(w) && /[a-f]/.test(w) && /\d/.test(w));
    if (branch && sha) out.push({ branch, sha, line: line.trim() });
  }
  return out;
}

/**
 * The problems of a STATE.md → [{ level: "fail" | "warn", line }].
 *   fail: no "Updated:" line, or older than maxAgeMin; the same sha pushed
 *         twice on one branch (a resumed lane pushed again what was pushed).
 *   warn: more pushes on a branch than one plus a fix; a Branches row whose
 *         pushed head the Pushes log does not have; a base that is neither
 *         main nor a train (W6.22, `isTrainOrTrunk`); a train's own row
 *         (verify/*) is not a PR, so its base is not judged.
 */
export function checkState(md, { now = Date.now(), maxAgeMin = MAX_STATE_AGE_MIN, isTrainOrTrunk = (b) => b === "main" || /^verify\/train(?:-\d+)?$/.test(b) } = {}) {
  const out = [];
  const updated = parseUpdated(md);
  if (updated == null) out.push({ level: "fail", line: 'no "Updated: <UTC time>" line: write one (docs/dev/lane-state.md)' });
  else {
    const age = Math.floor((now - updated) / 60000);
    if (age > maxAgeMin) out.push({ level: "fail", line: `written ${age} min ago (the lane writes it at least every ${maxAgeMin} min): update it` });
  }
  const rows = parseBranches(md);
  const pushes = parsePushes(md, rows.map((r) => r.branch));
  const seen = new Map();
  const perBranch = new Map();
  for (const p of pushes) {
    const key = `${p.branch}@${p.sha.slice(0, 7)}`;
    if (seen.has(key)) out.push({ level: "fail", line: `${p.branch}: ${p.sha} was pushed twice ("${seen.get(key)}" and "${p.line}")` });
    else seen.set(key, p.line);
    perBranch.set(p.branch, (perBranch.get(p.branch) ?? 0) + 1);
  }
  for (const [b, n] of perBranch) if (n > MAX_PUSHES_PER_BRANCH) out.push({ level: "warn", line: `${b}: ${n} pushes (one, plus at most one fix push)` });
  for (const r of rows) {
    if (r.pushed && !pushes.some((p) => p.branch === r.branch && same(p.sha, r.pushed))) out.push({ level: "warn", line: `${r.branch}: pushed ${r.pushed} is not in the Pushes log: add the line` });
    if (r.base && !isTrainOrTrunk(r.branch) && !/^verify\//.test(r.branch) && !isTrainOrTrunk(r.base)) out.push({ level: "warn", line: `${r.branch}: base ${r.base} is neither main nor a train (W6.22: every PR on the train head)` });
  }
  return out;
}

/** The one resume instruction for a lane (W8.10 step 3): what a session that takes the lane over is told. */
export function resumePrompt({ lane, state, repo = "talstilkol/lumen-md" }) {
  return [
    `You are lane ${lane} of ${repo.split("/")[1]}, resuming after a stop.`,
    `1. Read the lane's brief, then ${state} in full.`,
    `2. Run \`node scripts/lane-state.mjs resume ${state}\` and do what each line says: nothing = push nothing; open-pr = open the PR, no push; push = pre-push check, then ONE push; record = write origin's head into STATE.md, no push; look = fetch and merge (never force) or recreate the worktree.`,
    `3. Run \`node scripts/lane-state.mjs check ${state}\`: fix what it fails on before any other work.`,
    `4. Respect "Waiting on": a running build is not started again; a rate limit holds until its time.`,
    `5. Continue at "Next". Tasks marked verified are not run again unless their branch head changed.`,
    `6. Write ${state} after every push (first thing), after every kept commit, every hour, and before you stop.`,
  ].join("\n");
}
