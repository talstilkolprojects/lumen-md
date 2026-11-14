#!/usr/bin/env node
/**
 * One command per owner session (plan W6.20; docs: project/owner-session-command).
 *
 *   npm run owner:session -- accounts|gpu|devices   run the session: each step prints what to do,
 *                                                   offers to run its commands, checks the result
 *                                                   and records a signed receipt; resumes where it stopped
 *   npm run owner:session -- status                 every step: done / open, estimated vs actual minutes
 *   npm run owner:session -- check [session]        run the automatic checks only (no prompts, no receipts)
 *   npm run owner:session -- collect [--write]      gather every owner command from the open PRs, dedupe,
 *                                                   assign; exit 1 if any is unassigned
 *
 *   --redo <step id>   run a done step again          --yes        run a step's commands without asking
 *   --lang he|en       language (default: $LANG)      --dir <d>    receipts folder (default reports/owner)
 *   --from <prs.json>  collect from a saved PR list instead of `gh api`
 *
 * Receipts: reports/owner/<session>/<step>.json, sealed with Tal's Ed25519 key
 * (scripts/owner/receipt.mjs); the public half is reports/owner/PUBLIC_KEY.pem.
 * scripts/plan/receipts.mjs and scripts/plan/areas.mjs (W6.44) read them.
 */
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createInterface } from "node:readline/promises";
import { check, loadOrCreateKey, seal } from "./receipt.mjs";
import { REPO, SESSIONS, STEPS, stepById, stepsOf } from "./steps.mjs";
import { collect } from "./collect.mjs";

export const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
export const INBOX_FILE = "scripts/owner/inbox.json";
/** Plan owner items (15.x) that no session step carries, and why (owner-sessions page, "Taken off the owner's list"). */
export const OFF_LIST = { "15.2": "decided 10.11: neither Codex nor Renovate", "15.5": "deferred, optional (Drive/Dropbox OAuth)", "15.6": "deferred (monitoring DSN)", "15.10": "decided 10.11 (licensing)", "15.16": "delegated to the coordinator" };

// ── the real world, behind one object so tests can replace it ──
export function realContext({ root = ROOT, env = process.env } = {}) {
  const home = env.HOME || homedir();
  const path = (p) => (p.startsWith("~/") ? join(home, p.slice(2)) : p === "~" ? home : isAbsolute(p) ? p : join(root, p));
  /** interactive: the owner sees the command's output and can answer its prompts (actions); else it is captured (checks). */
  const exec = async (cmd, args, { stdin, interactive = false } = {}) => {
    const stdio = interactive ? [stdin === undefined ? "inherit" : "pipe", "inherit", "inherit"] : "pipe";
    const r = spawnSync(cmd, args.map((a) => (a.startsWith("~/") ? path(a) : a)), { cwd: root, encoding: "utf8", input: stdin, stdio, maxBuffer: 64 << 20, env, timeout: interactive ? undefined : 90_000 });
    return { status: r.status ?? 1, stdout: r.stdout ?? "", stderr: r.stderr ?? String(r.error ?? "") };
  };
  return {
    env,
    root,
    path,
    ran: {},
    exec,
    which: (cmd) => spawnSync("sh", ["-c", `command -v ${cmd}`], { encoding: "utf8" }).status === 0,
    exists: (p) => existsSync(p),
    mkdirp: (p) => mkdirSync(p, { recursive: true }),
    read: (p) => readFileSync(p, "utf8"),
    mode: (p) => statSync(p).mode & 0o777,
    list: (p) => {
      try {
        return readdirSync(p);
      } catch {
        return []; // why: a missing folder is an empty one for the checks
      }
    },
    gh: async (p) => {
      const r = spawnSync("gh", ["api", p], { encoding: "utf8", maxBuffer: 64 << 20, env });
      if (r.status === 0) {
        try {
          return { status: 200, json: JSON.parse(r.stdout) };
        } catch {
          return { status: 200, json: null };
        }
      }
      const m = String(r.stderr).match(/HTTP (\d{3})/);
      return { status: m ? Number(m[1]) : 0, json: null };
    },
    fetch: async (url, init = {}) => {
      try {
        const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(20_000), ...init });
        const text = init.method === "HEAD" ? "" : await r.text();
        let json = null;
        try {
          json = JSON.parse(text);
        } catch {
          /* why: not every answer is JSON */
        }
        return { status: r.status, json, text };
      } catch (e) {
        return { status: 0, json: null, text: String(e?.message ?? e) };
      }
    },
  };
}

