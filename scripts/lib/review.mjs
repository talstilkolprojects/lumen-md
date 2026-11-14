/**
 * Pure helpers for `scripts/review-triage.mjs` and `scripts/review-reply.mjs`:
 * reading review comments, the decisions table of docs/dev/lanes.md, and the
 * reply bodies. No fs, no network, no process.exit — the CLIs do that.
 */

/** Verdicts a decisions table may use (docs/dev/lanes.md). */
export const VERDICTS = ["fixed", "already-fixed", "wontfix"];

/**
 * Severity badge of a review comment: Codex writes
 * `![P1 Badge](https://img.shields.io/badge/P1-orange…)`; people write "P1:" or "[P2]".
 * Returns "P0".."P3", or "" when the comment carries none.
 */
export function extractSeverity(body) {
  const s = String(body ?? "");
  const m =
    /!\[(P[0-3])\s+Badge\]/i.exec(s) ??
    /img\.shields\.io\/badge\/(P[0-3])-/i.exec(s) ??
    /^\W{0,4}(P[0-3])\b\W/im.exec(s.split("\n").find((l) => l.trim()) ?? "");
  return m ? m[1].toUpperCase() : "";
}

/** The finding's first line, without badges, HTML, bold markers or links. */
export function findingTitle(body) {
  for (const raw of String(body ?? "").split("\n")) {
    const line = raw
      .replace(/<!--.*?-->/g, "")
      .replace(/!\[[^\]]*\]\([^)]*\)/g, "")
      .replace(/<[^>]+>/g, "")
      .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
      .replace(/\*\*|__|`/g, "")
      .replace(/^\s*(#+|>|[-*])\s+/, "")
      .replace(/^\s*\[?P[0-3]\]?\s*[:\-—]?\s+/, "")
      .replace(/\s+/g, " ")
      .trim();
    if (line) return line;
  }
  return "";
}

/**
 * The lane that owns a path (docs/dev/lanes.md): S storage/sync, A AI/agents,
 * U UI/i18n, D dev tooling/CI/build. "" when no lane claims it.
 */
export function suggestLane(path) {
  const p = String(path ?? "").replace(/^\.\//, "");
  if (/^(src\/(storage|sync|collab|store)|sync-server)\//.test(p)) return "S";
  if (/^src\/(ai|agents|research)\//.test(p)) return "A";
  if (/^(src\/(ui|i18n|components|layouts|views|editor|renderer|plugins)\/|i18n\/)/.test(p)) return "U";
  if (/^(scripts|\.github|ci|build|e2e|src\/build|docs\/dev)\//.test(p)) return "D";
  if (/^(vite\.config\.ts|playwright\.config\.ts|lighthouserc\.json|package(-lock)?\.json|Dockerfile)$/.test(p)) return "D";
  return "";
}

/** Short display name: `chatgpt-codex-connector[bot]` → `codex`, `x[bot]` → `x`. */
export function shortAuthor(login) {
  const s = String(login ?? "?").replace(/\[bot\]$/, "");
  return s === "chatgpt-codex-connector" ? "codex" : s;
}

/** PR number from a review comment's `pull_request_url`. */
export function prFromUrl(url) {
  const m = /\/pulls\/(\d+)\/?$/.exec(String(url ?? ""));
  return m ? Number(m[1]) : null;
}

/**
 * One triage row per unresolved thread.
 * @param {number} pr
 * @param {Array<{resolved:boolean,outdated:boolean,path:string,line:number|null,comment_ids:number[]}>} threads
 *   from `pulls/<N>/ccr/review_threads`
 * @param {Map<number, any>} comments review comments of that PR by id (`pulls/<N>/comments`)
 */
export function triageRows(pr, threads, comments) {
  const rows = [];
  for (const t of threads ?? []) {
    if (t.resolved) continue;
    const ids = t.comment_ids ?? [];
    const first = comments.get(ids[0]);
    const last = comments.get(ids[ids.length - 1]);
    const body = first?.body ?? "";
    rows.push({
      pr,
      comment_id: ids[0] ?? null,
      comment_ids: ids,
      path: t.path ?? first?.path ?? "",
      line: t.line ?? first?.line ?? first?.original_line ?? null,
      outdated: Boolean(t.outdated),
      author: first?.user?.login ?? "?",
      severity: extractSeverity(body),
      title: findingTitle(body),
      replies: Math.max(0, ids.length - 1),
      last_author: last?.user?.login ?? null,
      url: first?.html_url ?? null,
    });
  }
  return rows;
}

/** Rows grouped by file (files sorted, rows by PR then line). */
export function groupByFile(rows) {
  const groups = new Map();
  for (const r of rows) {
    if (!groups.has(r.path)) groups.set(r.path, []);
    groups.get(r.path).push(r);
  }
  return [...groups.entries()]
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([path, list]) => [path, list.sort((x, y) => x.pr - y.pr || (x.line ?? 0) - (y.line ?? 0))]);
}

/**
 * Parse a decisions table: `comment_id<TAB>verdict<TAB>sha<TAB>reason`, one per
 * line. Blank lines, `#` comments and a header row (the first row that is
 * neither, wherever it sits) are skipped. Returns every problem, so a bad
 * table is fixed in one pass instead of posting half of it.
 */
