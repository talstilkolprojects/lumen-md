/**
 * No stacks (plan W6.22): every pull request is based on the train head or
 * on main, is not far behind it, and is not old. Plain JavaScript, shared
 * by scripts/pr-check.mjs, scripts/restack.mjs and their tests.
 *
 * Stacks 58 deep made conflicts, doubled histories (M419), criss-cross
 * merges (M383, M398) and about 50 hand resolutions in train 2 (E23).
 */

/** An integration train branch: verify/train, verify/train-2, … (not probes or bisects). */
export const TRAIN_RE = /^verify\/train(?:-(\d+))?$/;
/** The bases a PR may have besides the current train. */
export const TRUNKS = ["main"];
/** Defaults: a PR's merge base older than this fails pr:check (plan W6.22 step 2). */
export const MAX_AGE_DAYS = 7;

/** Branch name without a remote prefix: origin/verify/train-2 → verify/train-2. */
export const branchName = (ref, remotes = ["origin"]) => {
  for (const r of remotes) if (ref.startsWith(`${r}/`)) return ref.slice(r.length + 1);
  return ref.replace(/^refs\/(?:heads|remotes\/[^/]+)\//, "");
};

/** The train number: verify/train → 1, verify/train-2 → 2; null for anything else. */
export function trainNumber(branch) {
  const m = TRAIN_RE.exec(branch);
  return m ? Number(m[1] ?? 1) : null;
}

/** The current train among branch names: the highest-numbered verify/train(-N), or null. */
export function currentTrain(branches) {
  let best = null;
  for (const b of branches) {
    const n = trainNumber(b);
    if (n != null && (best == null || n > best.n)) best = { n, branch: b };
  }
  return best?.branch ?? null;
}

/**
 * The base rule → { status: "ok" | "warn", line }. A PR's base must be the
 * current train or main. Another branch (a feat/* under a stack, an older
 * train) warns, with how to fix it.
 */
export function baseVerdict(base, train) {
  const allowed = [...(train ? [train] : []), ...TRUNKS];
  if (allowed.includes(base)) return { status: "ok", line: `The base \`${base}\` is ${base === train ? "the current train" : "the trunk"}.` };
  const older = trainNumber(base) != null ? ` (an older train; the current one is \`${train}\`)` : "";
  return { status: "warn", line: `The base \`${base}\`${older} is not ${allowed.map((b) => `\`${b}\``).join(" or ")}: a stacked PR. Restack it onto the train head: \`node scripts/restack.mjs --branch <this branch> --base ${base}\` prints the commands.` };
}

/**
 * Drift and age → [{ status, line }].
 * - behind: commits on the base that this branch does not have (a warning).
 * - ageDays: how old the merge base is; over maxAgeDays fails.
 * - mergeBases: more than one is a criss-cross merge, which fails.
 */
export function driftVerdicts({ base, behind, ageDays, mergeBases, maxAgeDays = MAX_AGE_DAYS, ageOf = base }) {
  const out = [];
  if (mergeBases > 1) out.push({ status: "fail", line: `Criss-cross: ${mergeBases} merge bases with \`${ageOf}\`. Merge \`${ageOf}\` into the branch once more, or restack it.` });
  if (ageDays > maxAgeDays) out.push({ status: "fail", line: `The merge base with \`${ageOf}\` is ${Math.floor(ageDays)} days old (limit ${maxAgeDays}). Merge or restack onto the head of \`${base}\`.` });
  if (behind > 0) out.push({ status: "warn", line: `${behind} commit${behind === 1 ? "" : "s"} behind \`${base}\`. Merge or restack onto its head before the train.` });
  if (!out.length) out.push({ status: "ok", line: `Up to date with \`${base}\`; the merge base with \`${ageOf}\` is ${Math.floor(ageDays)} day${Math.floor(ageDays) === 1 ? "" : "s"} old (limit ${maxAgeDays}).` });
  return out;
}

/** The worst status of a list: fail > warn > ok. */
export const worst = (xs) => (xs.some((x) => x.status === "fail") ? "fail" : xs.some((x) => x.status === "warn") ? "warn" : "ok");

