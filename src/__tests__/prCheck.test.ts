/**
 * Plan 0.19 — `npm run pr:check` (scripts/pr-check.mjs), the local PR gate
 * that replaces Danger: run against a throwaway git repository with a real
 * history, a real diff and real bundle-budget output.
 * @vitest-environment node
 */
import { describe, expect, it } from "vitest";
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { execFileSync } from "node:child_process";
// @ts-expect-error — plain .mjs module without type declarations
import { parseArgs, report, runChecks } from "../../scripts/pr-check.mjs";
// @ts-expect-error — plain .mjs module without type declarations
import { REQUIRED_SECTIONS } from "../../scripts/lib/prGate.mjs";

const ROOT = resolve(__dirname, "../..");

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "lumen-prcheck-"));
  const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
  git("init", "-q", "-b", "main");
  git("config", "user.email", "t@example.org");
  git("config", "user.name", "T");
  mkdirSync(join(dir, "src/ai"), { recursive: true });
  mkdirSync(join(dir, "scripts"), { recursive: true });
  writeFileSync(join(dir, "src/ai/privacyLedger.ts"), 'const RULES = [{ host: "api.openai.com" }];\n');
  writeFileSync(join(dir, "src/a.ts"), "export const a = 1;\n");
  writeFileSync(join(dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/ok": { version: "1.0.0", license: "MIT" } } }));
  cpSync(join(ROOT, "scripts/bundle-budget.mjs"), join(dir, "scripts/bundle-budget.mjs"));
  git("add", "-A");
  git("commit", "-q", "-m", "base [skip ci]");
  return { dir, git, done: () => rmSync(dir, { recursive: true, force: true }) };
}

const body = REQUIRED_SECTIONS.map((h: string) => `${h}\n\ncontent`).join("\n\n");

describe("pr:check", () => {
  it("a clean PR passes: [skip ci], body, ledger, licences, sizes against the base's", () => {
    const r0 = repo();
    try {
      writeFileSync(join(r0.dir, "src/a.ts"), 'export const a = 2;\nexport const go = () => fetch("https://api.openai.com/v1/x");\n');
      mkdirSync(join(r0.dir, "src/__tests__"));
      writeFileSync(join(r0.dir, "src/__tests__/a.test.ts"), "test\n");
      r0.git("add", "-A");
      r0.git("commit", "-q", "-m", "feat: a [skip ci]");
      writeFileSync(join(r0.dir, "body.md"), body);
      writeFileSync(join(r0.dir, "base.json"), JSON.stringify({ totalKb: 100, classes: { "main bundle": { kb: 90, files: 1 }, other: { kb: 10, files: 1 } } }));
      // A real dist/ for the real bundle-budget script: one small app chunk.
      mkdirSync(join(r0.dir, "dist/assets"), { recursive: true });
      writeFileSync(join(r0.dir, "dist/assets/app-abc123.js"), "x".repeat(5000));
      const r = runChecks(parseArgs(["--cwd", r0.dir, "--base", "main~1", "--body", "body.md", "--base-sizes", join(r0.dir, "base.json")]));
      const by = Object.fromEntries(r.sections.map((s: { title: string; status: string }) => [s.title, s.status]));
      expect(by).toMatchObject({ "Commits carry [skip ci]": "ok", "PR body sections": "ok", "Network calls in the privacy ledger": "ok", "The project's domain": "ok", Tests: "ok", "Bundle size": "ok" });
      expect(r.failed).toBe(false);
      const md = report(r);
      expect(md).toContain("| main bundle | 90.0 KB |");
      expect(md).toContain("**PR check: passed.**");
    } finally {
      r0.done();
    }
  });

  it("fails on a subject without [skip ci], a missing section, an unregistered fetch, the domain, a GPL package", () => {
    const r0 = repo();
    try {
      const dom = ["lumen", "md"].join(".");
      writeFileSync(join(r0.dir, "src/a.ts"), `export const t = () => fetch("https://tracker.example.io/c");\n// see https://${dom}/x\n`);
      writeFileSync(join(r0.dir, "package-lock.json"), JSON.stringify({ packages: { "node_modules/ok": { version: "1.0.0", license: "MIT" }, "node_modules/copyleft": { version: "2.0.0", license: "GPL-3.0" } } }));
      r0.git("add", "-A");
      r0.git("commit", "-q", "-m", "feat: track");
      writeFileSync(join(r0.dir, "body.md"), "## What and why\n\nx\n");
      const r = runChecks(parseArgs(["--cwd", r0.dir, "--base", "main~1", "--body", "body.md", "--no-size"]));
      const by = Object.fromEntries(r.sections.map((s: { title: string; status: string }) => [s.title, s.status]));
      expect(by).toMatchObject({ "Commits carry [skip ci]": "fail", "PR body sections": "fail", "Network calls in the privacy ledger": "fail", "The project's domain": "fail", "Licences of production packages": "fail", Tests: "warn", "Bundle size": "skipped" });
      expect(r.failed).toBe(true);
      const md = report(r);
      expect(md).toContain("- `feat: track`");
      expect(md).toContain("host not in the privacy ledger: tracker.example.io");
      expect(md).toContain("| copyleft | 2.0.0 | GPL-3.0 | new | fail |");
      expect(md).toContain("**PR check: failed.**");
    } finally {
      r0.done();
    }
  });

  it("no dist/: the size check is skipped with what to do", () => {
    const r0 = repo();
    try {
      r0.git("commit", "-q", "--allow-empty", "-m", "chore: x [skip ci]");
      const r = runChecks(parseArgs(["--cwd", r0.dir, "--base", "main~1"]));
      const size = r.sections.find((s: { title: string }) => s.title === "Bundle size");
      expect(size.status).toBe("skipped");
      expect(size.lines[0]).toMatch(/npm run build/);
    } finally {
      r0.done();
    }
  });
});
