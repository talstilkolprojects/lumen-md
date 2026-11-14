/**
 * Plan W11.S4: the GitHub rulesets as code (security/github-ruleset.json),
 * checked against GitHub's ruleset schema and the policy, and a drift check
 * against the API (scripts/security/ruleset-drift.mjs).
 *
 * The API answers below are synthetic: built in the shape GitHub's REST
 * reference documents for GET /repos/{owner}/{repo}/rulesets/{id} (ids,
 * node_id, _links, timestamps, source, integration_id, the server's default
 * allowed_merge_methods), not recorded from GitHub. The live check is
 * `node scripts/security/ruleset-drift.mjs`; today it reports both rulesets
 * missing, because they are applied only in W10.O1.
 */
import { describe, expect, it } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script without types
import { applyCommands, checkFile, drift, fetchRulesets, normalize, policyProblems, validate } from "../../scripts/security/ruleset-drift.mjs";
// @ts-expect-error — plain .mjs script without types
import { stepsFor } from "../../scripts/nightly/run.mjs";

const ROOT = resolve(__dirname, "..", "..");
type Json = Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
const file = JSON.parse(readFileSync(join(ROOT, "security/github-ruleset.json"), "utf8")) as Json;
const schema = JSON.parse(readFileSync(join(ROOT, "security/github-ruleset.schema.json"), "utf8")) as Json;
const clone = <T,>(x: T): T => JSON.parse(JSON.stringify(x));

/** How GitHub returns a ruleset it was given: ids, links, timestamps, integration ids, default merge methods, another key order. */
function asServer(rs: Json, id: number): Json {
  const rules = clone(rs.rules).reverse().map((r: Json) => {
    if (r.type === "pull_request") r.parameters = { allowed_merge_methods: ["merge", "squash", "rebase"], ...r.parameters };
    if (r.type === "required_status_checks") r.parameters.required_status_checks = r.parameters.required_status_checks.map((c: Json, i: number) => ({ ...c, integration_id: 1000 + i })).reverse();
    return r;
  });
  return {
    id,
    name: rs.name,
    target: rs.target,
    source_type: "Repository",
    source: "talstilkol/lumen-md",
    enforcement: rs.enforcement,
    conditions: clone(rs.conditions),
    rules,
    bypass_actors: clone(rs.bypass_actors),
    node_id: `RRS_${id}`,
    current_user_can_bypass: "pull_requests_only",
    _links: { self: { href: `https://api.github.com/repos/talstilkol/lumen-md/rulesets/${id}` }, html: { href: `https://github.com/talstilkol/lumen-md/rules/${id}` } },
    created_at: "2026-11-20T10:00:00.000Z",
    updated_at: "2026-11-20T10:00:00.000Z",
  };
}
const server = () => file.rulesets.map((rs: Json, i: number) => asServer(rs, 4100 + i));

