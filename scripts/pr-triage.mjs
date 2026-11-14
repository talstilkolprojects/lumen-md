#!/usr/bin/env node
/**
 * `node scripts/pr-triage.mjs` (plan W6.21): one decision table for every
 * open pull request — in main, in a train, superseded, dependabot, a train
 * itself, or still needed (scripts/lib/prTriage.mjs has the rules).
 *
 *   node scripts/pr-triage.mjs                  print the table (dry run)
 *   node scripts/pr-triage.mjs --write          also rewrite the generated part of
 *                                               docs/src/content/docs/project/pr-triage.md
 *                                               and its Hebrew twin
 *   node scripts/pr-triage.mjs --json out.json  the rows as JSON too
 *   node scripts/pr-triage.mjs --close in-main [--go]
 *   node scripts/pr-triage.mjs --close superseded [--go]
 *                                               close one category, each PR with a comment;
 *                                               without --go it only prints what it would do.
 *                                               in-main is re-checked against origin/main right
 *                                               before each close. Branches are never deleted.
 *
 * Options: --repo owner/name (default talstilkol/lumen-md), --trains a,b,c
 * (default verify/train,verify/train-2,verify/train-3; missing ones are
 * skipped), --from prs.json (classify a saved `pulls` listing instead of
 * calling GitHub), --git-dir <path> (a clone with full history; a shallow
 * clone cannot answer is-ancestor), --no-fetch (use the refs fetched by
 * the last run).
 *
 * GitHub through `gh api` (REST). PR heads are fetched as refs/pr-triage/<n>
 * so `git merge-base --is-ancestor` can see them. PR text is data: matched
 * against patterns, never executed.
 */
import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { CATEGORIES, classify, closeComment, counts, ownerCommands } from "./lib/prTriage.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const DOC_EN = "docs/src/content/docs/project/pr-triage.md";
export const DOC_HE = "docs/src/content/docs/he/project/pr-triage.md";
export const START = "<!-- pr-triage:start -->";
export const END = "<!-- pr-triage:end -->";

export function parseArgs(argv) {
  const opt = (n) => (argv.includes(n) ? argv[argv.indexOf(n) + 1] : undefined);
  return {
    repo: opt("--repo") ?? "talstilkol/lumen-md",
    trains: (opt("--trains") ?? "verify/train,verify/train-2,verify/train-3").split(",").filter(Boolean),
    from: opt("--from"),
    json: opt("--json"),
    gitDir: resolve(opt("--git-dir") ?? process.cwd()),
    write: argv.includes("--write"),
    close: opt("--close"),
    go: argv.includes("--go"),
    fetch: !argv.includes("--no-fetch"),
  };
}

