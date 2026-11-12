#!/usr/bin/env node
/**
 * The plan as data (plan 0.6). plan/plan.json is the single source of the
 * plan: phases, tasks (status, dependencies, lane, estimate, steps,
 * acceptance), the owner's items (15.x), milestones and the done table.
 * This script schedules it and renders:
 *
 *   MASTER_PLAN.md   the board section, from "## לוח משימות" up to "## נספח 0 ·"
 *   plan/board.html  the board as an HTML page (an Artifact fragment)
 *
 *   npm run plan             regenerate both
 *   npm run plan:check       exit 1 when either differs from plan.json (CI),
 *                            or a ✅ task has no `dod` (plan 0.7, scripts/dod.mjs),
 *                            a ✅ is verified below `browser` (W10.G8), or a
 *                            status is longer than STATUS_MAX (W10.G7);
 *                            warns when a wave is over its work-in-progress limit
 *                            while the next wave has started (plan W6.39, below)
 *   npm run plan:check -- --wip-strict      the WIP warning fails the check
 *   npm run plan:check -- --wip-limit 8     another limit than plan.schedule.wipLimit / WIP_LIMIT
 *   npm run plan -- --hours  also print actual hours per task branch (git)
 *
 * The scheduler started as a port of the earlier Python generator (plan5.py
 * / gen5.py): 4 agent lanes plus the owner's lane, conflict groups that never
 * run at once, P0 closure over dependencies, and the cut-line check that
 * nothing outside P2 waits on a P2 task. Since the port, remaining work starts
 * at the plan's update (never in the past) and non-P0 work backfills idle
 * gaps in its lane instead of queueing behind the P0 reservations. Times are local wall-clock (Israel)
 * without a zone, computed in UTC so the machine's zone never matters.
 */
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { checkDod } from "../dod.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const PLAN_FILE = "plan/plan.json";
export const DOC_FILE = "MASTER_PLAN.md";
export const HTML_FILE = "plan/board.html";
export const BOARD_START = "## לוח משימות";
export const BOARD_END = "## נספח 0 ·";

// ───────────────────────────── time ─────────────────────────────

const MIN = 60_000;
/** The only time format plan.json accepts: a naive local (Israel) wall-clock time, minute precision. */
export const TIME_FORMAT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;
/**
 * "2026-10-18T08:00" → ms, read as UTC (a naive local time). Anything else
 * (a zone offset, seconds, a date alone) throws: a NaN start used to send the
 * owner-window walk in buildModel into an endless loop.
 */