const q = (s) => (/^[\w./@:+-]+$/.test(s) ? s : `'${String(s).replace(/'/g, `'\\''`)}'`);

/**
 * The commands that move a stacked branch onto the train head.
 * Only the branch's own commits (oldBase..branch) are replayed, onto the
 * train, into a new branch: `restack/<branch>`. Nothing is force-pushed
 * and no PR's base is changed: the new branch gets its own PR, which
 * supersedes the old one. When the old base's own work is not in the
 * train yet, the plan is blocked: the branch would lose code it builds on.
 *
 * input: { branch, oldBase, train, remote, pr, parentInTrain, ownCommits, merges, alreadyInTrain }
 */
export function restackCommands({ branch, oldBase, train, remote = "origin", pr = null, parentInTrain = true, ownCommits = null, merges = 0, alreadyInTrain = 0 }) {
  const target = `restack/${branch}`;
  const notes = [];
  if (!parentInTrain) {
    return {
      blocked: true,
      target,
      notes: [`\`${oldBase}\` is not in \`${train}\` yet: \`${branch}\` builds on code the train does not have. Restack \`${oldBase}\` first (or wait for it to land in the train), then this one.`],
      commands: [],
    };
  }
  if (ownCommits != null) notes.push(`${ownCommits} own commit${ownCommits === 1 ? "" : "s"} (\`${oldBase}..${branch}\`)${alreadyInTrain ? `, ${alreadyInTrain} already in the train by patch (git skips them)` : ""}.`);
  if (merges) notes.push(`${merges} merge commit${merges === 1 ? "" : "s"} among them: \`--rebase-merges\` keeps them.`);
  const R = (b) => `${remote}/${b}`;
  const commands = [
    `git fetch ${remote} ${q(train)} ${q(oldBase)} ${q(branch)}`,
    `git switch -c ${q(target)} ${q(R(branch))}`,
    `git rebase${merges ? " --rebase-merges" : ""} --onto ${q(R(train))} ${q(R(oldBase))} ${q(target)}`,
    `npm run pr:check -- --base ${q(R(train))} --no-size`,
    `git push -u ${remote} ${q(target)}`,
  ];
  const title = pr ? `the title of #${pr}` : "the old title";
  commands.push(`# then open a PR ${q(target)} → ${train} with ${title}, and "Supersedes #${pr ?? "<old PR>"}" in its body`);
  return { blocked: false, target, notes, commands };
}

// ───────────── the stack limit (plan W6.22 acceptance) ─────────────

/** The deepest a stack may be: a PR on main or a train is depth 1, a PR on that PR is 2 (plan W6.22: "maximum stack depth: 1"). */
export const MAX_STACK_DEPTH = 1;
/** The day the rule started (#506, 12.11.2026): PRs opened from then on are the "new PRs" of the acceptance. */
export const RULE_SINCE = "2026-11-12";

/** A base that counts as "on main or verify/*" in the acceptance: main, or any integration train. */
export const onTrunkOrTrain = (base) => TRUNKS.includes(base) || TRAIN_RE.test(base);

/**
 * The stack depth of each open PR → Map(number → { depth, chain, root }).
 * prs: [{ number, head, base }]. A PR on main or a train has depth 1. A PR
 * whose base is another open PR's head is one deeper than that PR. A base
 * that is neither (a branch with no open PR, such as chore/dod) is an
 * unknown parent: one level of its own, so the PR has depth 2. `chain` is
 * the PR numbers from the bottom of the stack up to this one; `root` is
 * the base the bottom one sits on. A loop of bases ends where it repeats.
 */
export function stackDepths(prs) {
  const byHead = new Map();
  for (const p of prs) if (!byHead.has(p.head)) byHead.set(p.head, p);
  const memo = new Map();
  const visit = (p, seen) => {
    if (memo.has(p.number)) return memo.get(p.number);
    let r;
    const parent = byHead.get(p.base);
    if (onTrunkOrTrain(p.base)) r = { depth: 1, chain: [p.number], root: p.base };
    else if (!parent || parent.number === p.number || seen.has(parent.number)) r = { depth: 2, chain: [p.number], root: p.base };
    else {
      const up = visit(parent, new Set([...seen, p.number]));
      r = { depth: up.depth + 1, chain: [...up.chain, p.number], root: up.root };
    }
    memo.set(p.number, r);
    return r;
  };
  for (const p of prs) visit(p, new Set());
  return memo;
}

/**
 * The W6.22 acceptance over the open PRs.
 * prs: [{ number, head, base, created_at, title? }]; since: ISO date (RULE_SINCE).
 * → { open, recent, recentOnTrain, maxDepth, legacyMaxDepth, offTrain: [...], tooDeep: [...], ok }
 * Only PRs opened since the rule are judged ("new PRs"); the older ones
 * are counted (legacyMaxDepth) so the weekly restack can be measured.
 */
export function stackReport(prs, { since = RULE_SINCE, maxDepth = MAX_STACK_DEPTH } = {}) {
  const depths = stackDepths(prs);
  const isNew = (p) => !since || String(p.created_at ?? "") >= since;
  const recent = prs.filter(isNew);
  const row = (p) => ({ number: p.number, head: p.head, base: p.base, ...depths.get(p.number) });
  const offTrain = recent.filter((p) => !onTrunkOrTrain(p.base)).map(row);
  const tooDeep = recent.map(row).filter((r) => r.depth > maxDepth);
  const maxOf = (xs) => xs.reduce((m, p) => Math.max(m, depths.get(p.number).depth), 0);
  return {
    open: prs.length,
    recent: recent.length,
    recentOnTrain: recent.length - offTrain.length,
    maxDepth: maxOf(recent),
    legacyMaxDepth: maxOf(prs.filter((p) => !isNew(p))),
    offTrain,
    tooDeep,
    ok: offTrain.length === 0 && tooDeep.length === 0,
  };
}