const git = (dir, ...a) => execFileSync("git", a, { cwd: dir, encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] }).trim();
const gh = (...a) => execFileSync("gh", a, { encoding: "utf8", maxBuffer: 256 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"] });

/** Open PRs from GitHub (or a saved listing), reduced to what the rules read. */
export function loadPrs(opts) {
  // Page by page (not --paginate: its next links name the repository by numeric id, which some proxies refuse).
  const raw = [];
  if (opts.from) raw.push(...JSON.parse(readFileSync(opts.from, "utf8")));
  else
    for (let page = 1; page < 50; page++) {
      const batch = JSON.parse(gh("api", `repos/${opts.repo}/pulls?state=open&per_page=100&page=${page}`));
      raw.push(...batch);
      if (batch.length < 100) break;
    }
  return raw.map((p) => ({
    number: p.number,
    title: p.title ?? "",
    body: p.body ?? "",
    user: p.user?.login ?? p.user ?? "",
    head: p.head?.ref ?? p.head ?? "",
    sha: p.head?.sha ?? p.sha ?? "",
    base: p.base?.ref ?? p.base ?? "",
  }));
}

/** Fetch main, the trains and every PR head into the clone; returns the trains that exist and an is-ancestor oracle. */
export function gitOracle(dir, prs, trains, { fetch = true } = {}) {
  if (git(dir, "rev-parse", "--is-shallow-repository") === "true") {
    throw new Error(`${dir} is a shallow clone: is-ancestor needs the history. Run \`git fetch --unshallow origin\` there, or pass --git-dir <full or --filter=tree:0 clone>.`);
  }
  const remote = (b) => `refs/remotes/origin/${b}`;
  if (fetch) {
    const have = new Set(git(dir, "ls-remote", "--heads", "origin").split("\n").map((l) => l.split("\t")[1]?.replace("refs/heads/", "")));
    const branches = ["main", ...trains].filter((b) => have.has(b));
    const specs = [...branches.map((b) => `+refs/heads/${b}:${remote(b)}`), ...prs.map((p) => `+refs/pull/${p.number}/head:refs/pr-triage/${p.number}`)];
    for (let i = 0; i < specs.length; i += 200) git(dir, "fetch", "-q", "origin", ...specs.slice(i, i + 200));
  }
  const exists = (ref) => spawnSync("git", ["rev-parse", "-q", "--verify", `${ref}^{commit}`], { cwd: dir }).status === 0;
  const live = trains.filter((t) => exists(remote(t)));
  const memo = new Map();
  const contains = (sha, ref) => {
    const target = /^[0-9a-f]{40}$/.test(ref) ? ref : remote(ref);
    const key = `${sha} ${target}`;
    if (!memo.has(key)) memo.set(key, exists(sha) && exists(target) && spawnSync("git", ["merge-base", "--is-ancestor", sha, target], { cwd: dir }).status === 0);
    return memo.get(key);
  };
  return { trains: live, contains, mainSha: exists(remote("main")) ? git(dir, "rev-parse", remote("main")) : null };
}

const LABEL = {
  en: {
    "in-main": "In main: close now",
    "in-train": "In a train: close once it is promoted",
    superseded: "Superseded: close with the reason (approve the list)",
    dependabot: "Dependabot: lane S triages (W6.14)",
    train: "Integration trains: merged or closed with the promotion",
    needed: "Still needed: stays open",
  },
  he: {
    "in-main": "כבר ב-main: לסגור עכשיו",
    "in-train": "ברכבת: לסגור כשהיא מקודמת",
    superseded: "הוחלף: לסגור עם הסיבה (לאשר את הרשימה)",
    dependabot: "Dependabot: מסלול S ממיין (W6.14)",
    train: "רכבות אינטגרציה: ממוזגות או נסגרות עם הקידום",
    needed: "עדיין נחוץ: נשאר פתוח",
  },
};

/** The generated part of the docs page: counts, the PRs of each category, and the owner commands. */
export function renderSection(rows, { lang = "en", repo, generatedAt, mainSha, trains }) {
  const L = LABEL[lang];
  const c = counts(rows);
  const he = lang === "he";
  const lines = [START, ""];
  lines.push(he ? `*נוצר ב-${generatedAt} על ידי \`node scripts/pr-triage.mjs --write\`. ‏${rows.length} PR-ים פתוחים; ‏main ב-\`${(mainSha ?? "").slice(0, 9)}\`; רכבות: ${trains.map((t) => `\`${t}\``).join(", ")}.*` : `*Generated ${generatedAt} by \`node scripts/pr-triage.mjs --write\`. ${rows.length} open PRs; main at \`${(mainSha ?? "").slice(0, 9)}\`; trains: ${trains.map((t) => `\`${t}\``).join(", ")}.*`);
  lines.push("", he ? "| קטגוריה | כמה | מה עושים |" : "| Category | PRs | What happens |", "|---|---|---|");
  for (const k of CATEGORIES) lines.push(`| \`${k}\` | ${c[k]} | ${L[k]} |`);
  for (const k of CATEGORIES) {
    const list = rows.filter((r) => r.category === k);
    if (!list.length) continue;
    lines.push("", `### \`${k}\` (${list.length})`, "");
    if (k === "in-train") {
      const byTrain = new Map();
      for (const r of list) byTrain.set(r.trains[0], [...(byTrain.get(r.trains[0]) ?? []), r.number]);
      for (const [t, ns] of byTrain) lines.push(`- \`${t}\` (${ns.length}): ${ns.map((n) => `#${n}`).join(" ")}`);
    } else if (k === "superseded") {
      for (const r of list) lines.push(`- #${r.number} → #${r.by}: ${r.why}`);
    } else if (k === "needed") {
      const cell = (t) => String(t).replace(/\|/g, "\\|").replace(/\s+/g, " ").slice(0, 90);
      lines.push(he ? "| PR | ענף → בסיס | כותרת |" : "| PR | Branch → base | Title |", "|---|---|---|");
      for (const r of list) lines.push(`| #${r.number} | \`${r.head}\` → \`${r.base}\` | ${cell(r.title)} |`);
    } else lines.push(list.map((r) => `#${r.number}`).join(" "));
    if (k === "dependabot") lines.push("", he ? "מסלול S ממיין אותם ב-W6.14 (רכבת התלויות); אין כאן פקודת סגירה." : "Lane S triages these in W6.14 (the dependency train); no close command here.");
    if (k === "train") lines.push("", he ? "הרכבות נסגרות או ממוזגות ביד עם הקידום של main." : "The trains are merged or closed by hand with the promotion of main.");
  }
  const cmds = ownerCommands(rows, repo);
  lines.push("", he ? "### פקודות בעלים" : "### Owner commands", "");
  lines.push(he ? "לא מורצות בידי סוכן. כל לולאה בודקת שוב לפני כל סגירה, והענפים לא נמחקים." : "Never run by an agent. Each loop re-checks before every close, and no branch is deleted.");
  const block = (title, body) => body && lines.push("", title, "", "```sh", body, "```");
  block(he ? "**כבר ב-main** — עכשיו:" : "**In main** — now:", cmds["in-main"]);
  block(he ? "**ברכבת** — אחרי שהרכבת מקודמת ל-main (PR שעוד לא ב-main נשאר פתוח):" : "**In a train** — after the train is promoted to main (a PR not in main yet stays open):", cmds["in-train"]);
  block(he ? "**הוחלף** — אחרי שקראת את הרשימה למעלה:" : "**Superseded** — after reading the list above:", cmds.superseded);
  lines.push("", he ? "או דרך הסקריפט, שבודק את הכלל מחדש: `node scripts/pr-triage.mjs --close in-main --go`, ‏`--close superseded --go`." : "Or through the script, which re-checks the rule live: `node scripts/pr-triage.mjs --close in-main --go`, `--close superseded --go`.");
  lines.push("", END);
  return lines.join("\n");
}

