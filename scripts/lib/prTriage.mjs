/**
 * PR triage (plan W6.21): sort every open pull request into one category, so
 * the owner approves a category once instead of 356 PRs one by one.
 *
 *   train       a WIP integration train (head verify/*): it is merged or
 *               closed when it is promoted, never by this script
 *   dependabot  opened by dependabot: lane S triages these (plan W6.14)
 *   in-main     every commit of the head is already in main: close now, with
 *               a link to main
 *   in-train    every commit of the head is in a train (verify/train,
 *               verify/train-2, verify/train-3) but not yet in main: close
 *               once that train is promoted (the close step re-checks main)
 *   superseded  a later PR replaces it: a later PR says "Supersedes #N" (or
 *               "Replaces" / "Obsoletes"), or a later PR of the same plan task
 *               contains every commit of this one — closing it loses nothing
 *   needed      everything else: still open work
 *
 * "Contains" is `git merge-base --is-ancestor <head sha> <ref>`, so a PR whose
 * branch was rebased or squashed into a train counts as needed, never as
 * contained: the script errs towards keeping a PR open.
 *
 * Pure functions here; the git and GitHub calls are in scripts/pr-triage.mjs.
 */

export const CATEGORIES = ["in-main", "in-train", "superseded", "dependabot", "train", "needed"];

/** Plan task ids named in a PR title: `W6.21`, `4.19`, `12.2`, `0.7` (not versions like 2.7.4). */
export function taskIds(title) {
  const out = new Set();
  for (const m of String(title ?? "").matchAll(/(?<![\w.])(W\d{1,2}\.\d{1,2}|\d{1,2}\.\d{1,2})(?![\w.]*\d)/g)) out.add(m[1]);
  return out;
}

/**
 * PR numbers a body says it replaces: "Supersedes #12", "Replaces #12, #13",
 * "Obsoletes #12". Not "replaces #12's filter", which replaces a part.
 */
export function supersededNumbers(body) {
  const out = new Set();
  for (const m of String(body ?? "").matchAll(/\b(?:supersedes|replaces|obsoletes)\s+((?:#\d+(?![\w'’])(?:\s*(?:,|and)\s*)?)+)/gi)) {
    for (const n of m[1].matchAll(/#(\d+)(?![\w'’])/g)) out.add(Number(n[1]));
  }
  return out;
}

export const isTrainBranch = (ref) => /^verify\//.test(String(ref ?? ""));
export const isDependabot = (pr) => pr.user === "dependabot[bot]" || String(pr.head ?? "").startsWith("dependabot/");

/**
 * Classify open PRs.
 * prs: [{ number, title, body, user, head, sha, base }]
 * contains(sha, ref): is `sha` an ancestor of (or equal to) `ref` — a branch
 *   name (main, a train) or another commit sha.
 * trains: train branch names that exist, oldest first.
 * Returns rows sorted by number: { number, title, head, base, user, category, why, trains, by }
 *   trains: the trains that contain the head; by: the PR that supersedes it.
 */
export function classify(prs, { contains, trains, main = "main" }) {
  const sorted = [...prs].sort((a, b) => a.number - b.number);
  const explicit = new Map();
  for (const p of sorted) for (const n of supersededNumbers(p.body)) if (n < p.number && !explicit.has(n)) explicit.set(n, p.number);
  const trainPr = new Map(sorted.filter((p) => isTrainBranch(p.head)).map((p) => [p.head, p.number]));
  const rows = [];
  for (const p of sorted) {
    const row = { number: p.number, title: p.title, head: p.head, base: p.base, user: p.user, category: "needed", why: "", trains: [], by: null };
    rows.push(row);
    if (isTrainBranch(p.head)) {
      row.category = "train";
      row.why = `integration train ${p.head} → ${p.base}`;
      continue;
    }
    if (isDependabot(p)) {
      row.category = "dependabot";
      row.why = "dependency update (W6.14)";
      continue;
    }
    if (contains(p.sha, main)) {
      row.category = "in-main";
      row.why = `head ${p.sha.slice(0, 9)} is in ${main}`;
      continue;
    }
    row.trains = trains.filter((t) => contains(p.sha, t));
    if (row.trains.length) {
      row.category = "in-train";
      const t = row.trains[0];
      row.why = `head ${p.sha.slice(0, 9)} is in ${t}${trainPr.has(t) ? ` (#${trainPr.get(t)})` : ""}`;
      continue;
    }
    if (explicit.has(p.number)) {
      row.category = "superseded";
      row.by = explicit.get(p.number);
      row.why = `#${row.by} says it supersedes this PR`;
      continue;
    }
    const ids = taskIds(p.title);
    const later = ids.size ? sorted.find((q) => q.number > p.number && !isDependabot(q) && !isTrainBranch(q.head) && [...taskIds(q.title)].some((id) => ids.has(id)) && contains(p.sha, q.sha)) : undefined;
    if (later) {
      row.category = "superseded";
      row.by = later.number;
      row.why = `#${later.number} (same task ${[...taskIds(later.title)].filter((id) => ids.has(id)).join(", ")}) contains every commit of this PR`;
      continue;
    }
    row.why = "commits not in main or any train";
  }
  return rows;
}

/** Count per category, in CATEGORIES order. */
export function counts(rows) {
  const c = Object.fromEntries(CATEGORIES.map((k) => [k, 0]));
  for (const r of rows) c[r.category]++;
  return c;
}

/** The comment each closed PR gets (English and Hebrew). */
export function closeComment(row, { mainSha } = {}) {
  if (row.category === "in-main" || row.category === "in-train") {
    const at = mainSha ? ` (main at ${mainSha.slice(0, 9)})` : "";
    return `Every commit of this PR is in main${at}${row.trains?.length ? `, merged through ${row.trains[0]}` : ""}. Closing as done (plan W6.21); the branch is kept for 30 days.\n\nכל הקומיטים של ה-PR הזה כבר ב-main${at}. נסגר כגמור (W6.21); הענף נשמר 30 יום.`;
  }
  if (row.category === "superseded") {
    return `Superseded by #${row.by}: ${row.why}. Closing (plan W6.21, approved category); the branch is kept for 30 days.\n\nהוחלף ב-#${row.by}. נסגר (W6.21, קטגוריה שאושרה); הענף נשמר 30 יום.`;
  }
  return null;
}

/** Shell-quote one argument for the owner commands. */
export const shq = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`;

/**
 * The exact owner commands per closable category: a loop of `gh pr close`
 * with the comment, guarded so a PR is closed only while the rule still
 * holds (in-main / in-train: its head is an ancestor of origin/main).
 */
export function ownerCommands(rows, repo) {
  const nums = (cat) => rows.filter((r) => r.category === cat).map((r) => r.number);
  const out = {};
  const guardMain = (list) =>
    list.length
      ? [
          "git fetch -q origin main",
          `for n in ${list.join(" ")}; do`,
          `  sha=$(gh pr view "$n" -R ${repo} --json headRefOid -q .headRefOid)`,
          `  git merge-base --is-ancestor "$sha" origin/main || { echo "#$n: not in main yet, kept"; continue; }`,
          `  gh pr close "$n" -R ${repo} --comment ${shq(closeComment({ category: "in-main" }))}`,
          "done",
        ].join("\n")
      : "";
  out["in-main"] = guardMain(nums("in-main"));
  out["in-train"] = guardMain(nums("in-train"));
  const sup = rows.filter((r) => r.category === "superseded");
  out.superseded = sup.map((r) => `gh pr close ${r.number} -R ${repo} --comment ${shq(closeComment(r))}`).join("\n");
  return out;
}
