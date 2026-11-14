#!/usr/bin/env node
/**
 * Plan W6.7: a task's verification level is computed from signed receipts,
 * not read from its status text. This script reads the receipts and writes
 * plan/verified-receipts.json, which scripts/plan/build.mjs consumes
 * (plan:check refuses `verified: "real"` without a receipt for it). It never
 * edits plan/plan.json: the coordinator moves the levels into the plan.
 *
 * What each receipt proves, for the commit it names:
 *   factory "full" receipt (W6.5), signed     build ok → built; + vitest ok → node;
 *                                             + every e2e suite ok (all three browsers) → browser
 *   nightly "flake" receipt (#455), signed    every browser 5× with nothing flaky or broken → browser
 *   Vercel build receipt (/__build/receipt.json) → node, and only when GitHub's "Vercel"
 *                                             status for that commit is success (the receipt
 *                                             itself is not signed; the status is Vercel's)
 *   "real" or "safari" receipt, signed, with real.tasks
 *                                             → real, for the tasks it lists (a real model, device
 *                                             or user), when every platform or check in it passed
 *   lumen-review v1 (#497)                    no level: recorded as the task's independent review
 *                                             when it approves the PR's current head
 *
 * A receipt counts for a task only when its commit contains the task's PR
 * at that PR's current head (git merge-base --is-ancestor): a push after the
 * train was tested makes the old evidence stale (weakness E62).
 *
 *   node scripts/plan/receipts.mjs --receipts <clone of lumen-md-receipts> [--nightly reports/nightly]
 *        [--vercel <dir of receipt.json files>] [--reviews <dir>] [--pin <fp,…>]
 *        [--gh] [--pr-heads <file.json>] [--out plan/verified-receipts.json]
 *
 *   --gh        look up PR heads, Vercel statuses and review comments with `gh api`
 *               (else --pr-heads gives { "<pr>": "<head sha>" } and Vercel receipts don't count)
 */