// ── receipts on disk ──
export const receiptPath = (dir, stepId) => join(dir, `${stepId}.json`);
/** The verified receipt of each step: { [stepId]: report }. A receipt that does not verify is ignored (and reported). */
export function loadState(dir) {
  const pubPath = join(dir, "PUBLIC_KEY.pem");
  const out = {};
  const bad = [];
  if (!existsSync(pubPath)) return { state: out, bad };
  const pub = readFileSync(pubPath, "utf8");
  for (const s of STEPS) {
    const f = receiptPath(dir, s.id);
    if (!existsSync(f)) continue;
    let r;
    try {
      r = JSON.parse(readFileSync(f, "utf8"));
    } catch {
      bad.push(`${f}: not JSON`);
      continue;
    }
    const v = check(r, pub);
    if (v.ok && r.step === s.id) out[s.id] = r;
    else bad.push(`${f}: ${v.problems.join("; ") || "another step"}`);
  }
  return { state: out, bad };
}

// ── one step ──
const T = (lang, o) => o[lang] ?? o.en;
const mark = (ok) => (ok === true ? "✓" : ok === false ? "✗" : "?");

/** Run the automatic checks of a step → [{ id, auto, ok, detail }]. */
export async function runChecks(step, ctx) {
  const out = [];
  for (const c of step.checks.filter((x) => x.auto)) {
    let r;
    try {
      r = await c.run(ctx);
    } catch (e) {
      r = { ok: null, detail: `the check failed to run: ${e?.message ?? e}` };
    }
    out.push({ id: c.id, auto: true, ok: r.ok, detail: r.detail });
  }
  return out;
}

/**
 * The interactive step: print, offer the actions, wait, check, ask the
 * attestations, seal. io = { say(text), ask(question) → answer }.
 * → the sealed receipt.
 */
export async function runStep(step, ctx, io, { lang = "en", yes = false, previous = null, now = () => new Date(), commit = null, key }) {
  const started = now();
  io.say(`\n━━ ${step.id} · ${T(lang, step)} · ≈ ${step.minutes} min${step.prs.length ? ` · ${step.prs.map((n) => `#${n}`).join(" ")}` : ""}`);
  for (const [i, line] of step.do[lang === "he" ? "he" : "en"].entries()) io.say(`  ${i + 1}. ${line}`);
  const actions = [];
  for (const a of step.actions ?? []) {
    if (a.unless && ctx.exists(ctx.path(a.unless))) {
      io.say(`  · ${a.en}: already there (${a.unless})`);
      continue;
    }
    if ((a.needsFile && !ctx.exists(ctx.path(a.needsFile))) || (a.needsScript && !ctx.exists(ctx.path("package.json")))) {
      io.say(`  · ${a.en}: skipped, ${a.needsFile ?? a.needsScript} is not in this checkout`);
      continue;
    }
    if (a.needsScript) {
      let scripts = {};
      try {
        scripts = JSON.parse(ctx.read(ctx.path("package.json"))).scripts ?? {};
      } catch {
        /* why: no package.json → the script is missing */
      }
      if (!scripts[a.needsScript]) {
        io.say(`  · ${a.en}: skipped, \`npm run ${a.needsScript}\` is not in this checkout`);
        continue;
      }
    }
    const shown = a.cmd ? a.cmd.join(" ") : a.en;
    const go = yes || /^(|y|yes|כ|כן)$/i.test((await io.ask(`  ▶ ${a.en}\n    ${shown}\n    Run it? [Y/n] `)).trim());
    if (!go) {
      actions.push({ en: a.en, ran: false });
      continue;
    }
    if (a.unless) ctx.mkdirp?.(dirname(ctx.path(a.unless)));
    const r = a.fn ? await a.fn(ctx) : await ctx.exec(a.cmd[0], a.cmd.slice(1), { stdin: a.stdin, interactive: true });
    const exit = a.fn ? (r.ok ? 0 : 1) : r.status;
    if (a.record) ctx.ran[a.record] = exit;
    io.say(`    ${exit === 0 ? "✓" : "✗"} exit ${exit}${r.detail ? ` · ${r.detail}` : ""}`);
    actions.push({ en: a.en, ran: true, exit });
  }
  await io.ask(lang === "he" ? "  ⏎ Enter כשסיימת את מה שלמעלה " : "  ⏎ Press Enter when the above is done ");
  const checks = await runChecks(step, ctx);
  for (const c of checks) io.say(`  ${mark(c.ok)} ${T(lang, step.checks.find((x) => x.id === c.id))} — ${c.detail}`);
  for (const c of step.checks.filter((x) => !x.auto)) {
    const a = (await io.ask(`  ? ${T(lang, c)} [y/N] `)).trim();
    const ok = /^(y|yes|כ|כן)$/i.test(a);
    checks.push({ id: c.id, auto: false, ok, attested: true, detail: ok ? "attested by the owner" : "not yet" });
  }
  const finished = now();
  const actual = Math.round((finished.getTime() - started.getTime()) / 60_000) + (previous?.minutes?.actual ?? 0);
  const done = checks.every((c) => c.ok === true);
  const report = {
    format: "lumen-owner",
    version: 1,
    kind: "owner",
    session: step.session,
    step: step.id,
    title: step.en,
    plan: step.plan,
    prs: step.prs,
    commit,
    startedAt: previous?.startedAt ?? started.toISOString(),
    finishedAt: finished.toISOString(),
    minutes: { estimated: step.minutes, actual },
    actions,
    checks,
    done,
  };
  io.say(done ? `  ✓ ${step.id} done (${actual} min, estimated ${step.minutes})` : `  … ${step.id} recorded as open: ${checks.filter((c) => c.ok !== true).map((c) => c.id).join(", ")} — the next run resumes here`);
  return seal(report, key);
}

