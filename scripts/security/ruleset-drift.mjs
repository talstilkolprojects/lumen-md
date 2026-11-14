#!/usr/bin/env node
/**
 * `npm run security:ruleset-drift` (plan W11.S4): are the repository's
 * rulesets on GitHub the ones in security/github-ruleset.json?
 *
 * No GitHub Actions run here, so only the server can stop a push to main or
 * a merge without review (main got #432 with no receipt). The rules live in
 * the repo as code; this script:
 *
 *   1. validates the file against security/github-ruleset.schema.json
 *      (GitHub's REST body for a ruleset) and against the policy below;
 *   2. reads `gh api repos/<repo>/rulesets` and each ruleset by id;
 *   3. reports every difference: a ruleset missing or extra on the server, a
 *      rule missing, extra or with other parameters, other bypass actors,
 *      other branches, enforcement not active.
 *
 *   node scripts/security/ruleset-drift.mjs                 # compare with GitHub (gh, network)
 *   node scripts/security/ruleset-drift.mjs --api-file f    # compare with a saved API answer (offline)
 *   node scripts/security/ruleset-drift.mjs --print-apply   # the gh commands that apply the file (W10.O1)
 *   node scripts/security/ruleset-drift.mjs --json
 *
 * Exit 0: the server matches. 1: drift or an invalid file. 2: the API could
 * not be read (offline, signed out) — never reported as a match.
 */
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("../..", import.meta.url)));
export const RULESET_FILE = "security/github-ruleset.json";
export const SCHEMA_FILE = "security/github-ruleset.schema.json";

/* ---------- a small JSON Schema (draft-07) validator: the keywords the schema uses ---------- */

const typeOf = (v) => (v === null ? "null" : Array.isArray(v) ? "array" : Number.isInteger(v) ? "integer" : typeof v);
const isType = (v, t) => (t === "number" ? typeof v === "number" : t === "integer" ? Number.isInteger(v) : typeOf(v) === t);

