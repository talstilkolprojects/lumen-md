#!/usr/bin/env node
/**
 * Plan W4.24 — fill the structured `verified` and `pr` fields of plan/plan.json
 * from each task's free-text Hebrew `status`.
 *
 *   node scripts/plan/migrate-verified.mjs           fill tasks that have a status but no `verified`
 *   node scripts/plan/migrate-verified.mjs --all     recompute every task (overwrites hand-set levels)
 *   node scripts/plan/migrate-verified.mjs --check   exit 1 when a task would change (writes nothing)
 *   node scripts/plan/migrate-verified.mjs --list    print id, level, pr and the status head
 *
 * Re-runnable: it reads the plan as it is now and only adds or updates the two
 * keys, right after `status` (the order scripts/plan/build.mjs enforces). Run
 * `npm run plan` afterwards to regenerate MASTER_PLAN.md and plan/board.html.
 *
 * Levels (VERIFIED_LEVELS in build.mjs), from the status text:
 *   owner    ✅* (only the owner's real-model check is left), or the agent's
 *            checks ran in a browser and an owner item ("בעלים:", "(טל)",
 *            "(בעלים)") is the only thing still owed
 *   browser  plain ✅ (green on the full GitHub CI, e2e included, before Actions
 *            stopped on 9.11; "CI ירוק על <sha>" says the same of a ⏳ task),
 *            a run in Chromium (offline harness or e2e), or
 *            the Vercel Sandbox suite with its build / Playwright spec
 *   node     ran in plain Node: "ב-Node נקי", "shim", "plain-Node", or the
 *            Vercel Sandbox suite without a build or a browser run
 *   built    anything else (code written, nothing recorded as run)
 *   real     never set by this script: real build + full suite + e2e on the
 *            merged code is a claim the coordinator records by hand
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { resolve } from "node:path";

import { ROOT, PLAN_FILE, withVerified } from "./build.mjs";

/** The first "#NNN" in the status, as a number. */
export function prOf(status) {
  const m = /#(\d+)/.exec(status ?? "");
  return m ? Number(m[1]) : undefined;
}

/**
 * The "חסר: …", "נשאר לפני מיזוג ל-main: …" and "dod: …" clauses of a status: text that names work still
 * owed or commands not yet run, so it must not count as something that ran.
 * A clause runs to the next ";", or to the ")" that closes the parenthesis
 * it sits in (a "(טל)" inside it does not end it; "·" separates dod commands).
 */
export function clauses(status, label) {
  const out = [];
  const re = new RegExp(`${label}:`, "g");
  for (let m; (m = re.exec(status)); ) {
    let depth = 0;
    let i = m.index + m[0].length;
    for (; i < status.length; i++) {
      const c = status[i];
      if (c === "(") depth++;
      else if (c === ")") {
        if (!depth) break;
        depth--;
      } else if (!depth && c === ";") break;
    }
    out.push({ start: m.index, end: i, text: status.slice(m.index + m[0].length, i) });
  }
  return out;
}
const strip = (s, cs) => [...cs].sort((a, b) => b.start - a.start).reduce((acc, c) => acc.slice(0, c.start) + " " + acc.slice(c.end), s);

/** Things owed by an agent (not the owner) that keep a task off "owner". */
const AGENT_OWED = /לא נבדק|ממתינ|לא הורצ|לא נמדד|לא קומפל|לא נבנה|לא הושג|לא עומד|לא רץ|CI אדום|בעבודה|לא סקר|חובה לתקן/;
const OWNER_MARK = /בעלים:|\(בעלים\)|\(טל\)/;
const NODE_MARK = /ב-Node נקי|shim|plain-Node/i;
/** The Vercel Sandbox suite (Update 4): typecheck / vitest, and with a build or a Playwright spec it ran in a browser. */
const SANDBOX_MARK = /Vercel Sandbox|Vercel על Node 24/;
const SANDBOX_TESTS = /vitest \d|typecheck 0|\d+\/\d+/;
const SANDBOX_BROWSER = /e2e|\.spec|playwright|firefox|webkit|דפדפנים|בכל דפדפן/i;
/** Chromium as the place something ran; not where a tool will run, not where tests now fail. */
const BROWSER_MARK = /chromium/i;
/** Green on the full GitHub CI (typecheck, vitest, build, e2e in 3 browsers) before Actions stopped on 9.11. */
const GITHUB_CI_GREEN = /CI ירוק (על|מ-)/;
const NOT_A_RUN = /Chromium אמיתי עם|נכשלות ב-chromium|אין e2e/gi;

