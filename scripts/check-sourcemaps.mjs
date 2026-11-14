#!/usr/bin/env node
/**
 * Plan 11.5: no source maps in a build. Usage: node scripts/check-sourcemaps.mjs [dir=dist]
 * Exits 1 and lists them when there are any.
 */
import path from "node:path";
import { findSourceMaps } from "./lib/sourcemaps.mjs";

const dir = path.resolve(process.argv[2] ?? "dist");
const maps = await findSourceMaps(dir);
if (maps.length) {
  console.error(`✗ ${maps.length} source map(s) in ${dir}:\n  ${maps.slice(0, 20).join("\n  ")}`);
  process.exit(1);
}
console.log(`✓ 0 source maps in ${dir}`);
