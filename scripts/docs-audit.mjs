#!/usr/bin/env node
/**
 * docs-audit (plan 13.1): every finished task writes its own docs page.
 *
 * docs-complete checks the docs tree on its own. This asks the other
 * question: which finished plan tasks changed what a user sees, but wrote
 * no page? A task counts as having a page when one of its pull requests
 * changed an English page under docs/src/content/docs/, or when
 * docs/required-pages.json `tasks` names its page (docs-complete then
 * checks that the page exists and is in the sidebar). `tasksWithoutPage`
 * there lists the few the audit flags that change nothing a user reads
 * about (code moved as is), each with its reason.
 *
 * - A task's pull requests: those whose title names its id ("(plan 4.5)",
 *   "(W6.22)"), plus the plan's `pr` field.
 * - Finished: the status starts with ✅, says the code is done
 *   ("קוד גמור"), or `verified` is "built" or "verified".
 * - Changed what a user sees: a .tsx file under src/, a file under
 *   src/components/, or a new English UI string (src/i18n/locales/en/,
 *   src/i18n/lazy/). Tests and generated help are not counted.
 * - With --ref, only pull requests whose head is in that ref count, so the
 *   audit of a train asks only about the code the train has.
 *
 *   npm run docs:audit                                  # this checkout's plan, HEAD, GitHub
 *   npm run docs:audit -- --plan-ref origin/chore/dod   # the newest plan
 *   npm run docs:audit -- --prs prs.jsonl --json        # PRs from a file, the report as JSON
 *
 * --prs reads one JSON object per line: { n, t (title), s (state), m
 * (merged), h (head sha), b (base sha) }, as the GitHub REST list gives
 * them. Without it the list comes from `gh api` (REST). A PR's files come
 * from `git diff base...head` when both commits are here, else from
 * `gh api repos/<repo>/pulls/<n>/files`. Reads only; exits 1 when a task
 * has no page.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

/** A plan id: 4.5, 13.1.1, W6.22 (not part of a version like v1.4.2 or a longer number). */
const ID_RE = /(?<![\w.])(W?\d+(?:\.\d+){1,2}[a-z]?)(?![\w.]*\d)/g;

/**
 * The ids of `known` that a pull request title names. Only where titles
 * name tasks: inside parentheses ("(plan 4.5)", "(W8.9, W8.10)") or after
 * the word plan ("plan 6.1 local dictation"), so a number such as
 * "2.0→0.9 MB" is not read as task 0.9.
 */
export function taskIds(title, known) {
  const spots = [...String(title).matchAll(/\(([^)]*)\)|\bplan\s+((?:W?\d+(?:\.\d+)+[a-z]?[\s,&+]*(?:and\s+)?)+)/gi)].map((m) => m[1] ?? m[2]);
  const out = [];
  for (const spot of spots) for (const m of spot.matchAll(ID_RE)) if (known.has(m[1]) && !out.includes(m[1])) out.push(m[1]);
  return out;
}

