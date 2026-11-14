/**
 * Plan W4.28 (bus factor): a pull request that touches a sensitive path —
 * crypto, vault writes, the privacy ledger, CSP and security policy, the
 * desktop and mobile permissions — needs a human review before Tal merges.
 * Enforced by `npm run pr:check -- --pr <n>` (no GitHub Actions):
 *
 *   - the sensitive paths are the ones `.github/CODEOWNERS` lists (one
 *     source of truth: GitHub also requests the owners' review on them);
 *   - the PR carries the label `human-reviewed`, put on it by a person who
 *     read the diff — never by an agent (CONTRIBUTING.md, agent rules);
 *   - the label is newer than the PR's last commit: a push after the review
 *     needs a new review (remove and re-add the label).
 *
 * Pure functions; pr-check.mjs does the git and `gh api` calls.
 */

export const HUMAN_REVIEW_LABEL = "human-reviewed";

/** CODEOWNERS text → [{ pattern, owners }] in file order (comments and blanks dropped). */
export function parseCodeowners(text) {
  const out = [];
  for (const raw of String(text ?? "").split(/\r?\n/)) {
    const line = raw.replace(/(^|\s)#.*$/, "").trim();
    if (!line) continue;
    const [pattern, ...owners] = line.split(/\s+/);
    out.push({ pattern, owners });
  }
  return out;
}

function escape(s) {
  return s.replace(/[.+^${}()|[\]\\]/g, "\\$&");
}

/**
 * Does a CODEOWNERS pattern match a repository path (POSIX, no leading /)?
 * The gitignore rules GitHub uses: a leading `/` anchors at the root, a
 * pattern without a `/` in the middle matches at any depth, a trailing `/`
 * matches everything under that folder, `*` stays within one segment and
 * `**` crosses segments.
 */
export function codeownersMatch(pattern, file) {
  let p = pattern.trim();
  const dirOnly = p.endsWith("/");
  if (dirOnly) p = p.slice(0, -1);
  const anchored = p.startsWith("/") || p.slice(0, -1).includes("/");
  if (p.startsWith("/")) p = p.slice(1);
  let re = "";
  for (let i = 0; i < p.length; i++) {
    const c = p[i];
    if (c === "*" && p[i + 1] === "*") {
      const slash = p[i + 2] === "/";
      re += slash ? "(?:.*/)?" : ".*";
      i += slash ? 2 : 1;
    } else if (c === "*") re += "[^/]*";
    else if (c === "?") re += "[^/]";
    else re += escape(c);
  }
  const head = anchored ? "^" : "^(?:.*/)?";
  // A folder pattern (or any pattern that names a folder) covers what is under it.
  const tail = dirOnly ? "/.*$" : "(?:/.*)?$";
  return new RegExp(head + re + tail).test(file);
}

/** Changed files that some CODEOWNERS entry covers → [{ file, pattern }]. */
export function sensitiveChanges(changed, entries) {
  const out = [];
  for (const file of changed) {
    // The last matching entry wins in CODEOWNERS; any match makes it sensitive.
    let hit = null;
    for (const e of entries) if (e.owners.length && codeownersMatch(e.pattern, file)) hit = e.pattern;
    if (hit) out.push({ file, pattern: hit });
  }
  return out;
}

/**
 * The verdict for one PR.
 *   sensitive: sensitiveChanges(...)
 *   pr: null (no --pr given) or { number, labels: string[], events: [{ event, label, created_at, actor }], headDate, reviews: [{ user, state, submitted_at, commit_id }], author, headSha }
 * → { status: "ok" | "warn" | "fail", lines: string[] }
 */
export function humanReviewVerdict(sensitive, pr, label = HUMAN_REVIEW_LABEL) {
  if (!sensitive.length) return { status: "ok", lines: ["No sensitive path (`.github/CODEOWNERS`) changed."] };
  const list = sensitive.slice(0, 15).map((s) => `- \`${s.file}\` (\`${s.pattern}\`)`);
  if (sensitive.length > 15) list.push(`- and ${sensitive.length - 15} more`);
  if (!pr) {
    return {
      status: "warn",
      lines: [`${sensitive.length} sensitive file${sensitive.length === 1 ? "" : "s"} changed: a person must review the diff and add the \`${label}\` label. Before merging, run with \`--pr <number>\`; it fails until the label is there.`, "", ...list],
    };
  }
  const lines = [];
  if (!pr.labels.includes(label)) {
    return { status: "fail", lines: [`PR #${pr.number} changes ${sensitive.length} sensitive file${sensitive.length === 1 ? "" : "s"} and has no \`${label}\` label. A person reviews the diff, then adds it (an agent never does).`, "", ...list] };
  }
  const added = pr.events.filter((e) => e.event === "labeled" && e.label === label).map((e) => e.created_at).sort();
  const last = added[added.length - 1];
  if (!last) return { status: "fail", lines: [`The \`${label}\` label is on PR #${pr.number} but its "labeled" event is missing; remove and re-add it.`, "", ...list] };
  if (pr.headDate && Date.parse(last) < Date.parse(pr.headDate)) {
    return { status: "fail", lines: [`\`${label}\` was added ${last}, before the last commit (${pr.headDate}): the new commits were not reviewed. Review them, then remove and re-add the label.`, "", ...list] };
  }
  const who = pr.events.filter((e) => e.event === "labeled" && e.label === label && e.created_at === last).map((e) => e.actor).filter(Boolean);
  lines.push(`\`${label}\` added ${last}${who.length ? ` by @${who[0]}` : ""}, after the last commit (${pr.headDate ?? "unknown"}).`);
  const approvals = (pr.reviews ?? []).filter((r) => r.state === "APPROVED" && r.user && r.user !== pr.author && (!pr.headSha || r.commit_id === pr.headSha));
  lines.push(approvals.length ? `Approved on the head commit by a second account: ${[...new Set(approvals.map((r) => `@${r.user}`))].join(", ")}.` : "No approval from a second account yet (the second maintainer's review: CONTRIBUTING.md).", "", ...list);
  return { status: "ok", lines };
}