/** Errors of `value` against `schema` (with `$ref`s into `root`), as "path: message". */
export function validate(value, schema, root = schema, path = "$") {
  if (schema.$ref) {
    const target = schema.$ref.replace(/^#\//, "").split("/").reduce((o, k) => o?.[k], root);
    if (!target) return [`${path}: unknown $ref ${schema.$ref}`];
    return validate(value, target, root, path);
  }
  const errs = [];
  if (schema.type !== undefined) {
    const types = [].concat(schema.type);
    if (!types.some((t) => isType(value, t))) return [`${path}: is ${typeOf(value)}, not ${types.join(" or ")}`];
  }
  if (schema.const !== undefined && value !== schema.const) errs.push(`${path}: must be ${JSON.stringify(schema.const)}`);
  if (schema.enum && !schema.enum.includes(value)) errs.push(`${path}: ${JSON.stringify(value)} is not one of ${schema.enum.join(", ")}`);
  if (typeof value === "string") {
    if (schema.minLength !== undefined && value.length < schema.minLength) errs.push(`${path}: shorter than ${schema.minLength}`);
    if (schema.pattern && !new RegExp(schema.pattern, "u").test(value)) errs.push(`${path}: does not match ${schema.pattern}`);
  }
  if (typeof value === "number") {
    if (schema.minimum !== undefined && value < schema.minimum) errs.push(`${path}: below ${schema.minimum}`);
    if (schema.maximum !== undefined && value > schema.maximum) errs.push(`${path}: above ${schema.maximum}`);
  }
  if (Array.isArray(value)) {
    if (schema.minItems !== undefined && value.length < schema.minItems) errs.push(`${path}: fewer than ${schema.minItems} items`);
    if (schema.items) value.forEach((v, i) => errs.push(...validate(v, schema.items, root, `${path}[${i}]`)));
  }
  if (typeOf(value) === "object") {
    for (const k of schema.required ?? []) if (!(k in value)) errs.push(`${path}: missing ${k}`);
    const props = schema.properties ?? {};
    for (const [k, v] of Object.entries(value)) {
      if (props[k]) errs.push(...validate(v, props[k], root, `${path}.${k}`));
      else if (schema.additionalProperties === false) errs.push(`${path}: unknown property ${k}`);
    }
  }
  if (schema.oneOf) {
    const ok = schema.oneOf.filter((s) => validate(value, s, root, path).length === 0).length;
    if (ok !== 1) errs.push(`${path}: matches ${ok} of the allowed shapes, not exactly one${value?.type ? ` (type ${value.type})` : ""}`);
  }
  return errs;
}

/* ---------- the policy the file must state (W11.S4) ---------- */

const REQUIRED_CHECKS = ["Vercel", "lumen/buildkite"];
const REQUIRED_REFS = ["refs/heads/main", "refs/heads/verify/*"];

/** What the task requires of every ruleset, as messages; empty = fine. */
export function policyProblems(file) {
  const out = [];
  const covered = new Set();
  for (const rs of file?.rulesets ?? []) {
    const at = `ruleset "${rs.name}"`;
    for (const r of rs.conditions?.ref_name?.include ?? []) covered.add(r);
    if (rs.enforcement !== "active") out.push(`${at}: enforcement must be active`);
    const rule = (t) => rs.rules?.find((r) => r.type === t);
    for (const t of ["deletion", "non_fast_forward", "required_signatures"]) if (!rule(t)) out.push(`${at}: no ${t} rule`);
    const pr = rule("pull_request")?.parameters;
    if (!pr) out.push(`${at}: no pull_request rule`);
    else {
      if (!(pr.required_approving_review_count >= 1)) out.push(`${at}: needs at least one approval`);
      if (pr.require_last_push_approval !== true) out.push(`${at}: the most recent push must be approved`);
      if (pr.dismiss_stale_reviews_on_push !== true) out.push(`${at}: stale approvals must be dismissed`);
      if (pr.require_code_owner_review !== true) out.push(`${at}: code owners must review`);
    }
    const checks = (rule("required_status_checks")?.parameters?.required_status_checks ?? []).map((c) => c.context);
    for (const c of REQUIRED_CHECKS) if (!checks.includes(c)) out.push(`${at}: status check "${c}" is not required`);
    for (const b of rs.bypass_actors ?? []) if (b.bypass_mode !== "pull_request") out.push(`${at}: bypass for ${b.actor_type} ${b.actor_id} must be pull_request only (every bypass is a recorded PR)`);
  }
  for (const r of REQUIRED_REFS) if (!covered.has(r)) out.push(`no ruleset covers ${r}`);
  return out;
}

/* ---------- comparing the file with the API ---------- */

const sortBy = (arr, key) => [...(arr ?? [])].sort((a, b) => key(a).localeCompare(key(b)));

/** The comparable part of a ruleset (file or API): no ids or timestamps, lists in a stable order. */
export function normalize(rs) {
  return {
    name: rs.name,
    target: rs.target ?? "branch",
    enforcement: rs.enforcement,
    bypass_actors: sortBy(
      (rs.bypass_actors ?? []).map((b) => ({ actor_id: b.actor_id ?? null, actor_type: b.actor_type, bypass_mode: b.bypass_mode ?? "always" })),
      (b) => `${b.actor_type}:${b.actor_id}`,
    ),
    include: [...(rs.conditions?.ref_name?.include ?? [])].sort(),
    exclude: [...(rs.conditions?.ref_name?.exclude ?? [])].sort(),
    rules: sortBy(
      (rs.rules ?? []).map((r) => {
        if (!r.parameters) return { type: r.type };
        const p = { ...r.parameters };
        if (r.type === "required_status_checks") {
          p.do_not_enforce_on_create = p.do_not_enforce_on_create ?? false;
          // integration_id is pinned on the server after the first apply; the file names checks by context.
          p.required_status_checks = sortBy(p.required_status_checks.map((c) => ({ context: c.context })), (c) => c.context);
        }
        if (r.type === "pull_request") {
          delete p.allowed_merge_methods; // the server fills in its default; not part of the policy
          delete p.automatic_copilot_code_review_enabled;
          delete p.required_reviewers;
          delete p.dismissal_restriction;
        }
        return { type: r.type, parameters: Object.fromEntries(Object.entries(p).sort(([a], [b]) => a.localeCompare(b))) };
      }),
      (r) => r.type,
    ),
  };
}

const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);