// ── commands ──
function headCommit(root) {
  const sha = spawnSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  const branch = spawnSync("git", ["rev-parse", "--abbrev-ref", "HEAD"], { cwd: root, encoding: "utf8" }).stdout.trim();
  return sha ? { sha, branch } : null;
}

export function statusLines(state, lang = "en") {
  const lines = [];
  for (const [id, s] of Object.entries(SESSIONS)) {
    const steps = stepsOf(id);
    const est = steps.reduce((n, x) => n + x.minutes, 0);
    const act = steps.reduce((n, x) => n + (state[x.id]?.minutes?.actual ?? 0), 0);
    lines.push(`${T(lang, s)} — ${steps.filter((x) => state[x.id]?.done).length}/${steps.length} done · estimated ${est} min · actual so far ${act} min`);
    for (const x of steps) {
      const r = state[x.id];
      const open = r ? r.checks.filter((c) => c.ok !== true).map((c) => c.id) : [];
      lines.push(`  ${r?.done ? "✓" : r ? "…" : "·"} ${x.id.padEnd(24)} ${String(x.minutes).padStart(3)} min est${r ? ` · ${r.minutes.actual} min actual · ${r.finishedAt.slice(0, 16)}` : ""}${open.length ? ` · open: ${open.join(", ")}` : ""}`);
    }
  }
  return lines;
}

function ghPulls() {
  const all = [];
  for (let page = 1; page < 20; page++) {
    const r = spawnSync("gh", ["api", `repos/${REPO}/pulls?state=open&per_page=100&page=${page}`], { encoding: "utf8", maxBuffer: 256 << 20 });
    if (r.status !== 0) throw new Error(`gh api pulls page ${page}: ${r.stderr}`);
    const batch = JSON.parse(r.stdout);
    all.push(...batch.map((p) => ({ number: p.number, title: p.title, body: p.body ?? "" })));
    if (batch.length < 100) break;
  }
  return all;
}