import { createHash, createPublicKey, verify } from "node:crypto";
import { spawnSync } from "node:child_process";
import { existsSync, readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const LEVELS = ["built", "node", "browser", "real"];
const BROWSERS = ["chromium", "firefox", "webkit"];
export const RECEIPTS_FILE = "plan/verified-receipts.json";
const REPO = "talstilkol/lumen-md";

// ── the sealed-receipt format of scripts/nightly/receipt.mjs (#455), kept byte-compatible ──
/** JSON with sorted keys and no whitespace: the bytes a receipt signs. */
export function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((v) => (v === undefined ? "null" : canonical(v))).join(",")}]`;
  const keys = Object.keys(value)
    .filter((k) => value[k] !== undefined)
    .sort();
  return `{${keys.map((k) => `${JSON.stringify(k)}:${canonical(value[k])}`).join(",")}}`;
}
const sha256 = (t) => createHash("sha256").update(t).digest("hex");
export const fingerprint = (pem) => sha256(createPublicKey(pem).export({ type: "spki", format: "pem" }).toString()).slice(0, 16);

/** Check a sealed report against trusted keys (fingerprint → PEM): { ok, problems, key }. */
export function verifySealed(report, keys) {
  const r = report?.receipt;
  if (!r) return { ok: false, problems: ["not sealed"] };
  const { receipt: _r, ...rest } = report;
  const text = canonical(rest);
  if (r.sha256 !== sha256(text)) return { ok: false, problems: ["the digest does not match: changed after sealing"] };
  const pem = keys.get(r.key);
  if (!pem) return { ok: false, problems: [`signed by key ${r.key}, which is not trusted`] };
  if (!verify(null, Buffer.from(text), createPublicKey(pem), Buffer.from(r.signature ?? "", "base64"))) return { ok: false, problems: ["the signature does not verify"] };
  return { ok: true, problems: [], key: r.key };
}

// ── what a receipt proves ──
const allOk = (xs) => xs.length > 0 && xs.every((x) => x?.ok === true);

/**
 * One parsed receipt → evidence: { commit, level, kind, tasks? } (level null: proves no level).
 * `trusted` says the receipt's origin was checked (a signature, or Vercel's status).
 */
export function evidenceOf(report, { trusted }) {
  if (!trusted || !report) return null;
  if (report.format === "lumen-review") return null;
  if (report.kind === "full") {
    const s = report.suites ?? {};
    const e2e = BROWSERS.map((b) => s[`e2e ${b}`]);
    const level = s.build?.ok && s.vitest?.ok && allOk(e2e) ? "browser" : s.build?.ok && s.vitest?.ok ? "node" : s.build?.ok ? "built" : null;
    return { commit: report.commit?.sha, level, kind: "full" };
  }
  if (report.kind === "flake") {
    const bs = report.flake?.browsers ?? [];
    const clean = BROWSERS.every((n) => {
      const b = bs.find((x) => x.browser === n);
      return b && !b.missing && b.tests > 0 && (b.flaky ?? []).length === 0 && (b.broken ?? []).length === 0;
    });
    return { commit: report.commit?.sha, level: clean ? "browser" : null, kind: "flake" };
  }
  if (report.kind === "real" || report.kind === "safari") {
    const tasks = Array.isArray(report.real?.tasks) ? report.real.tasks : [];
    const checks = report.kind === "safari" ? report.platforms ?? [] : report.checks ?? [];
    return { commit: report.commit?.sha, level: tasks.length && allOk(checks) ? "real" : null, kind: report.kind, tasks, type: report.real?.type ?? null };
  }
  if (Array.isArray(report.gates) && report.sha) return { commit: report.sha, level: "node", kind: "vercel" };
  return null;
}

/** Highest of two levels (null is lowest). */
const higher = (a, b) => (LEVELS.indexOf(a) >= LEVELS.indexOf(b) ? a : b);

/**
 * The computed level per task.
 *   tasks:    [{ id, pr, claimed, phase }]
 *   heads:    { "<pr>": "<current head sha>" }
 *   evidence: [{ commit, level, kind, source, tasks? }]
 *   contains(head, commit) → true | false | null (null: unknown, the objects are missing)
 *   reviews:  [{ pr?, head, verdict, reviewer, source }]
 * → { tasks: { id: {...} }, counts, unknown }
 */
export function computeLevels({ tasks, heads = {}, evidence = [], contains, reviews = [] }) {
  const out = {};
  let unknown = 0;
  const memo = new Map();
  const has = (head, commit) => {
    const k = `${head}:${commit}`;
    if (!memo.has(k)) memo.set(k, head === commit ? true : contains(head, commit));
    return memo.get(k);
  };
  for (const t of tasks) {
    const head = t.pr ? heads[String(t.pr)] ?? null : null;
    const row = { pr: t.pr ?? null, head, claimed: t.claimed ?? null, computed: null, evidence: [], review: null, phase: t.phase };
    if (head) {
      for (const e of evidence) {
        if (!e.level || !e.commit) continue;
        if (e.level === "real" && !(e.tasks ?? []).includes(t.id)) continue;
        const c = has(head, e.commit);
        if (c === null) {
          unknown++;
          continue;
        }
        if (!c) continue;
        row.evidence.push({ level: e.level, kind: e.kind, commit: e.commit, source: e.source });
        row.computed = higher(e.level, row.computed);
      }
      const rv = reviews.find((r) => r.head === head && r.verdict === "approve");
      if (rv) row.review = { reviewer: rv.reviewer, head: rv.head, source: rv.source };
    }
    row.note = noteFor(row);
    out[t.id] = row;
  }
  return { tasks: out, counts: countBy(out), unknown };
}

function noteFor(row) {
  if (row.claimed === "real" && row.computed !== "real") return "claims real without a receipt";
  if (row.claimed === "owner") return "waits for the owner";
  if (!row.pr) return "no PR";
  if (!row.head) return "the PR's head is unknown";
  const c = LEVELS.indexOf(row.computed);
  const k = LEVELS.indexOf(row.claimed);
  if (k > c) return `claims ${row.claimed}; receipts prove ${row.computed ?? "nothing"}`;
  if (c > k) return `receipts prove ${row.computed}; the plan says ${row.claimed ?? "nothing"}`;
  return "matches";
}

/** { claimed: { level: n }, computed: { level: n, none: n } } */
export function countBy(rows) {
  const claimed = {};
  const computed = Object.fromEntries([...LEVELS, "none"].map((k) => [k, 0]));
  for (const r of Object.values(rows)) {
    claimed[r.claimed ?? "none"] = (claimed[r.claimed ?? "none"] ?? 0) + 1;
    computed[r.computed ?? "none"]++;
  }
  return { claimed, computed };
}

/** Per plan phase: { phase, computed: { level: n } }, in the plan's order. */
export function byPhase(rows, phases) {
  return phases.map((title, i) => {
    const mine = Object.values(rows).filter((r) => r.phase === i);
    return { phase: title, tasks: mine.length, computed: countBy(Object.fromEntries(mine.map((r, j) => [j, r]))).computed };
  });
}

// ── the I/O ──
function walkJson(dir) {
  if (!dir || !existsSync(dir)) return [];
  const out = [];
  const go = (d) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (f === ".git" || f === "node_modules") continue;
      if (statSync(p).isDirectory()) go(p);
      else if (f.endsWith(".json")) out.push(p);
    }
  };
  go(dir);
  return out;
}
const readJson = (p) => {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return null; // why: not JSON, not a receipt
  }
};
const gh = (path) => {
  const r = spawnSync("gh", ["api", path], { encoding: "utf8", maxBuffer: 64 << 20 });
  return r.status === 0 ? JSON.parse(r.stdout) : null;
};
const isAncestor = (head, commit) => {
  if (spawnSync("git", ["cat-file", "-e", `${head}^{commit}`]).status !== 0 || spawnSync("git", ["cat-file", "-e", `${commit}^{commit}`]).status !== 0) return null;
  return spawnSync("git", ["merge-base", "--is-ancestor", head, commit]).status === 0;
};

function main() {
  const argv = process.argv.slice(2);
  const opt = (n) => (argv.includes(`--${n}`) ? argv[argv.indexOf(`--${n}`) + 1] : undefined);
  const root = resolve(fileURLToPath(new URL("../..", import.meta.url)));
  const plan = JSON.parse(readFileSync(join(root, "plan/plan.json"), "utf8"));
  const tasks = plan.phases.flatMap((p, phase) => p.tasks.map((t) => ({ id: t.id, pr: t.pr, claimed: t.verified, phase })));
  const receiptsDir = opt("receipts");
  const pins = opt("pin")?.split(",").filter(Boolean) ?? null;
  const keys = new Map();
  const pems = [];
  if (receiptsDir && existsSync(join(receiptsDir, "keys"))) for (const x of readdirSync(join(receiptsDir, "keys"))) if (x.endsWith(".pem")) pems.push(join(receiptsDir, "keys", x));
  if (opt("nightly") && existsSync(join(opt("nightly"), "PUBLIC_KEY.pem"))) pems.push(join(opt("nightly"), "PUBLIC_KEY.pem"));
  for (const f of pems) {
    const pem = readFileSync(f, "utf8");
    const fp = fingerprint(pem);
    if (!pins || pins.includes(fp)) keys.set(fp, pem);
  }
  const evidence = [];
  const reviews = [];
  const rejected = [];
  const useGh = argv.includes("--gh");
  const vercelOk = new Map();
  for (const f of [...walkJson(receiptsDir), ...walkJson(opt("nightly")), ...walkJson(opt("vercel")), ...walkJson(opt("reviews"))]) {
    const r = readJson(f);
    if (!r || typeof r !== "object") continue;
    const source = relative(process.cwd(), f);
    if (r.format === "lumen-review") {
      if (r.version === 1 && /^[0-9a-f]{40}$/.test(r.head ?? "")) reviews.push({ pr: r.pr, head: r.head, verdict: r.verdict, reviewer: r.reviewer, source });
      continue;
    }
    if (r.receipt) {
      const v = verifySealed(r, keys);
      if (!v.ok) {
        rejected.push({ source, why: v.problems.join("; ") });
        continue;
      }
      const e = evidenceOf(r, { trusted: true });
      if (e) evidence.push({ ...e, source });
      continue;
    }
    if (Array.isArray(r.gates) && r.sha) {
      if (!vercelOk.has(r.sha)) vercelOk.set(r.sha, useGh ? (gh(`repos/${REPO}/commits/${r.sha}/status`)?.statuses ?? []).some((s) => s.context === "Vercel" && s.state === "success") : false);
      if (vercelOk.get(r.sha)) evidence.push({ ...evidenceOf(r, { trusted: true }), source });
      else rejected.push({ source, why: useGh ? "GitHub's Vercel status for this commit is not success" : "a Vercel receipt counts only with --gh (its Vercel status is checked)" });
    }
  }
  let heads = opt("pr-heads") ? readJson(opt("pr-heads")) ?? {} : {};
  if (useGh) {
    for (const t of tasks) {
      if (!t.pr || heads[String(t.pr)]) continue;
      const p = gh(`repos/${REPO}/pulls/${t.pr}`);
      if (p?.head?.sha) heads[String(t.pr)] = p.head.sha;
      // Review receipts posted as PR comments (#497): fenced lumen-review blocks.
      for (const c of gh(`repos/${REPO}/issues/${t.pr}/comments?per_page=100`) ?? [])
        for (const m of String(c.body ?? "").matchAll(/```lumen-review[^\n]*\n([\s\S]*?)```/g)) {
          try {
            const r = JSON.parse(m[1]);
            if (r.version === 1 && r.head) reviews.push({ pr: t.pr, head: r.head, verdict: r.verdict, reviewer: r.reviewer, source: c.html_url });
          } catch {
            /* why: a malformed block is pr-check's to report, not a level */
          }
        }
    }
  }
  const result = computeLevels({ tasks, heads, evidence, contains: isAncestor, reviews });
  const out = {
    version: 1,
    generatedAt: new Date().toISOString(),
    sources: { evidence: evidence.length, reviews: reviews.length, rejected, trustedKeys: [...keys.keys()], pinned: Boolean(pins), unknownAncestry: result.unknown },
    counts: result.counts,
    byPhase: byPhase(result.tasks, plan.phases.map((p) => p.title)),
    tasks: result.tasks,
  };
  const file = resolve(opt("out") ?? join(root, RECEIPTS_FILE));
  writeFileSync(file, JSON.stringify(out, null, 2) + "\n");
  const c = out.counts.computed;
  console.log(`receipts: ${evidence.length} counted, ${rejected.length} rejected, ${reviews.length} reviews · computed: ${LEVELS.map((k) => `${k} ${c[k]}`).join(", ")}, none ${c.none} → ${relative(process.cwd(), file)}`);
  const bad = Object.entries(out.tasks).filter(([, r]) => r.note === "claims real without a receipt");
  if (bad.length) console.log(`✗ ${bad.length} task(s) claim real without a receipt: ${bad.map(([id]) => id).join(", ")}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