/** Every difference between the file's rulesets and the server's (full objects from GET …/rulesets/{id}). */
export function drift(fileRulesets, serverRulesets) {
  const out = [];
  const server = new Map(serverRulesets.filter((r) => (r.source_type ?? "Repository") === "Repository").map((r) => [r.name, normalize(r)]));
  for (const want of fileRulesets.map(normalize)) {
    const have = server.get(want.name);
    server.delete(want.name);
    if (!have) {
      out.push(`ruleset "${want.name}" is not on GitHub`);
      continue;
    }
    for (const k of ["target", "enforcement"]) if (have[k] !== want[k]) out.push(`ruleset "${want.name}": ${k} is ${have[k]}, the file says ${want[k]}`);
    if (!same(have.include, want.include) || !same(have.exclude, want.exclude)) out.push(`ruleset "${want.name}": branches are ${JSON.stringify({ include: have.include, exclude: have.exclude })}, the file says ${JSON.stringify({ include: want.include, exclude: want.exclude })}`);
    if (!same(have.bypass_actors, want.bypass_actors)) out.push(`ruleset "${want.name}": bypass actors are ${JSON.stringify(have.bypass_actors)}, the file says ${JSON.stringify(want.bypass_actors)}`);
    const hr = new Map(have.rules.map((r) => [r.type, r]));
    for (const r of want.rules) {
      const h = hr.get(r.type);
      hr.delete(r.type);
      if (!h) out.push(`ruleset "${want.name}": rule ${r.type} is missing on GitHub`);
      else if (!same(h, r)) out.push(`ruleset "${want.name}": rule ${r.type} is ${JSON.stringify(h.parameters ?? {})}, the file says ${JSON.stringify(r.parameters ?? {})}`);
    }
    for (const t of hr.keys()) out.push(`ruleset "${want.name}": rule ${t} is on GitHub but not in the file`);
  }
  for (const name of server.keys()) out.push(`ruleset "${name}" is on GitHub but not in the file`);
  return out;
}

/* ---------- I/O ---------- */

function gh(args) {
  const r = spawnSync("gh", args, { encoding: "utf8", maxBuffer: 1 << 24 });
  if (r.status !== 0) throw new Error((r.stderr || r.error?.message || `gh exited ${r.status}`).trim());
  return JSON.parse(r.stdout);
}

/** The repository's rulesets with their rules (the list endpoint omits rules). */
export function fetchRulesets(repo, call = gh) {
  const list = call(["api", `repos/${repo}/rulesets?includes_parents=false&per_page=100`]);
  return list.map((r) => call(["api", `repos/${repo}/rulesets/${r.id}`]));
}

/** The gh commands that create each ruleset (the owner runs them once, W10.O1). */
export function applyCommands(file) {
  return file.rulesets.map((rs) => {
    const body = { name: rs.name, target: rs.target, enforcement: rs.enforcement, bypass_actors: rs.bypass_actors, conditions: rs.conditions, rules: rs.rules };
    return `gh api -X POST repos/${file.repo}/rulesets --input - <<'JSON'\n${JSON.stringify(body, null, 2)}\nJSON`;
  });
}

export function checkFile(root = ROOT) {
  const file = JSON.parse(readFileSync(join(root, RULESET_FILE), "utf8"));
  const schema = JSON.parse(readFileSync(join(root, SCHEMA_FILE), "utf8"));
  return { file, problems: [...validate(file, schema), ...policyProblems(file)] };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const json = args.includes("--json");
  const { file, problems } = checkFile();
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${RULESET_FILE}: ${p}`);
    process.exit(1);
  }
  if (args.includes("--print-apply")) {
    console.log(applyCommands(file).join("\n\n"));
    process.exit(0);
  }
  let server;
  try {
    const at = args.indexOf("--api-file");
    server = at >= 0 ? JSON.parse(readFileSync(args[at + 1], "utf8")) : fetchRulesets(file.repo);
  } catch (e) {
    console.error(`✖ could not read the rulesets of ${file.repo}: ${e.message}`);
    if (json) console.log(JSON.stringify({ ok: false, skipped: true, reason: e.message }));
    process.exit(2);
  }
  const d = drift(file.rulesets, server);
  if (json) console.log(JSON.stringify({ ok: d.length === 0, drift: d }, null, 2));
  else if (d.length) for (const x of d) console.error(`✖ ${x}`);
  else console.log(`✓ the rulesets on GitHub match ${RULESET_FILE} (${file.rulesets.length})`);
  process.exit(d.length ? 1 : 0);
}
