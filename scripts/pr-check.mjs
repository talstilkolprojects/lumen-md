#!/usr/bin/env node
/**
 * `npm run pr:check` (plan 0.19): the PR gate, run locally. It replaces
 * Danger.js and size-limit, which need GitHub Actions; this repo runs none
 * on a PR. One Markdown report (paste it into the PR, or --out a file):
 *
 *   - Bundle size: `bundle-budget.mjs --json` of this build against the
 *     base's, as a table (scripts/bundle-diff.mjs), plus the budget's own
 *     verdict. The base's sizes come from --base-sizes, or --build-base
 *     builds the merge base in a temporary worktree.
 *   - Commits: every subject in base..HEAD carries [skip ci].
 *   - PR body (--body FILE): every required section, none empty.
 *   - New network calls must be in the privacy ledger
 *     (src/ai/privacyLedger.ts) or carry `// privacy-ledger: <rule>`.
 *   - Production packages added or changed, with their licence.
 *   - Source changed with no test changed (a warning).
 *   - Added lines that name the project's domain (the owner's rule).
 *   - Written by an AI agent → the PR wants the `ai-written` label.
 *   - Sensitive paths (.github/CODEOWNERS) changed → a person reviews and
 *     adds the `human-reviewed` label (plan W4.28). With `--pr <n>` the
 *     label is read from GitHub and must be newer than the last commit;
 *     without it the rule only warns.
 *   - The same paths need an independent review receipt for the head
 *     commit (plan W6.11): a `lumen-review` block in a PR comment (read with
 *     `--pr`) or a JSON file (`--review <file>`, repeatable), by a reviewer
 *     that is not the author, with attack tests and no critical or high
 *     finding open. A new push makes older receipts stale.
 *   - Budgets only go down (plan W6.26): no bundle budget, startup budget,
 *     exception date, perf-gate FCP/LCP limit or Lighthouse assertion loosened.
 *
 *   npm run pr:check -- --base origin/main --body pr-body.md
 *   npm run build && npm run pr:check -- --base origin/main --body pr-body.md --build-base --out pr-check.md
 *   npm run pr:check -- --base origin/main --pr 123 --no-size     # before merging
 *   npm run pr:check -- --base origin/verify/train-2 --review review.json --no-size   # offline
 *
 * Exit 1 when a check fails; warnings do not fail.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { addedLinesFromDiff, AI_LABEL, bodyProblems, domainMentions, licenceChanges, skipCiViolations, unregisteredNetworkCalls, untestedChanges, writtenByAi } from "./lib/prGate.mjs";
import { bundleDiffMarkdown } from "./bundle-diff.mjs";
import { HUMAN_REVIEW_LABEL, humanReviewVerdict, parseCodeowners, sensitiveChanges } from "./lib/humanReview.mjs";
import { extractReceipts, independentReviewVerdict } from "./lib/independentReview.mjs";
import { RATCHET_FILES, raiseLine, raisesFor } from "./lib/budgetRatchet.mjs";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    base: opt("--base") ?? "origin/main",
    body: opt("--body"),
    out: opt("--out"),
    baseSizes: opt("--base-sizes"),
    headSizes: opt("--head-sizes"),
    buildBase: argv.includes("--build-base"),
    noSize: argv.includes("--no-size"),
    pr: opt("--pr"),
    review: argv.flatMap((a, i) => (a === "--review" && argv[i + 1] ? [argv[i + 1]] : [])),
    repo: opt("--repo"),
    cwd: resolve(opt("--cwd") ?? process.cwd()),
  };
}

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** `bundle-budget.mjs --json` in `dir` (which must hold dist/) → { sizes, budgetOk }. */
function budget(dir, script) {
  const tmp = mkdtempSync(join(tmpdir(), "lumen-sizes-"));
  try {
    const f = join(tmp, "sizes.json");
    const r = spawnSync(process.execPath, [script, "--json", f], { cwd: dir, encoding: "utf8" });
    if (!existsSync(f)) throw new Error(`bundle-budget wrote no sizes in ${dir} (is dist/ built?): ${(r.stderr || r.stdout).trim().split("\n").pop()}`);
    return { sizes: JSON.parse(readFileSync(f, "utf8")), budgetOk: r.status === 0, budgetLog: r.stdout };
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

/** Build the merge base in a temporary worktree (this checkout's node_modules linked in) → its sizes. */
function buildBase(cwd, mergeBase) {
  const dir = mkdtempSync(join(tmpdir(), "lumen-base-"));
  try {
    git(cwd, "worktree", "add", "--detach", dir, mergeBase);
    symlinkSync(join(cwd, "node_modules"), join(dir, "node_modules"), "dir");
    const b = spawnSync("npm", ["run", "build"], { cwd: dir, stdio: "inherit", shell: process.platform === "win32" });
    if (b.status !== 0) throw new Error(`building the base ${mergeBase.slice(0, 9)} failed`);
    // The base's own budget script: its classes are what it measured with.
    return budget(dir, join(dir, "scripts", "bundle-budget.mjs")).sizes;
  } finally {
    spawnSync("git", ["worktree", "remove", "--force", dir], { cwd });
    rmSync(dir, { recursive: true, force: true });
  }
}

/** owner/name of the GitHub repository (from --repo, or the origin remote). */
function repoOf(cwd, given) {
  if (given) return given;
  const url = git(cwd, "remote", "get-url", "origin").trim();
  // github.com URLs, and proxies that keep owner/name as the last two segments.
  const m = url.match(/github\.com[:/]+([^/]+\/[^/]+?)(?:\.git)?\/?$/) ?? url.match(/\/([^/:]+\/[^/]+?)(?:\.git)?\/?$/);
  if (!m) throw new Error(`cannot tell the GitHub repository from the origin remote (${url}); pass --repo owner/name`);
  return m[1];
}

const ghJson = (args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));

/** What the human-review rule needs about PR `n`, read with `gh api` (REST only). */
export function loadPr(repo, n) {
  const pull = ghJson([`repos/${repo}/pulls/${n}`]);
  const events = ghJson(["--paginate", `repos/${repo}/issues/${n}/events?per_page=100`]).map((e) => ({ event: e.event, label: e.label?.name, created_at: e.created_at, actor: e.actor?.login }));
  const reviews = ghJson(["--paginate", `repos/${repo}/pulls/${n}/reviews?per_page=100`]).map((r) => ({ user: r.user?.login, state: r.state, submitted_at: r.submitted_at, commit_id: r.commit_id }));
  const comments = ghJson(["--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`]).map((c) => ({ id: c.id, user: c.user?.login, created_at: c.created_at, body: c.body ?? "" }));
  const head = ghJson([`repos/${repo}/commits/${pull.head.sha}`]);
  return { number: Number(n), labels: pull.labels.map((l) => l.name), events, reviews, comments, author: pull.user?.login, headSha: pull.head.sha, headDate: head.commit?.committer?.date ?? null };
}

/** Every check → { sections: [{ title, status: "ok" | "warn" | "fail" | "skipped", lines }], failed }. */
export function runChecks(opts) {
  const { cwd } = opts;
  const mergeBase = git(cwd, "merge-base", opts.base, "HEAD").trim();
  const range = `${mergeBase}..HEAD`;
  const sections = [];
  const add = (title, status, lines = []) => sections.push({ title, status, lines });

  // Commits
  const subjects = git(cwd, "log", "--format=%s", range).split("\n").filter(Boolean);
  const noSkip = skipCiViolations(subjects);
  add("Commits carry [skip ci]", noSkip.length ? "fail" : "ok", noSkip.length ? noSkip.map((s) => `- \`${s}\``) : [`${subjects.length} commit${subjects.length === 1 ? "" : "s"}, all with [skip ci].`]);

  // Body
  let body = null;
  if (opts.body) {
    body = readFileSync(resolve(cwd, opts.body), "utf8");
    const p = bodyProblems(body);
    add("PR body sections", p.length ? "fail" : "ok", p.length ? p.map((x) => `- ${x}`) : ["Every required section is there and not empty."]);
  } else add("PR body sections", "skipped", ["Pass the body with `--body <file>`."]);

  // Diff-based rules
  const diff = git(cwd, "diff", "-U2", "--no-color", `${mergeBase}...HEAD`);
  const added = addedLinesFromDiff(diff);
  const changed = git(cwd, "diff", "--name-only", `${mergeBase}...HEAD`).split("\n").filter(Boolean);
  const ledgerFile = join(cwd, "src", "ai", "privacyLedger.ts");
  if (existsSync(ledgerFile)) {
    const v = unregisteredNetworkCalls(added, readFileSync(ledgerFile, "utf8"));
    add("Network calls in the privacy ledger", v.length ? "fail" : "ok", v.length ? v.map((x) => `- \`${x.file}:${x.line}\` ${x.why}: \`${x.text.slice(0, 120)}\``) : ["No new network call outside the ledger."]);
  } else add("Network calls in the privacy ledger", "skipped", ["src/ai/privacyLedger.ts is not on this branch."]);

  const dom = domainMentions(added);
  add("The project's domain", dom.length ? "fail" : "ok", dom.length ? dom.map((x) => `- \`${x.file}:${x.line}\``) : ["Not named in any added line."]);

  // Human review of sensitive paths (plan W4.28)
  const ownersFile = join(cwd, ".github", "CODEOWNERS");
  if (existsSync(ownersFile)) {
    const sensitive = sensitiveChanges(changed, parseCodeowners(readFileSync(ownersFile, "utf8")));
    let pr = null;
    let mismatch = null;
    if (opts.pr && sensitive.length) {
      pr = opts.loadPr ? opts.loadPr(opts.repo, opts.pr) : loadPr(repoOf(cwd, opts.repo), opts.pr);
      const local = git(cwd, "rev-parse", "HEAD").trim();
      if (pr.headSha && pr.headSha !== local) mismatch = `This checkout's HEAD (\`${local.slice(0, 9)}\`) is not PR #${pr.number}'s head (\`${pr.headSha.slice(0, 9)}\`): fetch the PR branch and run again.`;
    }
    const v = humanReviewVerdict(sensitive, pr, HUMAN_REVIEW_LABEL);
    add("Human review of sensitive paths", mismatch ? "fail" : v.status, mismatch ? [mismatch, "", ...v.lines] : v.lines);

    // Independent review receipt for the head (plan W6.11)
    const receipts = [];
    for (const c of pr?.comments ?? []) for (const receipt of extractReceipts(c.body)) receipts.push({ source: `comment${c.id ? ` ${c.id}` : ""} by @${c.user ?? "?"}`, receipt });
    for (const f of opts.review ?? []) {
      let receipt;
      try {
        receipt = JSON.parse(readFileSync(resolve(cwd, f), "utf8"));
      } catch (e) {
        receipt = { error: `cannot read ${f} as JSON (${e.message})` };
      }
      receipts.push({ source: `\`${f}\``, receipt });
    }
    const head = pr?.headSha ?? git(cwd, "rev-parse", "HEAD").trim();
    const iv = independentReviewVerdict(sensitive, receipts, { head, strict: !!opts.pr || (opts.review ?? []).length > 0 });
    add("Independent review of sensitive paths", mismatch ? "fail" : iv.status, mismatch ? [mismatch, "", ...iv.lines] : iv.lines);
  } else {
    add("Human review of sensitive paths", "skipped", [".github/CODEOWNERS is not on this branch."]);
    add("Independent review of sensitive paths", "skipped", [".github/CODEOWNERS is not on this branch."]);
  }

  const untested = untestedChanges(changed);
  add("Tests", untested.length ? "warn" : "ok", untested.length ? [`Source changed and no test changed: ${untested.slice(0, 10).map((f) => `\`${f}\``).join(", ")}${untested.length > 10 ? ` and ${untested.length - 10} more` : ""}.`] : ["Source changes come with test changes (or there are none)."]);

  // Licences
  if (changed.includes("package-lock.json")) {
    const baseLock = JSON.parse(git(cwd, "show", `${mergeBase}:package-lock.json`));
    const headLock = JSON.parse(readFileSync(join(cwd, "package-lock.json"), "utf8"));
    const rows = licenceChanges(baseLock, headLock);
    const bad = rows.filter((r) => r.level === "fail");
    add("Licences of production packages", bad.length ? "fail" : rows.some((r) => r.level === "warn") ? "warn" : "ok", rows.length ? ["| Package | Version | Licence | Before | |", "|---|---|---|---|---|", ...rows.map((r) => `| ${r.name} | ${r.version} | ${r.license} | ${r.previous ?? "new"} | ${r.level} |`)] : ["The lockfile changed, no production package did."]);
  } else add("Licences of production packages", "ok", ["package-lock.json is unchanged."]);

  // Budgets only go down (W6.26): every ratchet file the diff changes, against the merge base.
  {
    const raised = [];
    const touched = RATCHET_FILES.filter((f) => changed.includes(f));
    for (const f of touched) {
      let before = null;
      try {
        before = git(cwd, "show", `${mergeBase}:${f}`);
      } catch {
        // why: the base has no such file yet — this diff introduces it, so there is nothing to raise.
      }
      const after = existsSync(join(cwd, f)) ? readFileSync(join(cwd, f), "utf8") : null;
      if (before != null && after == null) raised.push(`- \`${f}\` was deleted.`);
      else if (before != null) raised.push(...raisesFor(f, before, after).map((x) => raiseLine(f, x)));
    }
    // The numbers live in the JSON: a number written into the enforcer itself would bypass the check.
    for (const a of added["scripts/bundle-budget.mjs"] ?? []) {
      if (/\bbudgetKb\s*:\s*\d|STARTUP_BUDGET_KB\s*=\s*\d/.test(a.text)) raised.push(`- \`scripts/bundle-budget.mjs:${a.line}\` sets a budget in code; budgets live in \`scripts/bundle-budgets.json\`.`);
    }
    add("Budgets only go down", raised.length ? "fail" : "ok", raised.length ? [...raised, "", "A budget is never raised: split the chunk, load it lazily, or make the page faster."] : [touched.length ? `${touched.map((f) => `\`${f}\``).join(", ")}: nothing raised.` : "No budget file changed."]);
  }

  // AI label
  const messages = git(cwd, "log", "--format=%B%x1e", range).split("\x1e");
  if (writtenByAi(body, messages)) add("Label", "warn", [`Written by an AI agent: add the \`${AI_LABEL}\` label.`]);

  // Bundle size
  if (opts.noSize) add("Bundle size", "skipped", ["--no-size"]);
  else {
    try {
      const head = opts.headSizes ? { sizes: JSON.parse(readFileSync(opts.headSizes, "utf8")), budgetOk: null } : existsSync(join(cwd, "dist", "assets")) ? budget(cwd, join(cwd, "scripts", "bundle-budget.mjs")) : null;
      if (!head) add("Bundle size", "skipped", ["dist/ is not built: run `npm run build` first (or pass --head-sizes)."]);
      else {
        const baseSizes = opts.baseSizes ? JSON.parse(readFileSync(opts.baseSizes, "utf8")) : opts.buildBase ? buildBase(cwd, mergeBase) : null;
        const table = bundleDiffMarkdown(baseSizes, head.sizes, opts.base.replace(/^origin\//, "")).split("\n").filter((l) => !l.startsWith("<!--") && !l.startsWith("###"));
        add("Bundle size", head.budgetOk === false ? "fail" : "ok", [...table, "", head.budgetOk === false ? "**The bundle budget (`npm run budget`) fails.**" : head.budgetOk ? "The bundle budget passes." : ""]);
      }
    } catch (e) {
      add("Bundle size", "fail", [String(e.message)]);
    }
  }
  return { base: opts.base, mergeBase, sections, failed: sections.some((s) => s.status === "fail") };
}

const ICON = { ok: "✅", warn: "⚠️", fail: "❌", skipped: "➖" };

export function report(r) {
  const lines = ["<!-- lumen-pr-check -->", `## PR check (plan 0.19)`, "", `Against \`${r.base}\` (merge base \`${r.mergeBase.slice(0, 9)}\`). Replaces Danger: run \`npm run pr:check\`.`, ""];
  lines.push("| | Check |", "|---|---|", ...r.sections.map((s) => `| ${ICON[s.status]} | ${s.title} |`), "");
  for (const s of r.sections) lines.push(`### ${ICON[s.status]} ${s.title}`, "", ...s.lines.filter((l, i, a) => l !== "" || (i && a[i - 1] !== "")), "");
  lines.push(r.failed ? "**PR check: failed.**" : "**PR check: passed.**");
  return lines.join("\n");
}

async function main() {
  const opts = parseArgs(process.argv.slice(2));
  const r = runChecks(opts);
  const md = report(r);
  console.log(md);
  if (opts.out) writeFileSync(opts.out, md + "\n");
  process.exit(r.failed ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) await main();
