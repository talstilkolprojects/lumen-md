/**
 * Plan W10.B16 (audit W2.23, W1.16, 9.5, 9.9, 10.3): a missing visual
 * baseline is a failure, never a first-run self-approval.
 *
 * Before: playwright.config.ts had no `updateSnapshots`, so Playwright's
 * default ("missing") wrote every missing baseline (print, canvas, slides)
 * and the next run compared against it; visual-smoke wrote its own baseline
 * and returned early. Now both configs take the mode from
 * scripts/lib/visualGate.mjs, and only `npm run visual:approve` writes.
 */
import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { isGateRun, snapshotUpdateMode } from "../../scripts/lib/visualGate.mjs";
import { SUITES, approveCommand } from "../../scripts/visual-approve.mjs";

const read = (p: string) => readFileSync(p, "utf8");
/** The source without its comments, so a doc comment that names a setting does not count. */
const code = (p: string) => read(p).replace(/\/\*[\s\S]*?\*\//g, "").replace(/(^|[^:])\/\/.*$/gm, "$1");

describe("snapshotUpdateMode (W10.B16)", () => {
  it("is 'none' on the gate, whatever else is set", () => {
    for (const env of [{ CI: "true" }, { LUMEN_CI: "buildkite" }, { LUMEN_GATE: "1" }, { CI: "1", LUMEN_VISUAL_APPROVE: "1" }]) {
      expect(isGateRun(env)).toBe(true);
      expect(snapshotUpdateMode(env)).toBe("none");
    }
  });

  it("is 'none' on a plain local run, so a missing baseline fails there too", () => {
    expect(snapshotUpdateMode({})).toBe("none");
    expect(snapshotUpdateMode({ CI: "false", LUMEN_VISUAL_APPROVE: "yes" })).toBe("none");
  });

  it("writes only under visual:approve", () => {
    expect(snapshotUpdateMode({ LUMEN_VISUAL_APPROVE: "1" })).toBe("changed");
  });
});

describe("the configs and specs (W10.B16)", () => {
  it("both Playwright configs take updateSnapshots from visualGate", () => {
    for (const cfg of ["playwright.config.ts", "playwright.visual.config.ts"]) {
      const src = code(cfg);
      expect(src, cfg).toMatch(/import \{ snapshotUpdateMode \} from "\.\/scripts\/lib\/visualGate\.mjs"/);
      expect(src, cfg).toMatch(/updateSnapshots: snapshotUpdateMode\(process\.env\)/);
      expect(src.match(/updateSnapshots:/g)?.length, cfg).toBe(1);
    }
  });

  it("no spec writes its own baseline or relaxes the mode", () => {
    for (const spec of ["e2e/print-golden.spec.ts", "e2e/canvas-note-cards.spec.ts", "e2e/slides.spec.ts", "e2e/visual-smoke.spec.ts", "visual/rtl.visual.ts", "visual/surfaces.visual.ts"]) {
      const src = code(spec);
      expect(src, spec).not.toMatch(/baseline-created/);
      expect(src, spec).not.toMatch(/snapshotPath\(/);
      expect(src, spec).not.toMatch(/updateSnapshots\s*[:=]/);
      expect(src, spec).not.toMatch(/screenshot\(\{\s*path:/);
    }
  });

  it("npm scripts: visual:approve exists and test:visual:update goes through it", () => {
    const pkg = JSON.parse(read("package.json")) as { scripts: Record<string, string> };
    expect(pkg.scripts["visual:approve"]).toBe("node scripts/visual-approve.mjs");
    expect(pkg.scripts["test:visual:update"]).toBe("node scripts/visual-approve.mjs visual");
    for (const [name, cmd] of Object.entries(pkg.scripts)) {
      expect(cmd, name).not.toMatch(/--update-snapshots/);
    }
  });
});

describe("scripts/visual-approve.mjs (W10.B16)", () => {
  const cli = (args: string[], env: Record<string, string>) =>
    spawnSync(process.execPath, ["scripts/visual-approve.mjs", ...args], {
      encoding: "utf8",
      env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
      input: "",
    });

  it("refuses on the gate", () => {
    for (const env of [{ CI: "true" }, { LUMEN_CI: "buildkite" }, { LUMEN_GATE: "1" }]) {
      const r = cli(["visual", "--yes", "--dry-run"], env);
      expect(r.status).toBe(2);
      expect(r.stderr).toMatch(/refuses to run on the gate/);
    }
  });

  it("without --yes and without a terminal it writes nothing", () => {
    const r = cli(["print", "--dry-run"], {});
    expect(r.status).toBe(1);
    expect(r.stdout).not.toMatch(/LUMEN_VISUAL_APPROVE=1/);
  });

  it("with --yes it runs the suite with LUMEN_VISUAL_APPROVE=1", () => {
    const r = cli(["canvas", "--yes", "--dry-run"], {});
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("$ LUMEN_VISUAL_APPROVE=1 npx playwright test -c playwright.config.ts e2e/canvas-note-cards.spec.ts --project chromium");
  });

  it("an unknown suite is a usage error", () => {
    expect(cli(["everything", "--yes", "--dry-run"], {}).status).toBe(1);
  });

  it("every suite names files that exist, and the env it passes makes the config write", () => {
    for (const suite of Object.keys(SUITES)) {
      const run = approveCommand(suite, {})!;
      for (const f of SUITES[suite as keyof typeof SUITES].files) expect(() => read(f)).not.toThrow();
      expect(snapshotUpdateMode(run.env)).toBe("changed");
    }
  });
});
