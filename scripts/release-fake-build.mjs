#!/usr/bin/env node
/**
 * The fake web build of a release dry run (plan W4.5): writes dist/ from
 * scripts/lib/releaseFake.mjs, so repro-check.mjs can build it twice where
 * node_modules is missing. Used only by `npm run release -- <v> --dry-run --fake-build`.
 */
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fakeWeb } from "./lib/releaseFake.mjs";

const root = process.cwd();
const version = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
const dist = join(root, "dist");
rmSync(dist, { recursive: true, force: true });
for (const { path, data } of fakeWeb(version, process.env.VITE_LUMEN_CHANNEL ?? "stable")) {
  mkdirSync(dirname(join(dist, path)), { recursive: true });
  writeFileSync(join(dist, path), data);
}
console.log(`fake web build ${version} → dist/ (FAKE: dry run only)`);
