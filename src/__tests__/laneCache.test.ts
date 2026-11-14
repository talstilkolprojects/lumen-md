// @vitest-environment node
/**
 * Lanes (scripts/lane.sh) share node_modules through a symlink, but not
 * Vite's writable cache: src/build/laneCache.ts gives a symlinked
 * node_modules a cache inside the worktree.
 */
import { describe, it, expect } from "vitest";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { laneCacheDir } from "../build/laneCache";

describe("laneCacheDir", () => {
  it("puts a lane's Vite cache in its worktree, keeps the default otherwise", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-lane-cache-"));
    try {
      const shared = join(dir, "main", "node_modules");
      mkdirSync(shared, { recursive: true });
      const lane = join(dir, "w-fix-x");
      mkdirSync(lane);
      expect(laneCacheDir(lane)).toBeUndefined(); // no node_modules yet
      symlinkSync(shared, join(lane, "node_modules"), "dir");
      expect(laneCacheDir(lane)).toBe(join(lane, ".vite"));
      // The main checkout's real node_modules keeps node_modules/.vite.
      expect(laneCacheDir(join(dir, "main"))).toBeUndefined();
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("is wired into vite.config.ts and the lane's cache is gitignored", () => {
    const repo = resolve(__dirname, "../..");
    expect(readFileSync(join(repo, "vite.config.ts"), "utf8")).toMatch(/cacheDir: viteCacheDir/);
    expect(readFileSync(join(repo, ".gitignore"), "utf8").split("\n")).toContain("/.vite/");
  });
});
