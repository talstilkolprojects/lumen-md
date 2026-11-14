#!/usr/bin/env node
/**
 * A git merge driver for the in-app help bundle, src/help/generated/*.json
 * (plan W8.11). Those shards are built from docs/src/content/docs by
 * scripts/help-bundle.mjs, so two branches that each change a different
 * docs page conflict in a generated shard even when the docs merge
 * cleanly (#524, #526 and #530 on train 2). A hand-merge of a shard is
 * always wrong; the answer is to rebuild it from the merged docs.
 *
 * A driver runs before git writes the merged docs to the working tree, so
 * it cannot rebuild there. It keeps our side of the shard and returns
 * success, so the shard no longer stops the merge, and the merge is
 * followed by `node scripts/help-bundle.mjs` (scripts/lane-merge.sh does
 * that inside every merge; `npm run help:check` catches a bundle that
 * wasn't rebuilt).
 *
 *   node scripts/help-merge-driver.mjs --install    # turn it on in this checkout
 *   git: merge.lumen-help.driver = node scripts/help-merge-driver.mjs %O %A %B %P
 *
 * .gitattributes routes the shards to it (`merge=lumen-help`). In a checkout
 * where it is not installed, git falls back to its normal text merge.
 */
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

export const DRIVER = "lumen-help";
export const DRIVER_COMMAND = "node scripts/help-merge-driver.mjs %O %A %B %P";

/** Set merge.lumen-help.{name,driver} in the repository at `cwd` (local config only). */
export function install(cwd = process.cwd()) {
  const git = (...a) => execFileSync("git", a, { cwd, encoding: "utf8" });
  git("config", `merge.${DRIVER}.name`, "rebuild the in-app help bundle after the merge (scripts/help-bundle.mjs)");
  git("config", `merge.${DRIVER}.driver`, DRIVER_COMMAND);
}

/** The driver: our side (%A) already holds the result git keeps; say what to run next. 0 = merged. */
export function drive([base, ours, theirs, path]) {
  if (!ours || !existsSync(ours)) {
    console.error(`help-merge-driver: no "ours" file for ${path ?? "?"} (args: ${[base, ours, theirs, path].join(" ")})`);
    return 1;
  }
  console.error(`help-merge-driver: ${path ?? ours} is generated; kept ours. After the merge run: node scripts/help-bundle.mjs`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  if (args[0] === "--install") {
    install();
    console.error(`help-merge-driver: merge.${DRIVER}.driver set in this checkout's git config`);
    process.exit(0);
  }
  process.exit(drive(args));
}
