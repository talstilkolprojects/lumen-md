// @vitest-environment node
/**
 * scripts/ci-local.mjs run from a copy in a throw-away repository whose path
 * has a space, with npm and npx stubbed (they only log): untracked files
 * count in --changed mode, a budget-only run builds first, a run where no
 * step ran is not a pass.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFileSync, spawnSync } from "node:child_process";
import { chmodSync, cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const repo = resolve(__dirname, "../..");
let dir = "";
let work = "";
let env: NodeJS.ProcessEnv = {};
const calls = () => readFileSync(join(dir, "calls.log"), "utf8");

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "lumen-ci-local-"));
  work = join(dir, "lumen md");
  const bin = join(dir, "bin");
  mkdirSync(bin);
  for (const tool of ["npx", "npm"]) {
    writeFileSync(join(bin, tool), `#!/bin/sh\necho "${tool} $*" >> "${join(dir, "calls.log")}"\nexit 0\n`);
    chmodSync(join(bin, tool), 0o755);
  }
  writeFileSync(join(dir, "gitconfig"), "");
  env = { ...process.env, PATH: `${bin}:${process.env.PATH}`, GIT_CONFIG_GLOBAL: join(dir, "gitconfig"), GIT_CONFIG_NOSYSTEM: "1", GIT_AUTHOR_NAME: "t", GIT_AUTHOR_EMAIL: "t@example.com", GIT_COMMITTER_NAME: "t", GIT_COMMITTER_EMAIL: "t@example.com" };
  execFileSync("git", ["init", "-q", "-b", "main", work], { env });
  mkdirSync(join(work, "scripts/lib"), { recursive: true });
  mkdirSync(join(work, "src"));
  cpSync(join(repo, "scripts/ci-local.mjs"), join(work, "scripts/ci-local.mjs"));
  cpSync(join(repo, "scripts/lib/ciLocal.mjs"), join(work, "scripts/lib/ciLocal.mjs"));
  writeFileSync(join(work, "package.json"), JSON.stringify({ name: "t", scripts: { budget: "x" } }));
  writeFileSync(join(work, "src/a.ts"), "export const a = 1;\n");
  const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env });
  g("add", ".");
  g("commit", "-q", "-m", "base");
  g("checkout", "-q", "-b", "feat");
});
afterAll(() => rmSync(dir, { recursive: true, force: true }));

function ciLocal(...args: string[]) {
  writeFileSync(join(dir, "calls.log"), "");
  return spawnSync(process.execPath, [join(work, "scripts/ci-local.mjs"), ...args], { cwd: dir, env, encoding: "utf8" });
}

describe("scripts/ci-local.mjs (copy, stubbed npm/npx)", () => {
  it("runs from a path with a space, and --changed counts an untracked new file", () => {
    writeFileSync(join(work, "src/new.ts"), "export const n = 1;\n"); // created, not staged
    const r = ciLocal("--changed", "--base", "main", "--only", "test");
    expect(r.stderr).not.toMatch(/ENOENT|no such file/i);
    expect(r.status).toBe(0);
    expect(calls()).toContain("npx vitest related --run --passWithNoTests src/new.ts");
    rmSync(join(work, "src/new.ts"));
  });

  it("--only budget builds this checkout first", () => {
    const r = ciLocal("--only", "budget");
    expect(r.status).toBe(0);
    const log = calls();
    expect(log).toContain("npm run -s build");
    expect(log.indexOf("npm run -s build")).toBeLessThan(log.indexOf("npm run -s budget"));
  });

  it("--changed plans a moved file's old path too (an asset renamed out of public/, W1.32, #210)", () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env });
    g("checkout", "-q", "main");
    mkdirSync(join(work, "public"), { recursive: true });
    writeFileSync(join(work, "public/t.md"), "template\n");
    g("add", ".");
    g("commit", "-q", "-m", "a public asset");
    g("checkout", "-q", "-b", "move", "main");
    mkdirSync(join(work, "docs"), { recursive: true });
    g("mv", "public/t.md", "docs/t.md");
    g("commit", "-q", "-m", "move it out of the app");
    try {
      const r = ciLocal("--changed", "--base", "main", "--only", "build");
      expect(r.status).toBe(0);
      expect(r.stdout).toMatch(/2 files vs main .*, 1 deleted/);
      expect(calls()).toContain("npm run -s build");
    } finally {
      g("checkout", "-q", "feat");
    }
  });

  it("--changed runs the full suite for a module loaded by a dynamic import (W1.32, #210)", () => {
    const g = (...a: string[]) => execFileSync("git", a, { cwd: work, env });
    g("checkout", "-q", "-b", "lazy", "feat");
    writeFileSync(join(work, "src/panel.ts"), "export const p = 1;\n");
    writeFileSync(join(work, "src/host.ts"), 'export const load = () => import("./panel");\n');
    g("add", ".");
    g("commit", "-q", "-m", "a lazy panel");
    writeFileSync(join(work, "src/panel.ts"), "export const p = 2;\n");
    try {
      const r = ciLocal("--changed", "--base", "main", "--only", "test");
      expect(r.status).toBe(0);
      expect(calls()).toContain("npx vitest run");
      expect(calls()).not.toContain("vitest related");
    } finally {
      g("checkout", "-q", "--", "src/panel.ts");
      g("checkout", "-q", "feat");
    }
  });

  it("a run in which no step ran is not a pass", () => {
    const r = ciLocal("--only", "lint"); // no lint script here: "not here"
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("ci:local: no step ran");
  });
});