describe("security/github-ruleset.json", () => {
  it("passes the ruleset JSON schema and the policy", () => {
    expect(validate(file, schema)).toEqual([]);
    expect(policyProblems(file)).toEqual([]);
    expect(checkFile(ROOT).problems).toEqual([]);
  });

  const ajvPath = "/opt/npm-tools/node_modules/ajv";
  it.skipIf(!existsSync(ajvPath))("Ajv (draft-07) agrees: the file passes, and broken files fail in both validators", () => {
    const Ajv = createRequire(import.meta.url)(ajvPath);
    const check = new Ajv({ allErrors: true, strict: false }).compile(schema);
    expect(check(file), JSON.stringify(check.errors)).toBe(true);
    const broken: Json[] = [];
    let b = clone(file);
    b.rulesets[0].rules.push({ type: "force_push_allowed" });
    broken.push(b);
    b = clone(file);
    delete b.rulesets[0].rules.find((r: Json) => r.type === "pull_request").parameters.require_last_push_approval;
    broken.push(b);
    b = clone(file);
    b.rulesets[1].bypass_actors[0].bypass_mode = "sometimes";
    broken.push(b);
    b = clone(file);
    b.rulesets[0].rules.find((r: Json) => r.type === "required_status_checks").parameters.required_status_checks = [];
    broken.push(b);
    b = clone(file);
    b.rulesets[0].enforcement = "on";
    broken.push(b);
    for (const x of broken) {
      expect(check(x)).toBe(false);
      expect(validate(x, schema).length).toBeGreaterThan(0);
    }
  });

  it("states the task's rules for main and verify/*", () => {
    const byRef = (ref: string) => file.rulesets.find((rs: Json) => rs.conditions.ref_name.include.includes(ref));
    for (const ref of ["refs/heads/main", "refs/heads/verify/*"]) {
      const rs = byRef(ref);
      expect(rs, ref).toBeTruthy();
      const types = rs.rules.map((r: Json) => r.type);
      expect(types).toEqual(expect.arrayContaining(["deletion", "non_fast_forward", "required_signatures", "pull_request", "required_status_checks"]));
      const pr = rs.rules.find((r: Json) => r.type === "pull_request").parameters;
      expect(pr).toMatchObject({ required_approving_review_count: 1, require_last_push_approval: true, dismiss_stale_reviews_on_push: true, require_code_owner_review: true });
      const checks = rs.rules.find((r: Json) => r.type === "required_status_checks").parameters.required_status_checks.map((c: Json) => c.context);
      expect(checks).toEqual(["Vercel", "lumen/buildkite"]);
      // The owner bypasses through a pull request only: every bypass is recorded.
      expect(rs.bypass_actors).toEqual([{ actor_id: 5, actor_type: "RepositoryRole", bypass_mode: "pull_request" }]);
    }
  });

  it("the policy check catches a weakened file", () => {
    let b = clone(file);
    b.rulesets[0].rules.find((r: Json) => r.type === "pull_request").parameters.required_approving_review_count = 0;
    expect(policyProblems(b).join()).toMatch(/at least one approval/);
    b = clone(file);
    b.rulesets[0].bypass_actors[0].bypass_mode = "always";
    expect(policyProblems(b).join()).toMatch(/pull_request only/);
    b = clone(file);
    b.rulesets = b.rulesets.filter((rs: Json) => rs.name !== "verify trains");
    expect(policyProblems(b).join()).toMatch(/no ruleset covers refs\/heads\/verify\/\*/);
    b = clone(file);
    b.rulesets[1].rules = b.rulesets[1].rules.filter((r: Json) => r.type !== "non_fast_forward");
    expect(policyProblems(b).join()).toMatch(/no non_fast_forward rule/);
  });
});