/** A file whose change a user sees. */
export function isUiFile(path) {
  if (!path.startsWith("src/") || path.startsWith("src/__tests__/") || /\.test\.|\/generated\/|^src\/help\//.test(path)) return false;
  if (/^src\/i18n\/(locales\/en\/|lazy\/)[^/]+\.json$/.test(path)) return true;
  return path.endsWith(".tsx") || (path.startsWith("src/components/") && /\.(ts|tsx)$/.test(path));
}

/** An English docs page (the Hebrew twin is docs-complete's business). */
export const isDocsPage = (path) => /^docs\/src\/content\/docs\/(?!he\/).+\.mdx?$/.test(path);

/** A finished task, by the plan's status and `verified` fields. */
export function isFinished(task) {
  const st = String(task.status ?? "");
  return st.startsWith("✅") || st.includes("קוד גמור") || ["built", "verified"].includes(task.verified);
}

/** Every task in a plan.json, wherever it sits (phases, waves), first occurrence of each id. */
export function planTasks(plan) {
  const seen = new Map();
  const walk = (o) => {
    if (Array.isArray(o)) o.forEach(walk);
    else if (o && typeof o === "object") {
      if (typeof o.id === "string" && typeof o.title === "string" && "minutes" in o && !seen.has(o.id)) seen.set(o.id, o);
      Object.values(o).forEach(walk);
    }
  };
  walk(plan);
  return [...seen.values()];
}

/**
 * The finished tasks with user-visible changes and no page.
 *   tasks:   planTasks(plan)
 *   prs:     [{ n, t, s, m }] (open, or merged; closed unmerged ones are skipped)
 *   filesOf: (n) => [paths] | null (null: unknown, the PR is skipped)
 *   mapped:  { id: slug or reason } from docs/required-pages.json `tasks` and `tasksWithoutPage`
 *   inRef:   (n) => boolean, optional: only PRs in the audited ref count
 * → [{ id, title, prs: [n], ui: [paths] }]
 */
export function audit({ tasks, prs, filesOf, mapped = {}, inRef = () => true }) {
  const known = new Set(tasks.map((t) => t.id));
  const byTask = new Map();
  const add = (id, n) => {
    if (!byTask.has(id)) byTask.set(id, new Set());
    byTask.get(id).add(n);
  };
  const live = new Map(prs.filter((p) => p.s === "open" || p.m).map((p) => [p.n, p]));
  for (const p of live.values()) for (const id of taskIds(p.t, known)) add(id, p.n);
  for (const t of tasks) if (Number.isInteger(t.pr) && live.has(t.pr)) add(t.id, t.pr);
  const out = [];
  for (const t of tasks) {
    if (!isFinished(t) || mapped[t.id]) continue;
    const ns = [...(byTask.get(t.id) ?? [])].filter((n) => inRef(n)).sort((a, b) => a - b);
    const files = ns.map((n) => filesOf(n)).filter(Array.isArray).flat();
    if (!files.length || files.some(isDocsPage)) continue;
    const ui = [...new Set(files.filter(isUiFile))];
    if (ui.length) out.push({ id: t.id, title: t.title, prs: ns, ui });
  }
  return out;
}

/** One line per task, for the console. */
export const formatFinding = (f) => `${f.id} ${f.title} — ${f.prs.map((n) => `#${n}`).join(", ")} changed ${f.ui.length} user-facing file${f.ui.length === 1 ? "" : "s"} (${f.ui.slice(0, 3).join(", ")}${f.ui.length > 3 ? ", …" : ""}) and wrote no page: write it, or name it in docs/required-pages.json "tasks"`;

function main(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
  const repo = opt("--repo") ?? process.env.GH_REPO ?? "talstilkol/lumen-md";
  const git = (...a) => execFileSync("git", a, { cwd: ROOT, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "ignore"] });
  const gh = (path) => JSON.parse(execFileSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 }));
  const plan = JSON.parse(opt("--plan-ref") ? git("show", `${opt("--plan-ref")}:plan/plan.json`) : readFileSync(opt("--plan") ?? join(ROOT, "plan/plan.json"), "utf8"));
  const required = JSON.parse(readFileSync(join(ROOT, "docs/required-pages.json"), "utf8"));
  let prs;
  if (opt("--prs")) prs = readFileSync(opt("--prs"), "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
  else {
    prs = [];
    for (let page = 1; ; page++) {
      const rows = gh(`repos/${repo}/pulls?state=all&per_page=100&page=${page}`);
      prs.push(...rows.map((p) => ({ n: p.number, t: p.title, s: p.state, m: p.merged_at != null, h: p.head.sha, b: p.base.sha })));
      if (rows.length < 100) break;
    }
  }
  const head = new Map(prs.map((p) => [p.n, p]));
  const filesOf = (n) => {
    const p = head.get(n);
    try {
      return git("diff", "--name-only", `${p.b}...${p.h}`).split("\n").filter(Boolean);
    } catch {
      try {
        return gh(`repos/${repo}/pulls/${n}/files?per_page=100`).map((f) => f.filename);
      } catch {
        return null; // why: neither the commits nor the API are reachable; the PR is left out
      }
    }
  };
  const ref = opt("--ref");
  const inRef = (n) => {
    if (!ref) return true;
    try {
      git("merge-base", "--is-ancestor", head.get(n).h, ref);
      return true;
    } catch {
      return false; // why: not an ancestor (or not fetched): the ref does not have this PR's code
    }
  };
  const found = audit({ tasks: planTasks(plan), prs, filesOf, mapped: { ...(required.tasks ?? {}), ...(required.tasksWithoutPage ?? {}) }, inRef });
  if (argv.includes("--json")) process.stdout.write(JSON.stringify(found, null, 2) + "\n");
  else if (found.length) {
    console.error(found.map(formatFinding).join("\n"));
    console.error(`\n✗ docs-audit: ${found.length} finished task(s) without a docs page`);
  } else process.stdout.write("✓ docs-audit: every finished task that changed what a user sees has a docs page\n");
  return found.length ? 1 : 0;
}

if (import.meta.url.startsWith("file:") && process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) process.exitCode = main(process.argv.slice(2));
