/**
 * W10.D4 and W10.D14 (plans 0.19, 2.8, W6.11, W1.35; research R3.7): gates
 * that run without anyone starting them and without GitHub Actions.
 *   - Buildkite runs `pr:check` on every PR build, and the security
 *     scanners (gitleaks, npm audit, cargo audit, semgrep) on every build;
 *     the nightly build adds OSV, cargo deny, Scorecard and an SBOM.
 *   - ci:local runs the scanners whose binary is installed.
 *   - pr:check reviews a changed lockfile against the known-bad list.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
// @ts-expect-error — plain .mjs script without type declarations
import { NATIVE_JOBS, buildPipeline, pipelineRules } from "../../scripts/buildkite/lib.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { SETS, TOOLS, planScan } from "../../scripts/security-scan.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { planSteps, SECURITY_STEPS } from "../../scripts/lib/ciLocal.mjs";

const yml = readFileSync(".buildkite/pipeline.yml", "utf8");
/** The committed pipeline's step block for `key` (from its label line to the next step). */
const block = (key: string) => {
  const at = yml.indexOf(`    key: "${key}"`);
  if (at < 0) return "";
  const start = yml.lastIndexOf("  - label:", at);
  const next = yml.indexOf("\n  - label:", at);
  return yml.slice(start, next < 0 ? undefined : next);
};

describe("Buildkite: pr:check on every PR (W10.D4)", () => {
  it("the committed pipeline has the pr-check step, unconditional, with its own commit status", () => {
    const b = block("pr-check");
    expect(b).toContain("npm run -s pr:check -- --base");
    expect(b).toContain('--pr "$$BUILDKITE_PULL_REQUEST"');
    expect(b).toContain('context: "lumen/buildkite: pr-check"');
    expect(b).not.toMatch(/^\s+if:/m);
  });

  it("the receipt waits for pr-check and the scanners", () => {
    const r = block("receipt");
    for (const k of ["pr-check", "security"]) expect(r).toContain(`step: "${k}"`);
  });

  it("the pipeline's rules refuse a pr-check or security job that is conditional or missing", () => {
    // The smallest ci.yml buildPipeline accepts: its coverage step.
    const ci = { jobs: { check: { steps: [{ name: "Coverage gate (lines >= 65%)", run: "npm run test:coverage\necho ok" }] } } };
    const p = buildPipeline(ci, { jobs: [], native: NATIVE_JOBS, shards: 1 }) as { steps: { key: string; if?: string }[] };
    expect(p.steps.some((s) => s.key === "pr-check")).toBe(true);
    const cond = { ...p, steps: p.steps.map((s) => (s.key === "security" ? { ...s, if: 'build.branch == "main"' } : s)) };
    expect(pipelineRules(cond).join("\n")).toMatch(/security must run on every build/);
    const gone = { ...p, steps: p.steps.filter((s) => s.key !== "pr-check") };
    expect(pipelineRules(gone).join("\n")).toMatch(/no pr-check job/);
  });
});

describe("Buildkite: security scanners (W10.D14)", () => {
  it("every PR build runs gitleaks, npm audit, cargo audit and semgrep", () => {
    const b = block("security");
    for (const t of SETS.pr) expect(b).toContain(`node scripts/security-scan.mjs ${t}`);
    expect(b).not.toMatch(/^\s+if:/m);
    expect(b).toContain('context: "lumen/buildkite: security"');
    expect(SETS.pr).toEqual(["gitleaks", "npm-audit", "cargo-audit", "semgrep"]);
  });

  it("the nightly build adds OSV, cargo deny, Scorecard and a CycloneDX SBOM", () => {
    const b = block("security-nightly");
    for (const t of SETS.nightly) expect(b).toContain(`node scripts/security-scan.mjs ${t}`);
    expect(b).toContain('if: "build.source == \\"schedule\\""');
    expect(TOOLS.sbom.cmds[0].join(" ")).toMatch(/cyclonedx-json=/);
    expect(TOOLS.osv.cmds[0].join(" ")).toMatch(/--lockfile=src-tauri\/Cargo\.lock/);
  });

  it("semgrep uses OSS rule packs and fails on any finding; npm audit fails on high and critical", () => {
    const sg = TOOLS.semgrep.cmds[0].join(" ");
    expect(sg).toMatch(/--error/);
    expect(sg).toMatch(/--config p\/javascript --config p\/typescript --config p\/secrets/);
    expect(sg).toMatch(/--metrics=off/);
    for (const c of TOOLS["npm-audit"].cmds) expect(c.join(" ")).toMatch(/--omit=dev --audit-level=high/);
    expect(TOOLS["cargo-audit"].cmds[0]).toEqual(["node", "scripts/audit-lock.mjs"]);
  });

  it("a missing binary fails in CI and is skipped on a developer's machine", () => {
    const none = () => false;
    expect(planScan(["gitleaks"], { hasBin: none, ci: true })[0]).toMatchObject({ action: "fail" });
    expect(planScan(["gitleaks"], { hasBin: none, ci: false })[0]).toMatchObject({ action: "skip" });
    expect(planScan(["gitleaks"], { hasBin: none, ci: false, require: true })[0]).toMatchObject({ action: "fail" });
    expect(planScan(["gitleaks"], { hasBin: () => true, ci: true })[0]).toMatchObject({ action: "run" });
    expect(planScan(["codeql"], { hasBin: () => true })[0]).toMatchObject({ action: "fail" });
  });
});

describe("ci:local runs the scanners when the binary is there (W10.D14)", () => {
  const pkg = { scripts: { hygiene: "x", lint: "x", licenses: "x", budget: "x" } };
  const exists = () => true;
  it("skips a scanner whose binary is missing, runs one that is installed", () => {
    const by = (hasBin: (b: string) => boolean) => Object.fromEntries((planSteps({ pkg, exists, changed: null, flags: {}, hasBin }) as { id: string; skipReason?: string; cmd: string[] }[]).map((s) => [s.id, s]));
    const none = by(() => false);
    for (const t of SECURITY_STEPS) expect(none[t.id].skipReason).toBe(`${t.bin} is not installed`);
    const all = by(() => true);
    for (const t of SECURITY_STEPS) {
      expect(all[t.id].skipReason).toBeUndefined();
      expect(all[t.id].cmd).toEqual(["node", "scripts/security-scan.mjs", t.tool]);
    }
  });
});
