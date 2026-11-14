#!/usr/bin/env node
/**
 * `npm run review:coverage` (plan W6.11 acceptance: "100% of the sensitive
 * PRs in trains 2 and 3 have a review receipt on the head"). For an
 * integration train, every PR merged into it (first-parent merge commits
 * "Merge #N …") and the train's own integration commits:
 *
 *   - which sensitive files (.github/CODEOWNERS of the train) each changed;
 *   - whether a receipt counts for the head that the train merged (the
 *     merge's second parent), under the same rules as pr:check
 *     (scripts/lib/independentReview.mjs);
 *   - the train's own commits in sensitive files need a receipt for the
 *     train's head (`--train-pr <n>` reads the train PR's comments).
 *
 * Receipts come from PR comments (`--live`, through `gh api`, REST) and/or
 * a folder of receipt files (`--receipts <dir>`, any *.json holding one
 * receipt or a list). Exit 1 below 100%.
 *
 *   node scripts/review-coverage.mjs --train origin/verify/train-2 --base origin/main --receipts ../receipts
 *   node scripts/review-coverage.mjs --train origin/verify/train-2 --base origin/main --live --train-pr 495 --out coverage.md
 *   … --codeowners <file>   (a train without .github/CODEOWNERS yet: use #481's)
 */
import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCodeowners, sensitiveChanges } from "./lib/humanReview.mjs";
import { commentReceipts, independentReviewVerdict, parseReviewers } from "./lib/independentReview.mjs";