describe("drift between the file and the API", () => {
  it("an API answer that matches (ids, links, integration ids, other order) is no drift", () => {
    expect(drift(file.rulesets, server())).toEqual([]);
    expect(normalize(server()[0])).toEqual(normalize(file.rulesets[0]));
  });

  it("finds each kind of difference", () => {
    const cases: Array<[string, (s: Json[]) => void, RegExp]> = [
      ["approvals lowered", (s) => (s[0].rules.find((r: Json) => r.type === "pull_request").parameters.required_approving_review_count = 0), /rule pull_request is .*"required_approving_review_count":0/],
      ["force push allowed (rule removed)", (s) => (s[0].rules = s[0].rules.filter((r: Json) => r.type !== "non_fast_forward")), /rule non_fast_forward is missing on GitHub/],
      ["a status check dropped", (s) => (s[1].rules.find((r: Json) => r.type === "required_status_checks").parameters.required_status_checks.pop()), /rule required_status_checks is/],
      ["bypass widened", (s) => (s[0].bypass_actors[0].bypass_mode = "always"), /bypass actors are .*"always"/],
      ["enforcement off", (s) => (s[1].enforcement = "evaluate"), /enforcement is evaluate/],
      ["branches changed", (s) => (s[1].conditions.ref_name.include = ["refs/heads/verify/train-*"]), /branches are/],
      ["a ruleset deleted", (s) => s.splice(0, 1), /ruleset "main" is not on GitHub/],
      ["an extra ruleset", (s) => s.push({ ...asServer(file.rulesets[0], 9), name: "hand-made" }), /ruleset "hand-made" is on GitHub but not in the file/],
      ["an extra rule", (s) => s[0].rules.push({ type: "required_linear_history" }), /rule required_linear_history is on GitHub but not in the file/],
    ];
    for (const [name, change, expected] of cases) {
      const s = server();
      change(s);
      const d = drift(file.rulesets, s);
      expect(d.join("\n"), name).toMatch(expected);
    }
  });

  it("reads each ruleset by id, since the list leaves the rules out; an empty repository is all drift", () => {
    const calls: string[] = [];
    const full = server();
    const call = (args: string[]) => {
      calls.push(args[1]);
      if (/rulesets\?/.test(args[1])) return full.map((r: Json) => ({ id: r.id, name: r.name, source_type: "Repository" }));
      return full.find((r: Json) => args[1].endsWith(`/${r.id}`));
    };
    expect(drift(file.rulesets, fetchRulesets("talstilkol/lumen-md", call))).toEqual([]);
    expect(calls).toEqual(["repos/talstilkol/lumen-md/rulesets?includes_parents=false&per_page=100", "repos/talstilkol/lumen-md/rulesets/4100", "repos/talstilkol/lumen-md/rulesets/4101"]);
    // Today's state (no ruleset applied yet, W10.O1):
    expect(drift(file.rulesets, fetchRulesets("talstilkol/lumen-md", () => []))).toEqual(['ruleset "main" is not on GitHub', 'ruleset "verify trains" is not on GitHub']);
  });

  it("the script: 0 on a match, 1 on drift, 2 when the API can't be read (never a match)", async () => {
    const { mkdtempSync, writeFileSync, rmSync } = await import("node:fs");
    const { tmpdir } = await import("node:os");
    const dir = mkdtempSync(join(tmpdir(), "ruleset-"));
    try {
      const ok = join(dir, "ok.json");
      writeFileSync(ok, JSON.stringify(server()));
      const bad = join(dir, "bad.json");
      const s = server();
      s[0].rules = s[0].rules.filter((r: Json) => r.type !== "deletion");
      writeFileSync(bad, JSON.stringify(s));
      const run = (...a: string[]) => spawnSync(process.execPath, ["scripts/security/ruleset-drift.mjs", ...a], { cwd: ROOT, encoding: "utf8" });
      expect(run("--api-file", ok).status).toBe(0);
      const r1 = run("--api-file", bad);
      expect(r1.status).toBe(1);
      expect(r1.stderr).toMatch(/rule deletion is missing on GitHub/);
      expect(run("--api-file", join(dir, "missing.json")).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("--print-apply makes one POST per ruleset with the file's body", () => {
    const cmds = applyCommands(file);
    expect(cmds).toHaveLength(2);
    for (const [i, c] of cmds.entries()) {
      expect(c).toMatch(/^gh api -X POST repos\/talstilkol\/lumen-md\/rulesets --input - <<'JSON'\n/);
      const body = JSON.parse(c.split("\n").slice(1, -1).join("\n"));
      expect(validate({ repo: file.repo, rulesets: [body] }, schema)).toEqual([]);
      expect(body.name).toBe(file.rulesets[i].name);
    }
  });

  it("runs in the local nightly (triage)", () => {
    const steps = stepsFor("triage", () => false).map((s: { id: string; cmd: string[] }) => `${s.id}: ${s.cmd.join(" ")}`);
    expect(steps).toContain("ruleset-drift: node scripts/security/ruleset-drift.mjs");
  });
});
