/**
 * Plan W11.L1 — launch gates as code. The rules shared by
 * scripts/launch-gate.mjs and its tests.
 *
 * docs/launch/milestones.json lists each milestone's criteria. Every
 * criterion names the plan acceptance it comes from and the kind of receipt
 * that proves it. A receipt is a JSON file under
 * docs/launch/receipts/<milestone>/<criterion>.json, written by whoever ran
 * the check (a lane for tests that run offline, the owner on the Mac for the
 * rest). The gate never runs anything and never trusts a missing file:
 * a criterion without a valid receipt is FAIL, not "unknown" and not "pass".
 */

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const SHA = /^[0-9a-f]{7,40}$/;
export const RECEIPT_KINDS = ["test", "run", "owner"];

/** Problems with milestones.json itself (shape, ids, sources, order). */
export function milestoneProblems(data) {
  const out = [];
  const ids = new Set();
  const list = Array.isArray(data?.milestones) ? data.milestones : null;
  if (!list?.length) return ["milestones.json: no milestones"];
  for (const m of list) {
    const where = m?.id ?? "(no id)";
    if (!/^(M\d+|GA)$/.test(String(m?.id))) out.push(`${where}: id must be M<n> or GA`);
    if (ids.has(m.id)) out.push(`${where}: listed twice`);
    ids.add(m.id);
    if (!m.title?.en?.trim() || !m.title?.he?.trim()) out.push(`${where}: needs a title in English and Hebrew`);
    if (m.after != null && !ids.has(m.after)) out.push(`${where}: after ${m.after}, which is not listed before it`);
    if (!Array.isArray(m.criteria) || !m.criteria.length) {
      out.push(`${where}: no criteria`);
      continue;
    }
    const cids = new Set();
    for (const c of m.criteria) {
      const cw = `${where}/${c?.id ?? "(no id)"}`;
      if (!/^[a-z0-9][a-z0-9-]*$/.test(String(c?.id))) out.push(`${cw}: id must be kebab-case`);
      if (cids.has(c.id)) out.push(`${cw}: listed twice`);
      cids.add(c.id);
      if (!c.en?.trim() || !c.he?.trim()) out.push(`${cw}: needs the criterion in English and Hebrew`);
      const src = c.source ?? {};
      if (!/^(W\d+\.[A-Z]*\d+|\d+\.\d+)$/.test(String(src.task))) out.push(`${cw}: source.task must be a plan id`);
      if (!String(src.acceptance ?? "").trim()) out.push(`${cw}: source.acceptance must quote the plan acceptance it maps to`);
      const r = c.receipt ?? {};
      if (!RECEIPT_KINDS.includes(r.kind)) out.push(`${cw}: receipt.kind must be one of ${RECEIPT_KINDS.join(", ")}`);
      if (r.kind === "test" && !(Array.isArray(r.tests) && r.tests.length)) out.push(`${cw}: a test receipt names the test files`);
      if (r.kind === "run" && !(Array.isArray(r.runs) && r.runs.length)) out.push(`${cw}: a run receipt names the runs it needs`);
      if (r.kind === "owner" && !(Array.isArray(r.facts) && r.facts.length)) out.push(`${cw}: an owner receipt names the facts to record`);
    }
  }
  return out;
}

/**
 * Why `receipt` does not prove `criterion` (empty when it does).
 * `ctx.fileExists(path)` and `ctx.commitExists(sha)` check the repository;
 * `ctx.today` (YYYY-MM-DD) rejects receipts from the future.
 */
