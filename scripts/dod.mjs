#!/usr/bin/env node
/**
 * Plan 0.7 — the definition-of-done checker.
 *
 * A task's `dod` in plan/plan.json is the list of commands that prove its
 * acceptance criteria. This script runs them; the plan build (plan:check)
 * refuses a task marked ✅ that has none, so ✅ always means "a command
 * that anyone can run went green".
 *
 *   node scripts/dod.mjs 0.6 4.12      run the DoD of these tasks
 *   node scripts/dod.mjs --done        every ✅ / ✅* task that has a DoD (CI)
 *   node scripts/dod.mjs --list        which tasks have a DoD, which are grandfathered
 *   node scripts/dod.mjs 0.6 --dry     print the commands, run nothing
 *   node scripts/dod.mjs 0.6 --markdown  the PR checklist for these tasks
 *
 * ✅* (green against mocks only — no GPU / Ollama here) is set with
 * `"dodMock": true`: such a task can never be plain ✅ until the real-model
 * check named in its owner item replaces the mock.
 */
import { readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { spawnSync } from "node:child_process";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
export const PLAN_FILE = "plan/plan.json";

/** @param {{ phases: { tasks: any[] }[] }} plan */
export const allTasks = (plan) => plan.phases.flatMap((p) => p.tasks);

/** ✅ but not ✅* */
export const isFullDone = (status = "") => status.startsWith("✅") && !status.startsWith("✅*");
export const isMockDone = (status = "") => status.startsWith("✅*");

/**
 * The tasks that were ✅ before 0.7 existed, frozen here when 0.7 landed. The plan's
 * `dodGrandfathered` must be a subset: this constant only ever loses ids (a reviewer
 * sees any edit to it), so a new ✅ can't be exempted by adding its id to plan.json.
 */
export const DOD_GRANDFATHER_BASELINE = Object.freeze(["0.1", "0.2", "0.3", "0.4", "0.5", "0.8", "0.9", "0.10", "0.11", "0.12", "0.13", "0.14", "0.17", "0.18", "0.20", "0.21", "1.1", "1.2", "1.3", "1.4", "1.5", "1.6", "1.7", "1.9", "2.1", "2.2", "2.3", "2.4", "2.5", "2.7", "2.8", "3.1", "3.2", "3.6", "4.1", "4.2", "4.3", "4.4", "4.5", "4.6", "4.7", "4.8", "4.9", "4.10", "4.12", "5.1", "5.2", "5.3", "5.11", "6.0", "6.1", "7.1", "7.10", "8.5", "9.1", "9.2", "9.3", "9.7", "9.8", "14.1"]);

/**
 * The rule plan:check enforces. Returns a list of problems (empty = fine).
 * - every ✅ / ✅* task has a non-empty `dod`, unless it is grandfathered
 *   (marked ✅ before 0.7 existed; the list only shrinks)
 * - a task with `dodMock: true` is ✅*, never plain ✅
 * - every grandfathered id is in DOD_GRANDFATHER_BASELINE — the list frozen when 0.7
 *   landed — so the plan's list can only shrink, never grow (Codex P1 on #265)
 * - grandfathered ids exist, are still ✅ / ✅*, and have no `dod` yet. Adding a dod, or
 *   taking a task back to ⏳, means taking its id off the list in the same edit — so a
 *   reopened task can't return to ✅ without a dod (Codex P1 on #265)
 * - the shrink is one-way: an id that leaves `dodGrandfathered` is recorded in
 *   `dodRevoked` in the same edit (every baseline id is in exactly one of the two
 *   lists), and a revoked id can never be grandfathered again — so the ratchet can't
 *   be reversed by deleting a dod and re-adding the id (Codex P1 on #265)
 * - a ✅* task declares `dodMock: true`; without it a later edit could turn ✅* into
 *   plain ✅ and re-run the same mock-only commands as the real check (Codex P1 on #265)
 * - every `dod` entry is a non-empty string
 * @param {any} plan
 * @param {{ baseline?: readonly string[] }} [opts]
 * @returns {string[]}
 */
export function checkDod(plan, { baseline = DOD_GRANDFATHER_BASELINE } = {}) {
  const problems = [];
  const tasks = allTasks(plan);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  const grand = new Set(plan.dodGrandfathered ?? []);
  const revoked = new Set(plan.dodRevoked ?? []);
  const frozen = new Set(baseline);
  for (const id of revoked) {
    if (!frozen.has(id)) problems.push(`dodRevoked: ${id} was never grandfathered — only ids that left dodGrandfathered belong here`);
    if (grand.has(id)) problems.push(`dodGrandfathered: ${id}'s exemption was revoked (dodRevoked) — it cannot be grandfathered again; keep its dod`);
  }
  for (const id of frozen) {
    if (!grand.has(id) && !revoked.has(id)) problems.push(`dodGrandfathered: ${id} left the list without being recorded in dodRevoked — the exemption ends for good`);
  }
  for (const id of grand) {
    const t = byId.get(id);
    if (!t) problems.push(`dodGrandfathered: ${id} is not a task`);
    else if (t.dod?.length) problems.push(`dodGrandfathered: ${id} has a dod now — take it off the list`);
    else if (!(t.status ?? "").startsWith("✅")) problems.push(`dodGrandfathered: ${id} is not done any more — take it off the list (it needs a dod to be ✅ again)`);
    if (!frozen.has(id)) problems.push(`dodGrandfathered: ${id} was not ✅ before 0.7 — the list only shrinks; give the task a dod instead`);
  }
  for (const t of tasks) {
    const status = t.status ?? "";
    if (t.dod !== undefined && (!Array.isArray(t.dod) || t.dod.some((c) => typeof c !== "string" || !c.trim()))) {
      problems.push(`${t.id}: dod must be a list of commands`);
    }
    if (!status.startsWith("✅")) continue;
    if (!t.dod?.length && !grand.has(t.id)) problems.push(`${t.id} is marked ${status.slice(0, 2).trim()} without a dod — add the commands that prove it (plan 0.7)`);
    if (t.dodMock && isFullDone(status)) problems.push(`${t.id} is checked against mocks only (dodMock) — mark it ✅*, not ✅`);
    if (isMockDone(status) && !t.dodMock) problems.push(`${t.id} is ✅* without "dodMock": true — declare it, so the status can't become ✅ before the real-model check replaces the mock`);
  }
  return problems;
}

/**
 * @param {any} plan
 * @param {{ ids?: string[], done?: boolean }} sel
 */
export function select(plan, { ids = [], done = false }) {
  const tasks = allTasks(plan);
  if (done) return tasks.filter((t) => (t.status ?? "").startsWith("✅") && t.dod?.length);
  const byId = new Map(tasks.map((t) => [t.id, t]));
  return ids.map((id) => {
    const t = byId.get(id);
    if (!t) throw new Error(`dod: no task ${id}`);
    return t;
  });
}

/** The PR checklist (task template, plan 0.7.3). */
export function markdown(tasks) {
  const lines = [];
  for (const t of tasks) {
    lines.push(`### ${t.id} · ${t.title}`);
    for (const a of t.acceptance ?? []) lines.push(`- [ ] ${a}`);
    if (t.dod?.length) for (const c of t.dod) lines.push(`- [ ] \`${c}\` green`);
    else lines.push("- [ ] **no `dod` yet** — add the commands to plan/plan.json");
    if (t.dodMock) lines.push("- [ ] mocks only → ✅*; the real-model check stays with the owner item");
    lines.push("");
  }
  return lines.join("\n");
}

/**
 * Runs each task's commands in order; a task stops at its first failure.
 * @returns {{ id: string, ok: boolean, failed?: string, ms: number }[]}
 */
export function runDod(tasks, { root = ROOT, exec = defaultExec, log = console.log } = {}) {
  const results = [];
  for (const t of tasks) {
    const t0 = Date.now();
    let failed;
    for (const cmd of t.dod ?? []) {
      log(`dod ${t.id} › ${cmd}`);
      if (!exec(cmd, root)) {
        failed = cmd;
        break;
      }
    }
    results.push({ id: t.id, ok: !failed && !!t.dod?.length, failed, ms: Date.now() - t0 });
  }
  return results;
}

function defaultExec(cmd, cwd) {
  const r = spawnSync(cmd, { cwd, shell: true, stdio: "inherit" });
  return r.status === 0;
}

function main(argv) {
  const plan = JSON.parse(readFileSync(join(ROOT, PLAN_FILE), "utf8"));
  const flags = new Set(argv.filter((a) => a.startsWith("--")));
  const ids = argv.filter((a) => !a.startsWith("--"));
  if (flags.has("--list")) {
    const tasks = allTasks(plan);
    const grand = new Set(plan.dodGrandfathered ?? []);
    const withDod = tasks.filter((t) => t.dod?.length);
    console.log(`${withDod.length} tasks with a dod: ${withDod.map((t) => t.id).join(", ") || "—"}`);
    console.log(`${grand.size} grandfathered (done before 0.7, no dod yet): ${[...grand].join(", ") || "—"}`);
    const problems = checkDod(plan);
    for (const p of problems) console.error(`  ✗ ${p}`);
    return problems.length ? 1 : 0;
  }
  const tasks = select(plan, { ids, done: flags.has("--done") });
  if (!tasks.length) {
    console.error(flags.has("--done") ? "dod: no done task has a dod yet" : "usage: node scripts/dod.mjs <task id…> | --done | --list [--dry | --markdown]");
    return flags.has("--done") ? 0 : 2;
  }
  if (flags.has("--markdown")) {
    console.log(markdown(tasks));
    return 0;
  }
  if (flags.has("--dry")) {
    for (const t of tasks) for (const c of t.dod ?? ["(no dod)"]) console.log(`${t.id}\t${c}`);
    return 0;
  }
  const results = runDod(tasks);
  console.log("");
  for (const r of results) console.log(`${r.ok ? "✓" : "✗"} ${r.id.padEnd(6)} ${(r.ms / 1000).toFixed(1).padStart(6)} s${r.failed ? `  failed: ${r.failed}` : r.ok ? "" : "  no dod"}`);
  const bad = results.filter((r) => !r.ok);
  console.log(bad.length ? `dod: ${bad.length} of ${results.length} not green` : `dod: ${results.length} green`);
  return bad.length ? 1 : 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  try {
    process.exit(main(process.argv.slice(2)));
  } catch (e) {
    console.error(String(e?.message ?? e));
    process.exit(1);
  }
}
