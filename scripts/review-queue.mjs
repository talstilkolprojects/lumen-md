#!/usr/bin/env node
/**
 * The weekly sensitive-review queue (plan W6.13), run by a person, not by GitHub Actions:
 *
 *   npm run review:queue                       # up to 5 open PRs, as Markdown, from GitHub (gh api, REST)
 *   npm run review:queue -- --out queue.md     # to a file (paste it in the weekly issue, or send it)
 *   npm run review:queue -- --limit 3
 *   npm run review:queue -- --base verify/train-2   # only the PRs on the current train
 *   npm run review:queue -- --from prs.json    # from a saved snapshot (--save prs.json writes one)
 *
 * It lists the pull requests that change a path in .github/CODEOWNERS and are not
 * human-reviewed after their last commit, riskiest area first, then the oldest, each with the
 * sensitive files, the reviewer's questions, the tests that cover those modules in this
 * checkout, and attack cases. It reads only: no label, comment or review is written.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { buildQueue } from "./lib/reviewQueue.mjs";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const argv = process.argv.slice(2);
const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
const REPO = opt("--repo") ?? "talstilkol/lumen-md";
const limit = Number(opt("--limit") ?? 5);
const onlyBase = opt("--base");

const run = promisify(execFile);
const gh = async (path) => JSON.parse((await run("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 * 1024 * 1024 })).stdout);
const ghAll = async (path) => {
  const out = [];
  for (let page = 1; page < 50; page++) {
    const batch = await gh(`${path}${path.includes("?") ? "&" : "?"}per_page=100&page=${page}`);
    out.push(...batch);
    if (batch.length < 100) break;
  }
  return out;
};

/** Run `fn` over `items`, `n` at a time. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  }));
  return out;
}

async function fetchPrs() {
  const open = await ghAll(`repos/${REPO}/pulls?state=open`);
  return pool(open, 6, async (p) => {
    const files = (await ghAll(`repos/${REPO}/pulls/${p.number}/files`)).map((f) => ({ filename: f.filename, additions: f.additions, deletions: f.deletions }));
    const labels = p.labels.map((l) => l.name);
    let events = [];
    let reviews = [];
    let headDate = null;
    if (labels.includes("human-reviewed")) {
      events = (await ghAll(`repos/${REPO}/issues/${p.number}/events`)).filter((e) => e.event === "labeled").map((e) => ({ event: e.event, label: e.label?.name, created_at: e.created_at, actor: e.actor?.login }));
      reviews = (await ghAll(`repos/${REPO}/pulls/${p.number}/reviews`)).map((r) => ({ user: r.user?.login, state: r.state, submitted_at: r.submitted_at, commit_id: r.commit_id }));
      headDate = (await gh(`repos/${REPO}/commits/${p.head.sha}`)).commit?.committer?.date ?? null;
    }
    return { number: p.number, title: p.title, author: p.user?.login, base: p.base.ref, draft: !!p.draft, createdAt: p.created_at, labels, events, reviews, headSha: p.head.sha, headDate, files };
  });
}

/** module path (repo-relative, no extension) → the test files in src/__tests__ that import it. */
function testIndex() {
  const dir = join(ROOT, "src/__tests__");
  const out = {};
  const walk = (d) => {
    for (const e of readdirSync(d, { withFileTypes: true })) {
      const p = join(d, e.name);
      if (e.isDirectory()) walk(p);
      else if (/\.test\.tsx?$/.test(e.name)) {
        const text = readFileSync(p, "utf8");
        const rel = relative(ROOT, p);
        for (const m of text.matchAll(/(?:from|import\()\s*["'](\.{1,2}\/[^"']+)["']/g)) {
          const mod = relative(ROOT, resolve(dirname(p), m[1])).replace(/\.(tsx?|mjs|js)$/, "");
          (out[mod] ??= []).includes(rel) || out[mod].push(rel);
        }
      }
    }
  };
  walk(dir);
  return out;
}

const prs = opt("--from") ? JSON.parse(readFileSync(resolve(opt("--from")), "utf8")) : await fetchPrs();
if (opt("--save")) writeFileSync(resolve(opt("--save")), JSON.stringify(prs, null, 1));
const q = buildQueue({ prs: onlyBase ? prs.filter((p) => p.base === onlyBase) : prs, codeowners: readFileSync(join(ROOT, ".github/CODEOWNERS"), "utf8"), tests: testIndex(), limit, owner: REPO.split("/")[0] });
if (opt("--out")) {
  writeFileSync(resolve(opt("--out")), q.markdown + "\n");
  console.log(`${q.items.length} of ${q.waiting} waiting PRs → ${opt("--out")}`);
} else console.log(q.markdown);