const git = (cwd, ...a) => execFileSync("git", a, { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** PR numbers a merge subject names: "Merge #472 …", "Merge #491 + #494 …" (not "with the fixed #399"). */
export function prsOfSubject(subject) {
  const m = /^Merge ((?:#\d+(?:\s*\+\s*)?)+)/.exec(subject);
  return m ? [...m[1].matchAll(/#(\d+)/g)].map((x) => Number(x[1])) : [];
}

/** Receipt files in `dir` → [{ source, receipt }]. */
export function receiptFiles(dir) {
  const out = [];
  if (!dir || !existsSync(dir)) return out;
  for (const n of readdirSync(dir).filter((f) => f.endsWith(".json")).sort()) {
    let doc;
    try {
      doc = JSON.parse(readFileSync(join(dir, n), "utf8"));
    } catch (e) {
      out.push({ source: `\`${n}\``, receipt: { error: `cannot read ${n} as JSON (${e.message})` } });
      continue;
    }
    for (const receipt of Array.isArray(doc) ? doc : [doc]) out.push({ source: `\`${n}\``, receipt });
  }
  return out;
}

/**
 * What the train holds, from git alone:
 * → { head, prs: [{ number, merge, head, files }], own: [{ sha, subject, files }] }
 */
export function trainContents(cwd, train, base) {
  const head = git(cwd, "rev-parse", train).trim();
  const prs = [];
  const own = [];
  const seen = new Set();
  // A train merged into a train ("Merge origin/verify/train into verify/train-2"): walk its first parent too.
  const walk = (...range) => {
    const lines = git(cwd, "log", "--first-parent", "--format=%H%x09%P%x09%s", ...range).split("\n").filter(Boolean);
    for (const line of lines) {
      const [sha, parents, subject] = line.split("\t");
      if (seen.has(sha)) continue;
      seen.add(sha);
      const ps = parents.split(" ");
      const files = git(cwd, "diff", "--name-only", ps[0], sha).split("\n").filter(Boolean);
      const numbers = ps.length > 1 ? prsOfSubject(subject) : [];
      if (numbers.length) {
        for (const number of numbers) if (!prs.some((p) => p.number === number)) prs.push({ number, merge: sha, head: ps[1], files });
      } else if (ps.length === 1) own.push({ sha, subject, files });
      else if (/verify\//.test(subject)) walk(`^${base}`, `^${ps[0]}`, ps[1]);
    }
  };
  walk(`${base}..${train}`);
  return { head, prs, own };
}

/**
 * The coverage table.
 *   contents: trainContents(...)
 *   entries: parseCodeowners(train's CODEOWNERS)
 *   receiptsFor(number) → [{ source, receipt, rejected? }] (comments of PR `number`, plus files whose receipt names it)
 *   files: receiptFiles(...) (matched to a PR by `pr` or by `head`)
 * → { rows: [{ what, head, sensitive, status, line }], sensitiveCount, covered, percent }
 */
export function coverageOf(contents, entries, { receiptsFor = () => [], files = [], reviewers = null, trainPr = null } = {}) {
  const rows = [];
  const pick = (number, head) => [...receiptsFor(number), ...files.filter((f) => f.receipt && (f.receipt.pr === number || f.receipt.head === head))];
  for (const p of contents.prs) {
    const sensitive = sensitiveChanges(p.files, entries);
    if (!sensitive.length) continue;
    const v = independentReviewVerdict(sensitive, pick(p.number, p.head), { head: p.head, strict: true, reviewers });
    rows.push({ what: `#${p.number}`, head: p.head, sensitive: sensitive.length, status: v.status, line: v.lines[0] });
  }
  const ownSensitive = [...new Set(contents.own.flatMap((c) => sensitiveChanges(c.files, entries).map((s) => s.file)))].map((file) => ({ file, pattern: "" }));
  if (ownSensitive.length) {
    const v = independentReviewVerdict(ownSensitive, trainPr ? pick(trainPr, contents.head) : files.filter((f) => f.receipt?.head === contents.head), { head: contents.head, strict: true, reviewers });
    rows.push({ what: `train's own commits${trainPr ? ` (#${trainPr})` : ""}`, head: contents.head, sensitive: ownSensitive.length, status: v.status, line: v.lines[0] });
  }
  const covered = rows.filter((r) => r.status === "ok").length;
  return { rows, sensitiveCount: rows.length, covered, percent: rows.length ? Math.round((1000 * covered) / rows.length) / 10 : 100 };
}

export function coverageMarkdown(c, train) {
  return [
    `## Independent review coverage of \`${train}\` (plan W6.11)`,
    "",
    `${c.covered} of ${c.sensitiveCount} sensitive change sets have a receipt that counts for the head the train holds: **${c.percent}%**.`,
    "",
    "| Change | Head | Sensitive files | Receipt |",
    "|---|---|---|---|",
    ...c.rows.map((r) => `| ${r.what} | \`${r.head.slice(0, 9)}\` | ${r.sensitive} | ${r.status === "ok" ? "✅" : "❌"} ${r.line.replace(/\|/g, "\\|")} |`),
  ].join("\n");
}

const ghJson = (args) => JSON.parse(execFileSync("gh", ["api", ...args], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }));

function main(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  const cwd = resolve(opt("--cwd") ?? process.cwd());
  const train = opt("--train");
  const base = opt("--base") ?? "origin/main";
  if (!train) {
    console.error("usage: review-coverage.mjs --train <ref> [--base <ref>] [--codeowners <file>] [--receipts <dir>] [--live --repo owner/name] [--train-pr <n>] [--out <file>]");
    return 2;
  }
  const contents = trainContents(cwd, train, base);
  // The train's CODEOWNERS, or --codeowners <file> for a train that doesn't carry one yet.
  const entries = parseCodeowners(opt("--codeowners") ? readFileSync(opt("--codeowners"), "utf8") : git(cwd, "show", `${contents.head}:.github/CODEOWNERS`));
  let reviewers = null;
  try {
    reviewers = parseReviewers(git(cwd, "show", `${contents.head}:security/reviewers.json`));
  } catch {
    reviewers = null;
  }
  const repo = opt("--repo") ?? "talstilkol/lumen-md";
  const receiptsFor = argv.includes("--live")
    ? (n) => commentReceipts(ghJson(["--paginate", `repos/${repo}/issues/${n}/comments?per_page=100`]).map((c) => ({ id: c.id, user: c.user?.login, association: c.author_association, body: c.body ?? "" })))
    : () => [];
  const c = coverageOf(contents, entries, { receiptsFor, files: receiptFiles(opt("--receipts")), reviewers, trainPr: opt("--train-pr") ? Number(opt("--train-pr")) : null });
  const md = coverageMarkdown(c, train);
  console.log(md);
  if (opt("--out")) writeFileSync(opt("--out"), md + "\n");
  return c.covered === c.sensitiveCount ? 0 : 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
