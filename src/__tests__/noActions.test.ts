// @vitest-environment node
/**
 * Plan W10.G11 — no GitHub Actions: .github/workflows is empty, the old
 * workflows live in docs/archive/workflows, and the hygiene gate fails on a
 * new workflow file.
 */
import { describe, it, expect, afterAll } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
// @ts-expect-error — plain .mjs script without type declarations
import { activeWorkflows, ARCHIVE_DIR } from "../../scripts/check-no-workflows.mjs";

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(ROOT, "scripts/check-no-workflows.mjs");
const tmp = mkdtempSync(join(tmpdir(), "lumen-noactions-"));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));
const cli = (root: string) => spawnSync(process.execPath, [SCRIPT, root], { encoding: "utf8" });

describe("no GitHub Actions (W10.G11)", () => {
  it("the repo has no active workflow file, and the check passes on it", () => {
    expect(activeWorkflows(ROOT)).toEqual([]);
    expect(cli(ROOT).status).toBe(0);
  });

  it("a new workflow file fails the check, nested ones too", () => {
    const dir = join(tmp, "one");
    mkdirSync(join(dir, ".github/workflows/sub"), { recursive: true });
    writeFileSync(join(dir, ".github/workflows/ci.yml"), "on: push\n");
    writeFileSync(join(dir, ".github/workflows/sub/x.yaml"), "on: push\n");
    expect(activeWorkflows(dir)).toEqual([".github/workflows/ci.yml", ".github/workflows/sub/x.yaml"]);
    const r = cli(dir);
    expect(r.status).toBe(1);
    expect(r.stderr).toMatch(/2 workflow files are active/);
  });

  it("a repo without .github/workflows, or with only dependabot.yml, passes", () => {
    const dir = join(tmp, "dependabot");
    mkdirSync(join(dir, ".github"), { recursive: true });
    writeFileSync(join(dir, ".github/dependabot.yml"), "version: 2\n");
    expect(cli(dir).status).toBe(0);
  });

  it("the archive keeps the old workflows, and the hygiene gate runs this check", () => {
    const archived = readdirSync(join(ROOT, ARCHIVE_DIR));
    expect(archived).toContain("ci.yml");
    expect(archived.length).toBeGreaterThanOrEqual(21);
    expect(existsSync(join(ROOT, ".github/dependabot.yml"))).toBe(true);
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8"));
    expect(pkg.scripts.hygiene).toContain("node scripts/check-no-workflows.mjs");
  });
});