export function parseDecisions(text) {
  const rows = [];
  const errors = [];
  const seen = new Set();
  let first = true;
  String(text ?? "")
    .split(/\r?\n/)
    .forEach((raw, i) => {
      const n = i + 1;
      if (!raw.trim() || raw.trimStart().startsWith("#")) return;
      const cols = raw.split("\t");
      const header = first && /^comment_?id$/i.test(cols[0].trim());
      first = false;
      if (header) return;
      if (cols.length < 4) {
        errors.push(`line ${n}: expected 4 tab-separated columns, got ${cols.length}`);
        return;
      }
      const [idRaw, verdictRaw, shaRaw, ...reasonParts] = cols;
      const id = idRaw.trim();
      const verdict = verdictRaw.trim().toLowerCase();
      const sha = shaRaw.trim();
      const reason = reasonParts.join("\t").trim();
      if (!/^\d+$/.test(id)) errors.push(`line ${n}: comment_id "${id}" is not a number`);
      if (!VERDICTS.includes(verdict)) errors.push(`line ${n}: verdict "${verdict}" is not one of ${VERDICTS.join("|")}`);
      if ((verdict === "fixed" || verdict === "already-fixed") && !/^[0-9a-f]{7,40}$/i.test(sha))
        errors.push(`line ${n}: ${verdict} needs a commit sha (7–40 hex), got "${sha}"`);
      if (verdict === "wontfix" && sha && sha !== "-" && !/^[0-9a-f]{7,40}$/i.test(sha))
        errors.push(`line ${n}: sha "${sha}" should be "-" or a commit sha`);
      if (!reason) errors.push(`line ${n}: reason is empty`);
      if (seen.has(id)) errors.push(`line ${n}: comment ${id} appears twice`);
      seen.add(id);
      rows.push({ line: n, comment_id: Number(id), verdict, sha: sha === "-" ? "" : sha, reason });
    });
  return { rows, errors };
}

/** Reply text for one decision. `prFix` is the PR that carries the fixes. */
export function buildReplyBody({ verdict, sha, reason }, prFix) {
  const why = String(reason ?? "").trim();
  switch (verdict) {
    case "fixed":
      return `Fixed in ${sha} — ${why}\n\nMerged with the other review fixes in #${prFix}.`;
    case "already-fixed":
      return `Already fixed in ${sha} — ${why}\n\nNo further change needed; noted with the other review fixes in #${prFix}.`;
    case "wontfix":
      return `Not changing this — ${why}\n\nLeaving the thread open in case you see it differently (review fixes: #${prFix}).`;
    default:
      throw new Error(`unknown verdict "${verdict}"`);
  }
}

/** Threads that get resolved after the reply: everything but wontfix. */
export const shouldResolve = (verdict) => verdict === "fixed" || verdict === "already-fixed";

/**
 * `reports/review-replied.txt`: one comment id per line once it is fully
 * handled; `<id> replied` when the reply went out but the resolve did not.
 * @returns {Map<number, "done"|"replied">}
 */
export function parseReplied(text) {
  const state = new Map();
  for (const line of String(text ?? "").split(/\r?\n/)) {
    const [id, mark] = line.trim().split(/\s+/);
    if (!/^\d+$/.test(id ?? "")) continue;
    const prev = state.get(Number(id));
    state.set(Number(id), mark === "replied" && prev !== "done" ? "replied" : "done");
  }
  return state;
}