/** True when every item of every "חסר: …" clause is the owner's. */
function onlyOwnerMissing(status) {
  for (const c of clauses(status, "חסר")) {
    for (const item of c.text.split(/,(?![^(]*\))/)) if (item.trim() && !OWNER_MARK.test(item)) return false;
  }
  return true;
}

/** What ran, ignoring the owner: built, node or browser. */
function ranLevel(status) {
  const owed = ["חסר", "נשאר לפני מיזוג ל-main", "dod"].flatMap((l) => clauses(status, l));
  const ran = strip(status, owed).replace(NOT_A_RUN, " ");
  const sandbox = SANDBOX_MARK.test(ran) && SANDBOX_TESTS.test(ran);
  if (BROWSER_MARK.test(ran) || GITHUB_CI_GREEN.test(ran) || (sandbox && SANDBOX_BROWSER.test(ran))) return "browser";
  if (NODE_MARK.test(ran) || sandbox) return "node";
  return "built";
}

/** The verification level a status records (see the header). */
export function classify(status) {
  const s = status ?? "";
  if (s.startsWith("✅*")) return "owner";
  if (s.startsWith("✅")) return "browser";
  const ran = ranLevel(s);
  // "owner if that is all that is owed": the agent's side ran in a browser, nothing else is pending.
  if (ran === "browser" && OWNER_MARK.test(s) && !AGENT_OWED.test(s) && onlyOwnerMissing(s)) return "owner";
  return ran;
}

/**
 * The plan with `verified` and `pr` filled. `all` recomputes tasks that
 * already have a level; otherwise they keep it (a level set by hand wins).
 * Returns the new plan and the ids that changed.
 */
export function migrate(plan, { all = false } = {}) {
  const changed = [];
  const phases = plan.phases.map((p) => ({
    ...p,
    tasks: p.tasks.map((t) => {
      if (!t.status) return t;
      const verified = !all && t.verified ? t.verified : classify(t.status);
      const pr = prOf(t.status);
      const next = withVerified(t, verified, pr);
      if (JSON.stringify(next) !== JSON.stringify(t)) changed.push(t.id);
      return next;
    }),
  }));
  return { plan: { ...plan, phases }, changed };
}

function main(argv) {
  const path = join(ROOT, PLAN_FILE);
  const plan = JSON.parse(readFileSync(path, "utf8"));
  const { plan: next, changed } = migrate(plan, { all: argv.includes("--all") });
  if (argv.includes("--list")) {
    for (const p of next.phases) for (const t of p.tasks) if (t.status) console.log(`${t.id}\t${t.verified}\t${t.pr ?? ""}\t${t.status.slice(0, 70)}`);
  }
  const counts = {};
  for (const p of next.phases) for (const t of p.tasks) if (t.verified) counts[t.verified] = (counts[t.verified] ?? 0) + 1;
  const summary = Object.entries(counts).map(([k, v]) => `${k} ${v}`).join(", ");
  if (argv.includes("--check")) {
    if (changed.length) {
      console.error(`migrate-verified: ${changed.length} tasks would change: ${changed.join(", ")}`);
      return 1;
    }
    console.log(`migrate-verified: up to date (${summary})`);
    return 0;
  }
  if (changed.length) writeFileSync(path, JSON.stringify(next, null, 1) + "\n");
  console.log(`migrate-verified: ${changed.length} tasks updated (${summary}). Run \`npm run plan\` next.`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
