/**
 * Vite's cache directory for a lane (scripts/lane.sh, docs/dev/lanes.md).
 *
 * Vite keeps its cache — the pre-bundled dependencies a dev server is
 * serving, and vitest's results — in `<root>/node_modules/.vite` by
 * default. A lane's node_modules is a symlink to a node_modules that other
 * checkouts share, so that cache would be shared too: one lane's dependency
 * re-optimisation could replace files while another lane's dev server (or
 * its e2e run) is serving them. A symlinked node_modules therefore gets a
 * cache inside the worktree (`.vite/`, gitignored); a real node_modules
 * keeps Vite's default.
 *
 * Build tooling: imported by vite.config.ts and tests, never by the app.
 */
import { lstatSync } from "node:fs";
import path from "node:path";

export function laneCacheDir(root: string): string | undefined {
  try {
    if (lstatSync(path.join(root, "node_modules")).isSymbolicLink()) return path.join(root, ".vite");
  } catch {
    /* why: no node_modules yet */
  }
  return undefined;
}
