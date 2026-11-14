/** W8.9 — the installed tree against package-lock.json: a deliberate drift fails. */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname as parentOf, join, resolve } from "node:path";
// @ts-expect-error — plain .mjs helper without types
import { flattenNpmLs, lockDrift, manifestDrift, treeDrift } from "../../scripts/lib/lockfile-drift.mjs";

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = resolve(ROOT, "scripts", "lockfile-drift.mjs");

type Drift = { kind: string; key: string; locked: string | null; installed: string | null };
const kinds = (d: Drift[]) => d.map((x) => `${x.kind} ${x.key} ${x.locked ?? "-"}→${x.installed ?? "-"}`);

const lock = {
  lockfileVersion: 3,
  packages: {
    "": { name: "app", dependencies: { "remark-directive": "^3.0.1" }, devDependencies: { vitest: "^4.0.0" } },
    "node_modules/remark-directive": { version: "3.0.1" },
    "node_modules/micromark-extension-directive": { version: "3.0.2" },
    "node_modules/vitest": { version: "4.0.1", dev: true },
    "node_modules/@esbuild/darwin-arm64": { version: "0.25.0", optional: true },
    "node_modules/a/node_modules/b": { version: "1.0.0" },
    "node_modules/a": { version: "2.0.0" },
  },
};

describe("lockDrift", () => {
  const installed = (over: Record<string, string | null> = {}) => {
    const m = new Map<string, { version: string }>();
    const base: Record<string, string | null> = {
      "node_modules/remark-directive": "3.0.1",
      "node_modules/micromark-extension-directive": "3.0.2",
      "node_modules/vitest": "4.0.1",
      "node_modules/a": "2.0.0",
      "node_modules/a/node_modules/b": "1.0.0",
      ...over,
    };
    for (const [k, v] of Object.entries(base)) if (v) m.set(k, { version: v });
    return m;
  };

  it("a tree installed from the lockfile has no drift; another platform's optional binary may be absent", () => {
    expect(lockDrift(lock, installed())).toEqual([]);
  });

  it("RR8-473-3: micromark-extension-directive installed 4.0.0 where the lockfile pins 3.0.2 is drift", () => {
    expect(kinds(lockDrift(lock, installed({ "node_modules/micromark-extension-directive": "4.0.0" })))).toEqual([
      "version node_modules/micromark-extension-directive 3.0.2→4.0.0",
    ]);
  });

  it("a nested copy is compared at its own path, not by name", () => {
    expect(kinds(lockDrift(lock, installed({ "node_modules/a/node_modules/b": "1.0.1" })))).toEqual(["version node_modules/a/node_modules/b 1.0.0→1.0.1"]);
  });

  it("a locked package that is not installed is missing; one installed but not locked is extraneous", () => {
    const m = installed({ "node_modules/a/node_modules/b": null });
    m.set("node_modules/left-pad", { version: "1.3.0" });
    expect(kinds(lockDrift(lock, m))).toEqual(["missing node_modules/a/node_modules/b 1.0.0→-", "extraneous node_modules/left-pad -→1.3.0"]);
  });

  it("a dev package may be absent only from a tree installed without devDependencies", () => {
    const m = installed({ "node_modules/vitest": null });
    expect(kinds(lockDrift(lock, m))).toEqual(["missing node_modules/vitest 4.0.1→-"]);
    expect(lockDrift(lock, m, { omitDev: true })).toEqual([]);
  });
});

describe("flattenNpmLs", () => {
  it("keys each node of npm ls --all --json --long by its path under the project; a deduped node's children are walked wherever they are listed", () => {
    const tree = {
      dependencies: {
        a: { version: "2.0.0", path: "/p/node_modules/a", dependencies: { c: { version: "1.0.0", path: "/p/node_modules/c" } } },
        d: { version: "1.0.0", path: "/p/node_modules/d", dependencies: { a: { version: "2.0.0", path: "/p/node_modules/a", dependencies: { b: { version: "1.0.0", path: "/p/node_modules/a/node_modules/b" } } } } },
        gone: { missing: true, required: "^1.0.0" },
        linked: { version: "9.0.0", path: "/elsewhere/node_modules/linked" },
      },
    };
    const m = flattenNpmLs(tree, "/p/");
    expect([...m.keys()].sort()).toEqual(["/elsewhere/node_modules/linked", "node_modules/a", "node_modules/a/node_modules/b", "node_modules/c", "node_modules/d"]);
    expect(m.get("node_modules/a")).toEqual({ version: "2.0.0", extraneous: false });
  });
});

describe("manifestDrift", () => {
  it("compares package.json with the lockfile's root as sets, so key order is not drift", () => {
    const pkg = { dependencies: { "remark-directive": "^3.0.1" }, devDependencies: { vitest: "^4.0.0" } };
    expect(manifestDrift(pkg, lock)).toEqual([]);
    expect(manifestDrift({ ...pkg, dependencies: { "remark-directive": "^4.0.0" } }, lock)).toEqual([
      { field: "dependencies", name: "remark-directive", packageJson: "^4.0.0", lockfile: "^3.0.1" },
    ]);
  });

  it("this repository's package.json matches its lockfile", () => {
    const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
    const real = JSON.parse(readFileSync(resolve(ROOT, "package-lock.json"), "utf8"));
    expect(manifestDrift(pkg, real)).toEqual([]);
  });
});

describe("treeDrift", () => {
  it("reports a hoisted package another tree holds at another version, and ignores what it lacks", () => {
    const tree: Record<string, string> = { "micromark-extension-directive": "4.0.0", "remark-directive": "3.0.1" };
    expect(kinds(treeDrift(lock, (n: string) => tree[n] ?? null))).toEqual(["version node_modules/micromark-extension-directive 3.0.2→4.0.0"]);
  });
});

describe("scripts/lockfile-drift.mjs on a real tree", () => {
  // A throwaway project with node_modules on disk: `npm ls` reads it with no network.
  function project(installedVersion: string) {
    const dir = mkdtempSync(join(tmpdir(), "lumen-drift-"));
    const write = (f: string, v: unknown) => {
      mkdirSync(parentOf(join(dir, f)), { recursive: true });
      writeFileSync(join(dir, f), JSON.stringify(v));
    };
    write("package.json", { name: "fixture", version: "1.0.0", dependencies: { dep: "^1.0.0" } });
    write("package-lock.json", { name: "fixture", version: "1.0.0", lockfileVersion: 3, packages: { "": { name: "fixture", version: "1.0.0", dependencies: { dep: "^1.0.0" } }, "node_modules/dep": { version: "1.0.0" } } });
    write("node_modules/dep/package.json", { name: "dep", version: installedVersion });
    return dir;
  }
  const run = (dir: string) => spawnSync("node", [SCRIPT, "--root", dir], { encoding: "utf8" });

  it("passes when node_modules holds the locked version", () => {
    const dir = project("1.0.0");
    try {
      const r = run(dir);
      expect(r.stdout + r.stderr).toContain("✓ lockfile-drift");
      expect(r.status).toBe(0);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, naming the package and both versions, after a deliberate drift", () => {
    const dir = project("1.0.1");
    try {
      const r = run(dir);
      expect(r.stderr).toContain("node_modules/dep: installed 1.0.1, locked 1.0.0");
      expect(r.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("fails, never passes, when there is no node_modules to check", () => {
    const dir = project("1.0.0");
    rmSync(join(dir, "node_modules"), { recursive: true, force: true });
    try {
      expect(run(dir).status).toBe(2);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