/** Replace the generated part of a page (between the markers). */
export function spliceSection(page, section) {
  const a = page.indexOf(START);
  const b = page.indexOf(END);
  if (a < 0 || b < a) throw new Error(`the page has no ${START} … ${END} markers`);
  return page.slice(0, a) + section + page.slice(b + END.length);
}

function closeCategory(rows, opts, oracle) {
  if (!["in-main", "superseded"].includes(opts.close)) throw new Error(`--close takes in-main or superseded (in-train PRs become in-main once their train is promoted)`);
  const list = rows.filter((r) => r.category === opts.close);
  console.log(`${opts.go ? "Closing" : "Would close"} ${list.length} PR(s) of ${opts.close}.`);
  for (const r of list) {
    const comment = closeComment(r, { mainSha: oracle.mainSha });
    console.log(`#${r.number}  ${r.why}`);
    if (!opts.go) continue;
    gh("api", "-X", "POST", `repos/${opts.repo}/issues/${r.number}/comments`, "-f", `body=${comment}`);
    gh("api", "-X", "PATCH", `repos/${opts.repo}/pulls/${r.number}`, "-f", "state=closed");
  }
}

function main() {
  const opts = parseArgs(process.argv.slice(2));
  const prs = loadPrs(opts);
  const oracle = gitOracle(opts.gitDir, prs, opts.trains, { fetch: opts.fetch });
  const rows = classify(prs, { contains: oracle.contains, trains: oracle.trains });
  const c = counts(rows);
  console.log(`${rows.length} open PRs — ${CATEGORIES.map((k) => `${k} ${c[k]}`).join(", ")}`);
  for (const r of rows) console.log(`#${r.number}\t${r.category}\t${r.why}\t${r.title.slice(0, 80)}`);
  if (opts.json) writeFileSync(opts.json, JSON.stringify(rows, null, 2) + "\n");
  if (opts.write) {
    const generatedAt = new Date().toISOString().slice(0, 16).replace("T", " ") + " UTC";
    for (const [file, lang] of [[DOC_EN, "en"], [DOC_HE, "he"]]) {
      const path = join(ROOT, file);
      if (!existsSync(path)) throw new Error(`${file} is missing`);
      writeFileSync(path, spliceSection(readFileSync(path, "utf8"), renderSection(rows, { lang, repo: opts.repo, generatedAt, mainSha: oracle.mainSha, trains: oracle.trains })));
    }
    console.log(`wrote ${DOC_EN} and ${DOC_HE}`);
  }
  if (opts.close) closeCategory(rows, opts, oracle);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