export function parseTime(s, field = "time") {
  const t = typeof s === "string" && TIME_FORMAT.test(s) ? Date.parse(`${s}:00Z`) : NaN;
  if (!Number.isFinite(t)) throw new Error(`plan: ${field} ${JSON.stringify(s)} is not YYYY-MM-DDTHH:MM (local Israel time, no zone or seconds)`);
  return t;
}
const DAYS = "א׳ ב׳ ג׳ ד׳ ה׳ ו׳ שבת".split(" ");
const pad = (n) => String(n).padStart(2, "0");
const hhmm = (t) => {
  const d = new Date(t);
  return `${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
};
/** "א׳ 18.10 15:20" */
export function fmt(t) {
  const d = new Date(t);
  return `${DAYS[d.getUTCDay()]} ${d.getUTCDate()}.${d.getUTCMonth() + 1} ${hhmm(t)}`;
}
/** "2 ש׳ 05 דק׳" / "45 דק׳" */
export const dur = (m) => (m >= 60 ? `${Math.floor(m / 60)} ש׳ ${pad(m % 60)} דק׳` : `${m} דק׳`);
const sameDay = (a, b) => new Date(a).toISOString().slice(0, 10) === new Date(b).toISOString().slice(0, 10);
/** start + (t - start) × factor, rounded to the microsecond as Python's timedelta does. */
const stretch = (start, t, factor) => start + Math.round((t - start) * 1000 * factor) / 1000;
/** Tasks per verification level, levels in VERIFIED_LEVELS order, plus those with a status but no level. */
function verifiedCounts(ts) {
  const c = Object.fromEntries(VERIFIED_LEVELS.map((k) => [k, 0]));
  let none = 0;
  for (const t of ts) {
    if (t.verified) c[t.verified]++;
    else if (t.status) none++;
  }
  return { ...c, none };
}

// ───────────────────────────── verification level ─────────────────────────────

/**
 * Plan W4.24 — how far a task's result was checked, as data next to the
 * free-text status: `verified` (one of these, weakest first) and `pr` (the
 * task's PR number). scripts/plan/migrate-verified.mjs fills both from the
 * status text.
 */
export const VERIFIED_LEVELS = Object.freeze(["built", "node", "browser", "real", "owner"]);
export const VERIFIED_LABEL = Object.freeze({
  built: "נבנה בלבד",
  node: "Node",
  browser: "דפדפן",
  real: "אמיתי (מוזג)",
  owner: "מחכה לטל",
});
/** Keys that, when present, come right after `status`, in this order. */
export const AFTER_STATUS = Object.freeze(["verified", "pr"]);

/** The task with `verified` / `pr` set (or dropped when undefined), placed right after `status`. */
export function withVerified(task, verified, pr) {
  const out = {};
  for (const [k, v] of Object.entries(task)) {
    if (AFTER_STATUS.includes(k)) continue;
    out[k] = v;
    if (k === "status") {
      if (verified !== undefined) out.verified = verified;
      if (pr !== undefined) out.pr = pr;
    }
  }
  return out;
}

/**
 * The rules for `verified` and `pr` (plan:check). Returns a list of problems.
 * - `verified` is one of VERIFIED_LEVELS and `pr` a positive integer
 * - both need a `status` (they describe it) and sit right after it, `verified`
 *   first: the canonical order keeps a status change and its level one diff hunk
 */
export function checkVerified(plan) {
  const problems = [];
  for (const p of plan.phases) for (const t of p.tasks) {
    if (t.verified !== undefined && !VERIFIED_LEVELS.includes(t.verified)) problems.push(`${t.id}: verified ${JSON.stringify(t.verified)} is not one of ${VERIFIED_LEVELS.join(", ")}`);
    if (t.pr !== undefined && !(Number.isInteger(t.pr) && t.pr > 0)) problems.push(`${t.id}: pr ${JSON.stringify(t.pr)} is not a PR number`);
    const keys = Object.keys(t);
    const present = AFTER_STATUS.filter((k) => k in t);
    if (!present.length) continue;
    const at = keys.indexOf("status");
    if (at < 0) {
      problems.push(`${t.id}: ${present.join(" and ")} without a status`);
      continue;
    }
    const got = keys.slice(at + 1, at + 1 + present.length);
    if (got.join() !== present.join()) problems.push(`${t.id}: ${present.join(", ")} must come right after "status" (found ${["status", ...got].join(", ")})`);
  }
  return problems;
}

/**
 * Plan W10.G8 (the core of W4.24) — ✅ means checked at least in a browser.
 * `built`, `node` and `owner` (only the owner's real-world check is left, the
 * ✅* tasks) are ⏳ until that check runs.
 */
export const DONE_LEVELS = Object.freeze(["browser", "real"]);
export function checkDoneLevel(plan) {
  const problems = [];
  for (const p of plan.phases) for (const t of p.tasks) {
    if (!String(t.status ?? "").startsWith("✅")) continue;
    if (!DONE_LEVELS.includes(t.verified)) problems.push(`${t.id}: marked ${t.status.slice(0, 2).trim()} but verified ${JSON.stringify(t.verified ?? null)} — ✅ needs ${DONE_LEVELS.join(" or ")}; keep it ⏳ until that check runs (W10.G8)`);
  }
  return problems;
}

/**
 * Plan W10.G7 — a status is one short line on the board. The detail goes in
 * `notes` (rendered under the task, not in the table).
 */
export const STATUS_MAX = 200;
export function checkStatusLength(plan, { max = STATUS_MAX } = {}) {
  const problems = [];
  for (const p of plan.phases) for (const t of p.tasks) {
    if (t.status !== undefined && [...String(t.status)].length > max) problems.push(`${t.id}: status is ${[...String(t.status)].length} characters, over ${max} — move the detail to "notes" (W10.G7)`);
    if (t.notes !== undefined && (typeof t.notes !== "string" || !t.notes.trim())) problems.push(`${t.id}: notes must be a non-empty string`);
  }
  return problems;
}

// ───────────────────────────── model ─────────────────────────────

/**
 * Load plan.json and derive the schedule. Returns everything the renderers
 * need; throws on a broken plan (unknown dependency, cut-line violation, a
 * dependency cycle).
 */
export function buildModel(plan) {
  const cfg = plan.schedule;
  // Remaining work starts at the update, never in the past (the plan's own
  // start stays in plan.json as its history).
  const START = Math.max(parseTime(plan.start, "start"), parseTime(plan.updated, "updated"));
  const lanes = plan.lanes;
  const agent = [];
  const phases = plan.phases.map((p, pi) => ({
    ...p,
    tasks: p.tasks.map((x) => {
      const done = (x.status ?? "").startsWith("✅");
      const t = {
        id: x.id, t: x.title, br: x.branch ?? "—", lane: x.lane,
        m: done ? 0 : x.minutes, m_est: x.minutes, done,
        dep: [...(x.dep ?? [])], depRule: x.depRule, g: [...(x.groups ?? [])], p: x.priority,
        status: x.status, verified: x.verified, pr: x.pr, new: !!x.new, tal: x.owner ?? "", old: x.was ?? "", w: x.source ?? "",
        steps: x.steps, ok: x.acceptance, notes: x.notes, phase: pi,
      };
      agent.push(t);
      return t;
    }),
  }));
  const BYID = new Map(agent.map((t) => [t.id, t]));
  for (const t of agent) {
    if (!t.dep.length && !t.depRule && !cfg.noDefaultDep.includes(t.id)) t.dep = [cfg.defaultDep];
  }
  const owner = plan.owner.map((o) => ({
    id: o.id, t: o.title, br: "—", lane: "T", m: o.minutes, steps: [o.details], ok: [], dep: [...o.dep], g: [], p: o.priority,
    new: false, tal: "", old: "", w: "", time: o.time, opensOverride: o.opens,
  }));
  for (const o of owner) BYID.set(o.id, o);
  const all = [...agent, ...owner];
  const talIds = (t) => t.tal.split(",").map((s) => s.trim()).filter(Boolean);
  const OPENS = new Map(owner.map((o) => [o.id, []]));
  for (const t of agent) for (const x of talIds(t)) {
    if (!OPENS.has(x)) throw new Error(`plan: task ${t.id} waits on owner item ${x}, which does not exist`);
    OPENS.get(x).push(t.id);
  }
  for (const o of owner) if (o.opensOverride) OPENS.set(o.id, o.opensOverride);

  // Priorities: P0 spreads to everything a P0 task waits on.
  for (const t of all) t.eff = t.p;
  const closeP0 = () => {
    for (let changed = true; changed; ) {
      changed = false;
      for (const t of all) {
        if (t.eff !== "P0") continue;
        for (const d of t.dep) {
          const dt = BYID.get(d);
          if (dt && dt.eff !== "P0") {
            dt.eff = "P0";
            changed = true;
          }
        }
      }
    }
  };
  const checkDeps = (ts) => {
    for (const t of ts) for (const d of t.dep) if (!BYID.has(d)) throw new Error(`plan: ${t.id} depends on unknown ${d}`);
  };
  checkDeps(all);
  closeP0();
  const minor = (s) => Number(s.split(".")[1]);
  const TAL_P0 = [...new Set([...agent.filter((t) => t.eff === "P0").flatMap(talIds), ...cfg.ownerAlwaysP0])].sort((a, b) => minor(a) - minor(b));
  for (const x of TAL_P0) BYID.get(x).eff = "P0";
  for (const t of agent.filter((t) => t.depRule === "allP0")) t.dep = [...agent.filter((x) => x.eff === "P0" && x.id !== t.id).map((x) => x.id), ...TAL_P0];
  closeP0();
  // "all": every other task and every owner item (the final audit waits on the owner's checks too).
  for (const t of agent.filter((t) => t.depRule === "all")) t.dep = all.filter((x) => x.id !== t.id).map((x) => x.id);
  checkDeps(all);

  // A dependency cycle (done tasks included: their dependencies are data too).
  const state = new Map();
  const visit = (t, path) => {
    if (state.get(t.id) === "done") return;
    if (state.get(t.id) === "open") throw new Error(`plan: dependency cycle ${[...path, t.id].join(" → ")}`);
    state.set(t.id, "open");
    for (const d of t.dep) visit(BYID.get(d), [...path, t.id]);
    state.set(t.id, "done");
  };
  for (const t of all) visit(t, []);

  // Cut line: if the release slips, every P2 moves out; nothing else may wait on one.
  const cut = [];
  for (const t of all) {
    if (cfg.cutLineExempt.includes(t.id)) continue;
    for (const d of t.dep) if (t.eff !== "P2" && BYID.get(d).eff === "P2") cut.push(`${t.id} (${t.eff}) → ${d} (P2)`);
  }
  if (cut.length) throw new Error(`plan: cut line broken, a non-P2 item waits on a P2 task: ${cut.join(", ")}`);

  // Schedule.
  const PRIO = new Map(all.map((t, i) => [t.id, i]));
  for (const id of cfg.laneFirst) PRIO.set(id, -1);
  cfg.ownerFirst.forEach((id, k) => PRIO.set(id, -10 + k));
  const [W0, W1] = plan.ownerWindow;
  const at = (t, h) => {
    const d = new Date(t);
    return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate(), h, 0, 0);
  };
  const DAY = 24 * 60 * MIN;
  const ownerFit = (st, m) => {
    // A NaN or infinite start never fits a window: refuse it instead of walking day by day forever.
    if (!Number.isFinite(st) || !Number.isFinite(m) || m < 0) throw new Error(`plan: cannot place ${m} owner minutes at ${st}`);
    let cur = st;
    if (cur >= at(cur, W1)) cur = at(cur + DAY, W0);
    else if (cur < at(cur, W0)) cur = at(cur, W0);
    const start = cur;
    let left = m;
    for (;;) {
      const avail = (at(cur, W1) - cur) / MIN;
      if (left <= avail) return [start, cur + left * MIN];
      left -= avail;
      cur = at(cur + DAY, W0);
    }
  };
  // Busy intervals per lane and per conflict group.
  const busy = new Map();
  const intervals = (key) => busy.get(key) ?? [];
  const reserve = (key, a, b) => busy.set(key, [...intervals(key), [a, b]].sort((x, y) => x[0] - y[0]));
  const lastEnd = (keys) => Math.max(START, ...keys.flatMap((k) => intervals(k).map((iv) => iv[1])));
  /** The earliest start ≥ ready where `m` minutes fit between the intervals of `keys`. */
  const firstGap = (keys, ready, m) => {
    const ivs = keys.flatMap(intervals).sort((x, y) => x[0] - y[0]);
    let cur = ready;
    for (const [a, b] of ivs) {
      if (cur + m * MIN <= a) return cur;
      if (b > cur) cur = b;
    }
    return cur;
  };
  // Done tasks take no time: they end at the update.
  for (const t of all) if (t.done) [t.start, t.end] = [START, START];
  /**
   * The P0 batch reserves its slots in order, each after the last work of
   * its lane and groups. The rest backfills: a task takes the earliest gap
   * in its lane and groups that it fits in, so a lane waiting on another
   * lane's P0 work is not left idle, and no P0 slot moves.
   */
  const schedule = (batch, backfill) => {
    const pending = batch.filter((t) => !t.done);
    while (pending.length) {
      let best = null;
      for (const t of pending) {
        if (t.dep.some((d) => BYID.get(d).end === undefined)) continue;
        const keys = [`lane:${t.lane}`, ...t.g.map((g) => `group:${g}`)];
        const ready = Math.max(START, ...t.dep.map((d) => BYID.get(d).end));
        let st;
        if (t.lane === "T") st = ownerFit(Math.max(ready, lastEnd(keys)), t.m)[0];
        else st = backfill ? firstGap(keys, ready, t.m) : Math.max(ready, lastEnd(keys));
        const key = [st, PRIO.get(t.id)];
        if (!best || key[0] < best.key[0] || (key[0] === best.key[0] && key[1] < best.key[1])) best = { key, t, st, keys };
      }
      if (!best) throw new Error(`plan: dependency cycle among ${pending.map((t) => t.id).join(", ")}`);
      const { t, st, keys } = best;
      [t.start, t.end] = t.lane === "T" ? ownerFit(st, t.m) : [st, st + t.m * MIN];
      for (const k of keys) reserve(k, t.start, t.end);
      pending.splice(pending.indexOf(t), 1);
    }
  };
  const FIRST = all.filter((t) => t.eff === "P0" || cfg.ownerInputsFirst.includes(t.id));
  schedule(FIRST, false);
  schedule(all.filter((t) => !FIRST.includes(t)), true);

  const END = Math.max(...agent.map((t) => t.end));
  const P0_END = BYID.get(cfg.releaseTask).end;
  const BUFFER = plan.buffer;
  const span = (ts) => [Math.min(...ts.map((t) => t.start)), Math.max(...ts.map((t) => t.end))];
  const milestoneAt = (refs) =>
    Math.max(
      ...refs.flatMap((r) => {
        if (r === "release") return [P0_END];
        if (r === "end") return [END];
        const [kind, a, b] = r.split(":");
        if (kind === "task") return [BYID.get(a).end];
        if (kind === "phase") return phases[Number(a)].tasks.filter((t) => t.eff === b).map((t) => t.end);
        throw new Error(`plan: unknown milestone reference ${r}`);
      }),
    );
  return {
    plan, START, END, P0_END, BUFFER, lanes, phases, agent, owner, all, BYID, OPENS, TAL_P0, span,
    UPDATED: parseTime(plan.updated, "updated"),
    VERIFIED: verifiedCounts(agent),
    P0_BUF: stretch(START, P0_END, 1 + BUFFER),
    END_BUF: stretch(START, END, 1 + BUFFER),
    EFFORT: agent.reduce((n, t) => n + t.m, 0),
    milestones: plan.milestones.map((m) => ({ title: m.title, at: milestoneAt(m.at) })),
    stretch: (t) => stretch(START, t, 1 + BUFFER),
  };
}

// ───────────────────────────── text helpers ─────────────────────────────

const est = (t) => (t.done ? `בוצע (הוערך ${dur(t.m_est)})` : dur(t.m));
const priTxt = (t) => t.eff + (t.eff !== t.p ? " (נדרש ל-P0)" : "");
function depsTxt(M, t) {
  if (t.depRule === "allP0") return "כל ה-P0 + הפעולות שלך " + M.TAL_P0.join(", ");
  if (t.depRule === "all") return "כל השאר";
  return t.dep.join(", ");
}
/** Python's html.escape(s, quote=True). */
const E = (s) => String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#x27;");
const codeHtml = (s) => E(s).replace(/`([^`]+)`/g, "<code>$1</code>");
const sum = (ts) => ts.reduce((n, t) => n + t.m, 0);
/** A Markdown table cell: a literal pipe (even inside `code`) must be escaped, or it starts a new column. */
const cell = (s) => String(s).replace(/\|/g, "\\|");
const PR_URL = "https://github.com/talstilkol/lumen-md/pull/";
/** "דפדפן · [#251](…)" — the verification cell of a task row. */
const verifiedTxt = (t) => [t.verified ? VERIFIED_LABEL[t.verified] : "", t.pr ? `[#${t.pr}](${PR_URL}${t.pr})` : ""].filter(Boolean).join(" · ") || "—";
const verifiedSummary = (M) =>
  [...VERIFIED_LEVELS.map((k) => `${VERIFIED_LABEL[k]} ${M.VERIFIED[k]}`), ...(M.VERIFIED.none ? [`בלי רמה ${M.VERIFIED.none}`] : [])].join(" · ");
const laneTasks = (M, k) => M.agent.filter((t) => t.lane === k).sort((a, b) => a.start - b.start);

// ───────────────────────────── Markdown ─────────────────────────────

export function renderBoard(M) {
  const { plan, lanes } = M;
  const B = Math.round(M.BUFFER * 100);
  const [W0, W1] = plan.ownerWindow;
  const P0 = M.agent.filter((t) => t.eff === "P0");
  const NEW_V5 = M.agent.filter((t) => !t.old).length;
  const NEW = M.agent.filter((t) => t.new).length;
  const DONE_N = M.agent.filter((t) => t.done).length;
  const o = [];
  o.push(`## לוח משימות — תוכנית v5 (מעודכן ${fmt(M.UPDATED)})\n`);
  o.push("הלוח הזה הוא המקור היחיד ללו״ז. v5 מאחדת: את v4, ביקורת עצמאית על v4 (תלויות, הערכות, רישיונות, הנחות), מחקר פערים מול Obsidian / Notion / Logseq / Tana / Capacities, מחקר מודלים מקומיים עם רישיונות מאומתים (נספח 19), מחקר סטי זהב (נספח 20), מחקר מורחב על מודלים עבריים, כלי פיתוח ו-Obsidian 1.14, ביקורת עצמאית שנייה על v5 (נספח 23) ומחקר קוד פתוח בגיטהאב (נספח 24). נספחים 17–24 — הפרטים.\n");
  o.push("### מה כבר הושלם (שעות אמת)\n");
  o.push("| חלק | PR-ים | התחלה | סיום |\n|---|---|---|---|");
  for (const r of plan.done) o.push(`| ${[r.part, r.prs, r.start, r.end].map(cell).join(" | ")} |`);
  o.push("");
  o.push(`### התוכנית קדימה — ${M.agent.length} משימות ב-15 שלבים; ${DONE_N} בוצעו (ממתינות למיזוג), נותרו ${Math.floor(M.EFFORT / 60)} ש׳ עבודה (${NEW_V5} חדשות ב-v5, ${NEW} חדשות מאז תוכנית האב המקורית)\n`);
  o.push(`**רמת אימות (\`verified\`):** ${verifiedSummary(M)}\n`);
  o.push(`**${fmt(M.START)} → ${fmt(M.END)}** בתזמון רציף של 4 מסלולים · **עם מרווח ${B}%: ${fmt(M.END_BUF)}**\n`);
  o.push("#### אבני דרך\n");
  o.push(`| # | אבן דרך | בתזמון | עם מרווח ${B}% |\n|---|---|---|---|`);
  M.milestones.forEach((m, k) => o.push(`| ${k + 1} | ${cell(m.title)} | ${fmt(m.at)} | ${fmt(M.stretch(m.at))} |`));
  o.push("");
  o.push("#### איך התוכנית רצה\n");
  o.push(`1. **4 מסלולים במקביל** — ${Object.entries(lanes).map(([k, v]) => `${k} = ${v}`).join(" · ")}. כל מסלול = סוכן ב-worktree משלו (0.1). אני מתאם: ממזג, מריץ את כל הבדיקות, פותח PR ועונה ל-review.`);
  o.push("2. **קבוצות קונפליקט** — משימות שנוגעות באותם קבצים חמים (העורך, הרנדרר, ה-CSP, האחסון, החיפוש, ההגדרות, CI) לא רצות באותו זמן גם כשהן במסלולים שונים. התזמון אוכף את זה.");
  o.push("3. **הגדרת סיום (DoD)** — ✅ רק כש: הקוד והבדיקות בפנים; כל קריטריון ״קבלה״ נמדד אוטומטית ועבר (0.7); CI ירוק; כל ממצא review נסגר; לפיצ'ר חדש יש עמוד תיעוד; התוכנית, ה-HTML ומסמך הפרויקט עודכנו.");
  o.push("4. **סטטוסים** — ✅ נמדד · ✅* אמיתי אבל נבדק רק מול mocks (אין GPU / Ollama אצלי) · ⏳ חלקי · ⬜ לא התחיל. ✅* הופך ל-✅ רק אחרי בדיקת המודל האמיתי שנקבעה **לאותה משימה**: הפעולה של טל שרשומה בעמודה ״תלוי בטל״ שלה (15.3, 15.13–15.17), או המודל הזעיר ב-CI (7.2) רק כשלמשימה אין פעולה כזו. בדיקת schema ב-CI לבדה לא מספיקה.");
  o.push("   - **רמת אימות** — שדה `verified` לכל משימה עם סטטוס: נבנה בלבד (`built`) · Node (`node`, בדיקות ב-Node נקי או ב-shim) · דפדפן (`browser`, Chromium offline או e2e) · אמיתי (`real`, בנייה אמיתית + כל הבדיקות + e2e על הקוד הממוזג) · מחכה לטל (`owner`). `pr` = מספר ה-PR. `scripts/plan/migrate-verified.mjs` ממלא אותם מהסטטוס.");
  o.push("5. **מודלים** — רק מודלים מנספח 19 עם רישיון מסחרי מאומת. כל משימת מודל מתחילה ב-spike: נטען בדפדפן? גודל? איכות על הסט המוחזק? נכשל → החלופה הרשומה, או סגירה עם הסבר.");
  o.push("6. **סטי זהב מוחזקים** — נבנים על ידי סוכן שלא מממש, ומוקפאים לפני המימוש (7.1). מי שכותב קוד לא רואה את התשובות.");
  o.push(`7. **זמנים** — הערכות הפיצ'רים = 0.45 × אמצע הטווח של מפתח אנושי במחקר הפערים. זה שמרני ביחס לקצב שנמדד הלילה (4 מסלולים תיקנו 91 ממצאים עם בדיקות, כ-40 דקות כל אחד), כי פיצ'ר חדש דורש יותר תכנון ושילוב מתיקון. 0.6 מודד שעות אמת ומכייל מחדש אחרי שלב 0. שעות לכל משימה = תזמון רציף; אבני הדרך גם עם מרווח ${B}%.`);
  o.push(`8. **הפעולות שלך מתוזמנות** — בהנחה שאתה פנוי בערבים ${W0}:00–${W1}:00. אם החלון אחר, תגיד ואעדכן. כל פעולה שתעשה מוקדם יותר מקדימה את מה שמחכה לה. משימה שמחכה לפעולה שלך מסתיימת בקוד בזמנה ומסומנת ✅* — משימות שתלויות בה מחכות לקוד בלבד; ה-✅ המלא, והשחרור (13.5), מחכים לפעולה עצמה: ${M.TAL_P0.join(", ")}.`);
  o.push("9. **קו חיתוך** — אם אבן דרך 4 מאחרת ביותר מ-12 שעות: כל ה-P2 עוברות לאחרי השחרור הראשון וכל המסלולים עוברים ל-P0. הסקריפט בודק ששום משימה P0/P1 לא תלויה ב-P2, כך שהחיתוך לא שובר כלום.");
  o.push("10. **לא נכלל בכוונה** — יצירת תמונות מקומית, כתב יד עברי, iCloud, diarization בדפדפן, flashcards (P3 — נבחן בביקורת 13.6).\n");
  // Free text for the update at hand (plan.note): what moved and why, never hidden in the numbers.
  if (plan.note) o.push(`${plan.note}\n`);
  o.push(`**עדיפויות:** P0 = חובה לפני שחרור (${P0.length} משימות, ${Math.floor(sum(P0) / 60)} ש׳) · P1 = world class · P2 = מבדל / רשות. ״נדרש ל-P0״ = משימה שמשימת P0 תלויה בה.\n`);
  o.push("#### השלבים\n");
  o.push("| # | שלב | יעד world class (נמדד) | משימות | מאמץ | התחלה | סיום |\n|---|---|---|---|---|---|---|");
  M.phases.forEach((p, i) => {
    const [a, b] = M.span(p.tasks);
    o.push(`| ${i} | ${cell(p.title)} | ${cell(p.goal ?? "—")} | ${p.tasks.length} | ${dur(sum(p.tasks))} | ${fmt(a)} | ${fmt(b)} |`);
  });
  o.push(`| 15 | מה צריך ממך | — | ${M.owner.length} | ${dur(sum(M.owner))} שלך | ${fmt(Math.min(...M.owner.map((t) => t.start)))} | ${fmt(Math.max(...M.owner.map((t) => t.end)))} |\n`);
  o.push("#### ציר זמן לפי מסלול\n");
  o.push("| מסלול | סדר המשימות | עבודה | סיום |\n|---|---|---|---|");
  for (const [k, v] of Object.entries(lanes)) {
    const ts = laneTasks(M, k);
    o.push(`| ${k} · ${cell(v)} | ${ts.map((t) => t.id).join(" → ")} | ${dur(sum(ts))} | ${fmt(ts[ts.length - 1].end)} |`);
  }
  o.push("");
  M.phases.forEach((p, i) => {
    o.push(`#### ${i}. ${p.title}\n`);
    if (p.goal || p.why) o.push((p.goal ? `**יעד:** ${p.goal}` : "") + (p.goal && p.why ? "  \n" : "") + (p.why ? `**למה:** ${p.why}` : "") + "\n");
    o.push("| # | משימה | עדיפות | מסלול | הערכה | תלוי ב- | התחלה | סיום | מצב | אימות |\n|---|---|---|---|---|---|---|---|---|---|");
    for (const t of p.tasks) {
      const tag = t.new ? " 🆕" : "";
      o.push(`| ${t.id} | ${cell(t.t)}${tag} | ${priTxt(t)} | ${t.lane} | ${est(t)} | ${cell(depsTxt(M, t) || "—")} | ${t.done ? "—" : fmt(t.start)} | ${t.done ? "—" : fmt(t.end)} | ${cell(t.status ?? "⬜")} | ${cell(verifiedTxt(t))} |`);
    }
    o.push("");
    for (const t of p.tasks) {
      const br = t.br !== "—" ? `\`${t.br}\`` : "בלי ענף";
      const extra = (t.tal ? ` · **מחכה לטל: ${t.tal}**` : "") + (t.old && t.old !== t.id ? ` · היה ${t.old}` : "");
      o.push(`**${t.id} · ${t.t}** — ${br} · ${lanes[t.lane]} · ${est(t)} · מקור: ${t.w}${extra}\n`);
      t.steps.forEach((st, k) => o.push(`${t.id}.${k + 1}. ${st}`));
      o.push("\n**קבלה:** " + t.ok.join(" · ") + "\n");
      if (t.notes) o.push(`**פירוט הסטטוס:** ${t.notes}\n`);
    }
  });
  o.push("#### 15. מה צריך ממך\n");
  o.push(`בהנחה של ערבים ${W0}:00–${W1}:00. P0 = השחרור מחכה לזה.\n`);
  o.push("| # | פעולה | פרטים | זמן | מתי (מתוזמן) | עדיפות | פותח את |\n|---|---|---|---|---|---|---|");
  for (const t of M.owner) {
    o.push(`| ${t.id} | ${cell(t.t)} | ${cell(t.steps[0])} | ${cell(t.time)} | ${fmt(t.start)} – ${fmt(t.end)} | ${t.eff} | ${cell(M.OPENS.get(t.id).join(", ") || "—")} |`);
  }
  o.push("");
  return o.join("\n");
}

// ───────────────────────────── HTML ─────────────────────────────

const CSS = `<title>לוח משימות Lumen</title>
<meta name="claude:viewport-fit-sides" content="cover">
<link rel="preconnect" href="https://fonts.googleapis.com"><link rel="preconnect" href="https://fonts.gstatic.com" crossorigin>
<link rel="stylesheet" href="https://fonts.googleapis.com/css2?family=Heebo:wght@400;500;700;800&family=JetBrains+Mono:wght@400;600&display=swap">
<style>
:root{--bg:#f6f7f4;--card:#fff;--fg:#1c2421;--muted:#5d6a64;--line:#dfe4df;--accent:#1f7a4d;--accent-bg:#e3f3ea;--now:#b4610b;--now-bg:#fdf0dd;--new:#2f5fb3;--new-bg:#e6eefb;--tal:#8a3fa0;--tal-bg:#f4e8f7;--soft:#f1f3f0;color-scheme:light}
@media (prefers-color-scheme:dark){:root:not([data-theme="light"]){--bg:#121715;--card:#1a211e;--fg:#e8eeea;--muted:#9aa8a1;--line:#2b3531;--accent:#5fd39a;--accent-bg:#173226;--now:#f2a54a;--now-bg:#3a2a14;--new:#8db4ff;--new-bg:#1b2a45;--tal:#dba3ec;--tal-bg:#33203a;--soft:#161c19;color-scheme:dark}}
:root[data-theme="dark"]{--bg:#121715;--card:#1a211e;--fg:#e8eeea;--muted:#9aa8a1;--line:#2b3531;--accent:#5fd39a;--accent-bg:#173226;--now:#f2a54a;--now-bg:#3a2a14;--new:#8db4ff;--new-bg:#1b2a45;--tal:#dba3ec;--tal-bg:#33203a;--soft:#161c19;color-scheme:dark}
body{background:var(--bg);color:var(--fg);font-family:Heebo,"Segoe UI",Arial,sans-serif;font-size:15px;line-height:1.55;padding-left:max(16px,env(safe-area-inset-left,0px));padding-right:max(16px,env(safe-area-inset-right,0px));padding-block:24px 48px}
.wrap{max-width:1000px;margin:0 auto;display:flex;flex-direction:column;gap:18px}
h1{font-size:28px;font-weight:800;margin:0;text-wrap:balance}
.sub{color:var(--muted);margin:4px 0 0;max-width:72ch}
code,.mono{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;direction:ltr;unicode-bidi:isolate}
code{background:var(--soft);border:1px solid var(--line);border-radius:5px;padding:0 4px;overflow-wrap:anywhere}
.stats{display:grid;grid-template-columns:repeat(auto-fit,minmax(170px,1fr));gap:12px}
.stat{background:var(--card);border:1px solid var(--line);border-radius:12px;padding:14px 16px;min-width:0}
.stat b{display:block;font-size:22px;font-weight:800}
.stat span{color:var(--muted);font-size:13px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;overflow:hidden}
.card>header{display:flex;flex-wrap:wrap;align-items:center;gap:6px 14px;padding:14px 18px;border-bottom:1px solid var(--line)}
.card h2{font-size:18px;margin:0;font-weight:700;flex:1 1 260px;min-width:0;text-wrap:balance}
.num{display:inline-grid;place-items:center;min-width:30px;height:30px;padding:0 4px;border-radius:8px;background:var(--fg);color:var(--bg);font-weight:800;margin-inline-end:8px}
.when{color:var(--muted);font-size:13px}
.target{padding:10px 18px;background:var(--accent-bg);font-size:13.5px;border-bottom:1px solid var(--line)}
.target b{color:var(--accent)}
.why{padding:8px 18px;color:var(--muted);font-size:13px;border-bottom:1px solid var(--line)}
.rules{margin:0;padding:12px 18px 16px;padding-inline-start:36px;display:flex;flex-direction:column;gap:6px;font-size:14px}
details.task{border-bottom:1px solid var(--line)}
details.task:last-child{border-bottom:0}
details.task>summary{list-style:none;cursor:pointer;display:grid;grid-template-columns:52px minmax(0,1fr) auto;gap:4px 12px;padding:10px 18px;align-items:start}
details.task>summary::-webkit-details-marker{display:none}
details.task>summary:hover,details.task[open]>summary{background:var(--soft)}
.tid{font-weight:800}
.tt{min-width:0}
.meta{display:block;color:var(--muted);font-size:12px;margin-top:2px}
.est{font-weight:700;white-space:nowrap;text-align:end}
.dt{display:block;color:var(--muted);font-size:12px;font-weight:400}
.body{padding:4px 18px 14px;padding-inline-start:70px;display:flex;flex-direction:column;gap:10px;min-width:0}
ol.steps{margin:0;padding:0;list-style:none;display:flex;flex-direction:column;gap:5px;font-size:14px}
ol.steps li{display:grid;grid-template-columns:48px minmax(0,1fr);gap:4px}
ol.steps b{color:var(--muted);font-weight:600}
.ok{background:var(--accent-bg);border-radius:10px;padding:8px 12px;font-size:13.5px}
.ok b{color:var(--accent)}
.ok ul{margin:4px 0 0;padding-inline-start:18px}
.pill{font-size:11px;font-weight:700;padding:1px 7px;border-radius:999px;margin-inline-start:6px;white-space:nowrap}
.p-now{background:var(--now-bg);color:var(--now)}
.p-new{background:var(--new-bg);color:var(--new)}
.p-tal{background:var(--tal-bg);color:var(--tal)}
.p-p0{background:var(--fg);color:var(--bg)}
.p-p1{background:var(--accent-bg);color:var(--accent)}
.p-p2{background:var(--soft);color:var(--muted);border:1px solid var(--line)}
.p-v{background:var(--soft);color:var(--fg);border:1px solid var(--line)}
.p-v-owner{background:var(--tal-bg);color:var(--tal);border:0}
.p-v-real{background:var(--accent-bg);color:var(--accent);border:0}
.tbl{overflow-x:auto}
table{width:100%;border-collapse:collapse;font-size:13.5px}
th,td{text-align:start;padding:8px 14px;border-bottom:1px solid var(--line);vertical-align:top}
th{font-size:12px;color:var(--muted);font-weight:600}
tr:last-child td{border-bottom:0}
td.ids{font-family:"JetBrains Mono",ui-monospace,monospace;font-size:12px;line-height:1.7;min-width:220px}
.ms td:first-child{font-weight:800}
@media (max-width:600px){h1{font-size:23px}details.task>summary{grid-template-columns:44px minmax(0,1fr)}.est{grid-column:2;text-align:start}.body{padding-inline-start:18px}}
</style>
<div class="wrap" dir="rtl" lang="he">`;

export function renderHtml(M) {
  const { plan, lanes } = M;
  const B = Math.round(M.BUFFER * 100);
  const [W0, W1] = plan.ownerWindow;
  const NEW_V5 = M.agent.filter((t) => !t.old).length;
  const H = [CSS];
  H.push(`<div><h1>לוח משימות Lumen — תוכנית v5</h1><p class="sub">עודכן ${fmt(M.UPDATED)} · שעון ישראל · כל משימה נפתחת לתתי-שלבים ולקריטריוני קבלה מדידים. ✅ רק כשהקריטריונים נמדדו. שעות לכל משימה = תזמון רציף של 4 מסלולים; אבני הדרך גם עם מרווח ${B}%.</p></div>
<div class="stats">
<div class="stat"><b>${M.agent.length}</b><span>משימות ב-15 שלבים · ${NEW_V5} חדשות ב-v5</span></div>
<div class="stat"><b>${Math.floor(M.EFFORT / 60)} ש׳</b><span>עבודה שנותרה, ב-4 מסלולים מקבילים · ${M.agent.filter((t) => t.done).length} משימות בוצעו</span></div>
<div class="stat"><b>${fmt(M.P0_END)}</b><span>גרסה ראשונה לשחרור (כל ה-P0) · עם מרווח: ${fmt(M.P0_BUF)}</span></div>
<div class="stat"><b>${fmt(M.END)}</b><span>הכול גמור · עם מרווח: ${fmt(M.END_BUF)}</span></div>
<div class="stat"><b>${M.owner.length} פעולות · ${dur(sum(M.owner))}</b><span>מחכות לך (שלב 15) · ${M.TAL_P0.length} מהן לפני השחרור</span></div>
<div class="stat"><b>${M.VERIFIED.real} אמיתי · ${M.VERIFIED.browser} דפדפן</b><span>רמת אימות: ${E(verifiedSummary(M))}</span></div>
</div>`);
  H.push(`<section class="card"><header><h2>אבני דרך</h2></header><div class="tbl"><table class="ms"><thead><tr><th>#</th><th>אבן דרך</th><th>בתזמון</th><th>עם מרווח ${B}%</th></tr></thead><tbody>`);
  M.milestones.forEach((m, k) => H.push(`<tr><td>${k + 1}</td><td>${E(m.title)}</td><td>${fmt(m.at)}</td><td>${fmt(M.stretch(m.at))}</td></tr>`));
  H.push("</tbody></table></div></section>");
  H.push('<section class="card"><header><h2>איך התוכנית רצה</h2></header><ol class="rules">');
  H.push(`<li><b>4 מסלולים במקביל</b> — ${Object.entries(lanes).map(([k, v]) => `${k} ${E(v)}`).join(" · ")}. כל מסלול רץ ב-worktree משלו; אני ממזג, בודק, פותח PR ועונה ל-review.</li>`);
  H.push("<li><b>קבוצות קונפליקט</b> — משימות שנוגעות באותם קבצים חמים לא רצות במקביל, גם במסלולים שונים.</li>");
  H.push("<li><b>הגדרת סיום</b> — קוד + בדיקות, כל קריטריון קבלה נמדד אוטומטית, CI ירוק, כל ממצא review סגור, עמוד תיעוד לפיצ'ר חדש, המסמכים עודכנו.</li>");
  H.push("<li><b>הערכות</b> — 0.45 × אמצע הטווח של מפתח אנושי (מחקר הפערים); מכויל מחדש אחרי שלב 0 לפי שעות אמת.</li>");
  H.push(`<li><b>הפעולות שלך מתוזמנות</b> — בהנחה של ערבים ${W0}:00–${W1}:00 (תגיד אם אחרת). השחרור מחכה ל-${M.TAL_P0.join(", ")}.</li>`);
  H.push("<li><b>✅ / ✅* / ⏳ / ⬜</b> — ✅* = עובד מול mocks בלבד; הופך ל-✅ אחרי מודל אמיתי (זעיר ב-CI או אצלך).</li>");
  H.push("<li><b>מודלים</b> — רק עם רישיון מסחרי מאומת. spike לפני כל מודל: נטען? גודל? איכות על סט מוחזק? אחרת — החלופה הרשומה.</li>");
  H.push("<li><b>סטי זהב מוחזקים</b> — נבנים ומוקפאים על ידי סוכן שלא מממש, לפני המימוש.</li>");
  H.push("<li><b>קו חיתוך</b> — אבן דרך 4 מאחרת ביותר מ-12 שעות → כל ה-P2 לאחרי השחרור הראשון. שום P0/P1 לא תלויה ב-P2 (נבדק בסקריפט).</li></ol>");
  if (plan.note) H.push(`<div class="why">${codeHtml(plan.note).replace(/\*\*([^*]+)\*\*/g, "<b>$1</b>")}</div>`);
  H.push("</section>");
  H.push('<section class="card"><header><h2>ציר זמן לפי מסלול</h2></header><div class="tbl"><table><thead><tr><th>מסלול</th><th>סדר המשימות</th><th>עבודה</th><th>סיום</th></tr></thead><tbody>');
  for (const [k, v] of Object.entries(lanes)) {
    const ts = laneTasks(M, k);
    H.push(`<tr><td><b>${k}</b> · ${E(v)}</td><td class="ids">${ts.map((t) => t.id).join(" ← ")}</td><td>${dur(sum(ts))}</td><td>${fmt(ts[ts.length - 1].end)}</td></tr>`);
  }
  H.push("</tbody></table></div></section>");
  M.phases.forEach((p, i) => {
    const [a, b] = M.span(p.tasks);
    H.push(`<section class="card" id="p${i}"><header><h2><span class="num">${i}</span>${E(p.title)}</h2><span class="when">${p.tasks.length} משימות · ${dur(sum(p.tasks))} · ${fmt(a)} ← ${fmt(b)}</span></header>`);
    if (p.goal) H.push(`<div class="target"><b>יעד world class:</b> ${codeHtml(p.goal)}</div>`);
    if (p.why) H.push(`<div class="why">${codeHtml(p.why)}</div>`);
    for (const t of p.tasks) {
      let pills = "";
      if (t.status) pills += `<span class="pill p-now">${E(t.status)}</span>`;
      if (t.verified) pills += `<span class="pill p-v p-v-${t.verified}">אימות: ${E(VERIFIED_LABEL[t.verified])}${t.pr ? ` · <a href="${PR_URL}${t.pr}">#${t.pr}</a>` : ""}</span>`;
      if (t.new) pills += '<span class="pill p-new">חדש</span>';
      pills += `<span class="pill p-${t.eff.toLowerCase()}">${E(priTxt(t))}</span>`;
      if (t.tal) pills += `<span class="pill p-tal">מחכה לך: ${E(t.tal)}</span>`;
      const d = depsTxt(M, t);
      const meta = `${t.lane} · ${E(lanes[t.lane])}` + (d ? ` · תלוי ב-${E(d)}` : "") + (t.br !== "—" ? ` · <span class="mono">${E(t.br)}</span>` : "");
      const when = t.done ? "" : fmt(t.start) + " – " + (sameDay(t.end, t.start) ? hhmm(t.end) : fmt(t.end));
      H.push(`<details class="task"><summary><span class="tid">${t.id}</span><span class="tt">${codeHtml(t.t)}${pills}<span class="meta">${meta}</span></span><span class="est">${est(t)}<span class="dt">${when}</span></span></summary>`);
      H.push('<div class="body"><ol class="steps">');
      t.steps.forEach((st, k) => H.push(`<li><b>${t.id}.${k + 1}</b><span>${codeHtml(st)}</span></li>`));
      H.push('</ol><div class="ok"><b>קבלה (נמדד):</b><ul>' + t.ok.map((x) => `<li>${codeHtml(x)}</li>`).join("") + `</ul></div>${t.notes ? `<div class="why"><b>פירוט הסטטוס:</b> ${codeHtml(t.notes)}</div>` : ""}<div class="meta">מקור: ${codeHtml(t.w)}${t.old && t.old !== t.id ? " · היה " + E(t.old) : ""}</div></div></details>`);
    }
    H.push("</section>");
  });
  H.push(`<section class="card" id="p15"><header><h2><span class="num">15</span>מה צריך ממך</h2><span class="when">מתוזמן לערבים ${W0}:00–${W1}:00 · משימות שמחכות לך מסומנות בסגול</span></header><div class="tbl"><table><thead><tr><th>#</th><th>פעולה</th><th>פרטים</th><th>זמן</th><th>מתי</th><th>פותח את</th></tr></thead><tbody>`);
  for (const t of [...M.owner].sort((a, b) => a.start - b.start)) {
    const pill = t.eff === "P0" ? '<span class="pill p-p0">P0</span>' : "";
    H.push(`<tr><td><b>${t.id}</b></td><td><b>${E(t.t)}</b>${pill}</td><td>${codeHtml(t.steps[0])}</td><td>${E(t.time)}</td><td>${fmt(t.start)}</td><td class="mono">${E(M.OPENS.get(t.id).join(", ") || "—")}</td></tr>`);
  }
  H.push("</tbody></table></div></section></div>");
  return H.join("\n");
}

// ───────────────────────────── document ─────────────────────────────

/** MASTER_PLAN.md with its board section replaced. */
export function spliceBoard(doc, board) {
  const i = doc.indexOf(BOARD_START);
  const j = doc.indexOf(BOARD_END);
  if (i < 0 || j < i) throw new Error(`${DOC_FILE}: no board section ("${BOARD_START}" … "${BOARD_END}")`);
  return doc.slice(0, i) + board.trimEnd() + "\n\n---\n\n" + doc.slice(j);
}

// ───────────────────────────── actual hours ─────────────────────────────

/**
 * Actual hours per task: the first and last commit of the task's own
 * branch, read via git. Branches are stacked, so "own" means: on
 * origin/<branch> and on no other remote branch that does not contain it —
 * not on the base, its ancestors or its siblings, while the descendants
 * (which contain it) are not subtracted. A task done in one commit shows 0 h. Tasks whose branch is not on the remote
 * are left out. The span is first to last commit, so a task that paused
 * overnight counts the pause.
 */
export function actualHours(M, { root = ROOT, base = "origin/main", remote = "origin" } = {}) {
  const git = (...args) => execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"], maxBuffer: 64 << 20 }).trim();
  const remoteBranches = new Set(git("for-each-ref", "--format=%(refname:short)", `refs/remotes/${remote}`).split("\n").filter(Boolean));
  const taskRefs = [...new Set(M.agent.map((t) => t.br).filter((b) => b && b !== "—").map((b) => `${remote}/${b}`))].filter((r) => remoteBranches.has(r));
  const out = [];
  for (const t of M.agent) {
    const ref = `${remote}/${t.br}`;
    if (!taskRefs.includes(ref)) continue;
    let times;
    try {
      const containing = new Set(git("branch", "-r", "--contains", ref, "--format=%(refname:short)").split("\n").filter(Boolean));
      // Every remote branch that does not contain this one: base, ancestors, siblings, other stacks.
      const others = [base, ...remoteBranches].filter((r) => r !== ref && r !== remote && !r.endsWith("/HEAD") && !containing.has(r));
      times = git("log", "--format=%cI", ref, "--not", ...others).split("\n").filter(Boolean);
    } catch {
      continue;
    }
    if (!times.length) continue;
    const first = Date.parse(times[times.length - 1]);
    const last = Date.parse(times[0]);
    out.push({ id: t.id, branch: t.br, commits: times.length, first: times[times.length - 1], last: times[0], hours: Math.round(((last - first) / 3_600_000) * 100) / 100, estimate: t.m_est / 60 });
  }
  return out;
}

// ───────────────────────────── work in progress (W6.39) ─────────────────────────────

/**
 * Plan W6.39 — no new wave before the previous one is verified. A wave (a
 * phase titled "גל N — …") is over its limit when more than `limit` of its
 * ⏳ tasks are verified below `browser`; while it is, starting tasks of the
 * next wave is the warning. A task without a `verified` level (plan W4.24)
 * counts as below `browser`: unknown is not verified.
 */
export const WIP_LIMIT = 5;
/** Verification levels, weakest first (the W4.24 order: `owner` = only the owner's real-world part is left). */
export const WIP_LEVELS = Object.freeze(["built", "node", "browser", "real", "owner"]);
export const WIP_FLOOR = "browser";

/** The wave number of a phase title ("גל 6 — …" → 6), or null for the numbered phases before the waves. */
export function waveNumber(title) {
  const m = /^גל\s+(\d+)/.exec(String(title ?? "").trim());
  return m ? Number(m[1]) : null;
}

/** ⏳ and verified below the floor (or not at all). */
export function belowFloor(task, floor = WIP_FLOOR) {
  if (!String(task.status ?? "").startsWith("⏳")) return false;
  return WIP_LEVELS.indexOf(task.verified) < WIP_LEVELS.indexOf(floor);
}

/** A task is started once it has a status (a PR, work in progress, or done). */
export const isStarted = (task) => String(task.status ?? "").trim() !== "";

/**
 * Every wave over its limit whose next wave has started:
 * [{ wave, next, limit, open: [ids below the floor], unlabelled, started: [ids of the next wave] }].
 * The limit is `limit`, else plan.schedule.wipLimit, else WIP_LIMIT.
 */
export function wipWarnings(plan, { limit } = {}) {
  const max = Number.isInteger(limit) && limit >= 0 ? limit : Number.isInteger(plan.schedule?.wipLimit) ? plan.schedule.wipLimit : WIP_LIMIT;
  const waves = plan.phases
    .map((p) => ({ n: waveNumber(p.title), tasks: p.tasks }))
    .filter((w) => w.n !== null)
    .sort((a, b) => a.n - b.n);
  const out = [];
  for (let i = 0; i + 1 < waves.length; i++) {
    const open = waves[i].tasks.filter((t) => belowFloor(t));
    const started = waves[i + 1].tasks.filter(isStarted);
    if (open.length > max && started.length) {
      out.push({ wave: waves[i].n, next: waves[i + 1].n, limit: max, open: open.map((t) => t.id), unlabelled: open.filter((t) => t.verified === undefined).length, started: started.map((t) => t.id) });
    }
  }
  return out;
}

/** One line per warning, for the terminal. */
export function formatWip(w) {
  const list = (ids) => (ids.length > 8 ? `${ids.slice(0, 8).join(", ")} … (+${ids.length - 8})` : ids.join(", "));
  return `plan: WIP — wave ${w.wave} has ${w.open.length} ⏳ tasks verified below ${WIP_FLOOR} (limit ${w.limit}${w.unlabelled ? `; ${w.unlabelled} with no verified level` : ""}) while wave ${w.next} has ${w.started.length} started (${list(w.started)}). Verify wave ${w.wave} first: ${list(w.open)}.`;
}

// ───────────────────────────── CLI ─────────────────────────────

export function run({ root = ROOT, check = false, wipLimit } = {}) {
  const plan = JSON.parse(readFileSync(join(root, PLAN_FILE), "utf8"));
  // Plan 0.7: no ✅ without the commands that prove it.
  const dodProblems = checkDod(plan);
  if (dodProblems.length) throw new Error(`plan: definition of done —\n  ${dodProblems.join("\n  ")}`);
  const verifiedProblems = checkVerified(plan);
  if (verifiedProblems.length) throw new Error(`plan: verified / pr (W4.24) —\n  ${verifiedProblems.join("\n  ")}`);
  const levelProblems = checkDoneLevel(plan);
  if (levelProblems.length) throw new Error(`plan: ✅ below browser (W10.G8) —\n  ${levelProblems.join("\n  ")}`);
  const lengthProblems = checkStatusLength(plan);
  if (lengthProblems.length) throw new Error(`plan: status length (W10.G7) —\n  ${lengthProblems.join("\n  ")}`);
  const M = buildModel(plan);
  const docPath = join(root, DOC_FILE);
  const htmlPath = join(root, HTML_FILE);
  const doc = readFileSync(docPath, "utf8");
  const wantDoc = spliceBoard(doc, renderBoard(M));
  const wantHtml = renderHtml(M);
  const stale = [];
  if (doc !== wantDoc) stale.push(DOC_FILE);
  if (!existsSync(htmlPath) || readFileSync(htmlPath, "utf8") !== wantHtml) stale.push(HTML_FILE);
  if (!check) {
    if (stale.includes(DOC_FILE)) writeFileSync(docPath, wantDoc);
    if (stale.includes(HTML_FILE)) writeFileSync(htmlPath, wantHtml);
  }
  return { M, stale, wip: wipWarnings(plan, { limit: wipLimit }) };
}

function main(argv) {
  const check = argv.includes("--check");
  const at = argv.indexOf("--wip-limit");
  const wipLimit = at >= 0 ? Number(argv[at + 1]) : undefined;
  if (at >= 0 && !(Number.isInteger(wipLimit) && wipLimit >= 0)) throw new Error(`plan: --wip-limit takes a whole number, not ${JSON.stringify(argv[at + 1])}`);
  const { M, stale, wip } = run({ check, wipLimit });
  const P0 = M.agent.filter((t) => t.eff === "P0").length;
  const levels = [...VERIFIED_LEVELS.map((k) => `${k} ${M.VERIFIED[k]}`), ...(M.VERIFIED.none ? [`unset ${M.VERIFIED.none}`] : [])].join(", ");
  const summary = `${M.agent.length} tasks, ${M.owner.length} owner items, ${Math.floor(M.EFFORT / 60)} h left; release (P0, ${P0} tasks) ${fmt(M.P0_END)}, end ${fmt(M.END)}; verified: ${levels}`;
  if (argv.includes("--hours")) {
    const base = argv[argv.indexOf("--hours") + 1]?.startsWith("--") === false ? argv[argv.indexOf("--hours") + 1] : "origin/main";
    for (const h of actualHours(M, { base })) console.log(`${h.id.padEnd(6)} ${h.branch.padEnd(32)} ${String(h.commits).padStart(3)} commits  ${h.hours.toFixed(2).padStart(6)} h actual  ${h.estimate.toFixed(2).padStart(6)} h estimated`);
  }
  if (check) {
    for (const w of wip) console.error(formatWip(w));
    if (wip.length && argv.includes("--wip-strict")) {
      console.error(`plan: ${wip.length} wave${wip.length > 1 ? "s" : ""} over the work-in-progress limit (--wip-strict).`);
      return 1;
    }
    if (stale.length) {
      console.error(`plan: ${stale.join(" and ")} ${stale.length > 1 ? "differ" : "differs"} from ${PLAN_FILE}. Run \`npm run plan\` and commit the result.`);
      return 1;
    }
    console.log(`plan: ${DOC_FILE} and ${HTML_FILE} match ${PLAN_FILE} (${summary})`);
    return 0;
  }
  console.log(stale.length ? `plan: wrote ${stale.join(", ")} (${summary})` : `plan: up to date (${summary})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e.message ?? e));
    process.exit(1);
  }
}