export function receiptProblems(criterion, receipt, ctx = {}) {
  const { fileExists = () => true, commitExists = () => true, today = new Date().toISOString().slice(0, 10) } = ctx;
  if (receipt == null) return ["no receipt"];
  if (typeof receipt !== "object" || Array.isArray(receipt)) return ["the receipt is not a JSON object"];
  const out = [];
  const spec = criterion.receipt ?? {};
  if (receipt.criterion !== criterion.id) out.push(`the receipt is for ${JSON.stringify(receipt.criterion)}, not ${criterion.id}`);
  if (receipt.kind !== spec.kind) out.push(`the receipt is a ${receipt.kind ?? "?"} receipt; this criterion needs ${spec.kind}`);
  if (receipt.result !== "pass") out.push(`the receipt's result is ${JSON.stringify(receipt.result ?? null)}, not "pass"`);
  if (!DATE.test(String(receipt.date))) out.push("the receipt needs a date (YYYY-MM-DD)");
  else if (receipt.date > today) out.push(`the receipt is dated ${receipt.date}, after today`);
  if (!String(receipt.by ?? "").trim()) out.push("the receipt needs `by` (who ran it)");
  if (!SHA.test(String(receipt.commit))) out.push("the receipt needs the commit it ran on");
  else if (!commitExists(receipt.commit)) out.push(`commit ${receipt.commit} is not in this repository`);

  if (spec.kind === "test") {
    const got = new Map((Array.isArray(receipt.tests) ? receipt.tests : []).map((t) => [t?.file, t]));
    for (const file of spec.tests ?? []) {
      const t = got.get(file);
      if (!fileExists(file)) out.push(`${file} does not exist in this checkout`);
      if (!t) {
        out.push(`no result for ${file}`);
        continue;
      }
      const passed = Number(t.passed);
      const total = Number(t.total);
      if (!Number.isInteger(total) || total < 1) out.push(`${file}: no tests counted`);
      else if (passed !== total) out.push(`${file}: ${t.passed}/${t.total} passed`);
      if (!String(t.command ?? "").trim()) out.push(`${file}: the receipt needs the command that ran`);
    }
  }
  if (spec.kind === "run") {
    const got = new Map((Array.isArray(receipt.runs) ? receipt.runs : []).map((r) => [r?.name, r]));
    for (const name of spec.runs ?? []) {
      const r = got.get(name);
      if (!r) out.push(`no result for the run ${name}`);
      else if (r.result !== "pass") out.push(`the run ${name}: ${JSON.stringify(r.result ?? null)}, not "pass"`);
      else if (!String(r.evidence ?? "").trim()) out.push(`the run ${name}: no evidence (a log, a report or an artifact path)`);
    }
  }
  if (spec.kind === "owner") {
    const facts = receipt.facts && typeof receipt.facts === "object" ? receipt.facts : {};
    for (const f of spec.facts ?? []) {
      const v = facts[f];
      if (v === undefined || v === null || v === "" || v === false) out.push(`the fact ${f} is not recorded`);
    }
  }
  return out;
}

/**
 * Evaluate one milestone. `readReceipt(milestone, criterion)` returns the
 * parsed receipt, `null` when there is none, or throws on a broken file.
 * A milestone with `after` also needs the milestone before it to pass.
 */
export function evaluate(data, id, ctx = {}) {
  const { readReceipt = () => null } = ctx;
  const m = data.milestones.find((x) => x.id === id);
  if (!m) throw new Error(`unknown milestone ${id}; known: ${data.milestones.map((x) => x.id).join(", ")}`);
  const criteria = m.criteria.map((c) => {
    let receipt = null;
    let problems;
    try {
      receipt = readReceipt(m.id, c.id);
      problems = receiptProblems(c, receipt, ctx);
    } catch (e) {
      problems = [`the receipt does not parse: ${e?.message ?? e}`];
    }
    return { id: c.id, en: c.en, he: c.he, source: c.source, kind: c.receipt?.kind, pass: problems.length === 0, problems };
  });
  const before = m.after ? evaluate(data, m.after, ctx) : null;
  const pass = criteria.every((c) => c.pass) && (before ? before.pass : true);
  return { id: m.id, title: m.title, after: m.after ?? null, before: before ? { id: before.id, pass: before.pass } : null, pass, passed: criteria.filter((c) => c.pass).length, total: criteria.length, criteria };
}

/** The gate's report as plain text. */
export function gateText(r) {
  const lines = [`launch:gate ${r.id} — ${r.title.en} / ${r.title.he}`];
  if (r.before) lines.push(`${r.before.pass ? "PASS" : "FAIL"}  (needs ${r.before.id} to pass first)`);
  for (const c of r.criteria) {
    lines.push(`${c.pass ? "PASS" : "FAIL"}  ${c.id} [${c.kind}; ${c.source.task}] ${c.en}`);
    for (const p of c.problems) lines.push(`        - ${p}`);
  }
  lines.push(`${r.pass ? "PASS" : "FAIL"} ${r.id}: ${r.passed}/${r.total} criteria with a valid receipt${r.before && !r.before.pass ? `; ${r.before.id} is not green` : ""}`);
  return lines.join("\n") + "\n";
}