async function main(argv) {
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const lang = opt("lang") ?? (/^he/i.test(process.env.LANG ?? "") ? "he" : "en");
  const dir = resolve(opt("dir") ?? join(ROOT, "reports/owner"));
  const cmd = argv.find((a) => !a.startsWith("--") && ![opt("lang"), opt("dir"), opt("redo"), opt("from")].includes(a));
  if (cmd === "collect") {
    const prs = opt("from") ? JSON.parse(readFileSync(opt("from"), "utf8")) : ghPulls();
    const r = collect(prs);
    const planPath = join(ROOT, "plan/plan.json");
    const ownerIds = existsSync(planPath) ? (JSON.parse(readFileSync(planPath, "utf8")).owner ?? []).map((o) => o.id) : [];
    const carried = new Set(STEPS.flatMap((s) => s.plan));
    const uncarried = ownerIds.filter((id) => !carried.has(id) && !OFF_LIST[id]);
    console.log(`owner:collect: ${prs.length} open PRs, ${r.prs} with an owner section → ${r.items.length} distinct items: ${Object.entries(r.counts).map(([k, v]) => `${k} ${v}`).join(", ")}`);
    if (ownerIds.length) console.log(`plan owner items: ${ownerIds.length}; carried by a step ${ownerIds.filter((id) => carried.has(id)).length}, off the list ${ownerIds.filter((id) => OFF_LIST[id]).length}${uncarried.length ? `, ✗ not carried: ${uncarried.join(", ")}` : ""}`);
    if (argv.includes("--write")) writeFileSync(join(ROOT, INBOX_FILE), JSON.stringify({ $comment: "Every owner command in the open PRs' owner sections, deduplicated and assigned (npm run owner:session -- collect --write).", collectedAt: new Date().toISOString(), openPrs: prs.length, prsWithSection: r.prs, counts: r.counts, items: r.items }, null, 1) + "\n");
    const un = r.items.filter((x) => !x.to);
    for (const x of un) console.log(`  ✗ unassigned (${x.prs.map((n) => `#${n}`).join(" ")}): ${x.text}`);
    return un.length || uncarried.length ? 1 : 0;
  }
  const { state, bad } = loadState(dir);
  for (const b of bad) console.warn(`owner: ignored ${b}`);
  if (cmd === "status" || !cmd) {
    for (const l of statusLines(state, lang)) console.log(l);
    if (!cmd) console.log("\nnpm run owner:session -- accounts|gpu|devices|status|check|collect");
    return 0;
  }
  if (cmd === "check") {
    const which = argv.find((a) => SESSIONS[a]);
    const ctx = realContext();
    let fails = 0;
    for (const s of which ? stepsOf(which) : STEPS) {
      for (const c of await runChecks(s, ctx)) {
        if (c.ok !== true) fails++;
        console.log(`${mark(c.ok)} ${s.id} · ${c.id} — ${c.detail}`);
      }
      for (const c of s.checks.filter((x) => !x.auto)) console.log(`${state[s.id]?.checks?.find((x) => x.id === c.id)?.ok ? "✓" : "·"} ${s.id} · ${c.id} — owner's yes/no`);
    }
    return fails ? 1 : 0;
  }
  if (!SESSIONS[cmd]) {
    console.error(`owner: unknown "${cmd}". Use accounts, gpu, devices, status, check or collect.`);
    return 2;
  }
  const redo = opt("redo");
  if (redo && !stepById(redo)) {
    console.error(`owner: no step ${redo}`);
    return 2;
  }
  const { privateKeyPem, publicKeyPem } = loadOrCreateKey();
  mkdirSync(join(dir, cmd), { recursive: true });
  writeFileSync(join(dir, "PUBLIC_KEY.pem"), publicKeyPem);
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  const io = { say: (t) => console.log(t), ask: (q) => rl.question(q) };
  const ctx = realContext();
  const commit = headCommit(ROOT);
  console.log(T(lang, SESSIONS[cmd]));
  for (const s of stepsOf(cmd)) {
    if (state[s.id]?.done && s.id !== redo) {
      console.log(`✓ ${s.id} (done ${state[s.id].finishedAt.slice(0, 16)}; --redo ${s.id} to run it again)`);
      continue;
    }
    const sealed = await runStep(s, ctx, io, { lang, yes: argv.includes("--yes"), previous: state[s.id] ?? null, commit, key: privateKeyPem });
    writeFileSync(receiptPath(dir, s.id), JSON.stringify(sealed, null, 2) + "\n");
    state[s.id] = sealed;
    if (!sealed.done && /^q/i.test((await io.ask("  Continue with the next step, or q to stop? ")).trim())) break;
  }
  rl.close();
  for (const l of statusLines(state, lang)) console.log(l);
  console.log(`\nCommit the receipts: git add -f reports/owner && git commit -m "chore(owner): session ${cmd} receipts [skip ci]" && git push`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url))
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (e) => {
      console.error(String(e?.message ?? e));
      process.exit(1);
    },
  );
