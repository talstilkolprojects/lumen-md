#!/usr/bin/env node
/**
 * Plan W10.G11 — no GitHub Actions. The owner stopped using Actions on 9.11,
 * so a workflow file is a gate that never runs. The workflows that existed
 * are kept, unchanged, in docs/archive/workflows/ (ci.yml there is still the
 * source that scripts/buildkite/pipeline.mjs generates .buildkite/pipeline.yml
 * from). A gate belongs in Buildkite, `npm run ci:local` or vercel-build.
 *
 * Fails (exit 1) when .github/workflows/ holds any file.
 *
 *   node scripts/check-no-workflows.mjs [root]
 */
import { existsSync, readdirSync, statSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

export const WORKFLOW_DIR = ".github/workflows";
export const ARCHIVE_DIR = "docs/archive/workflows";

/** Every file under <root>/.github/workflows, as repo-relative paths. */
export function activeWorkflows(root) {
  const dir = join(root, WORKFLOW_DIR);
  if (!existsSync(dir)) return [];
  const out = [];
  const walk = (d, rel) => {
    for (const name of readdirSync(d).sort()) {
      const p = join(d, name);
      const r = `${rel}/${name}`;
      if (statSync(p).isDirectory()) walk(p, r);
      else out.push(r);
    }
  };
  walk(dir, WORKFLOW_DIR);
  return out;
}

function main(argv) {
  const root = resolve(argv[0] ?? join(dirname(fileURLToPath(import.meta.url)), ".."));
  const found = activeWorkflows(root);
  if (found.length) {
    console.error(`no-workflows: GitHub Actions is not used (plan W10.G11), but ${found.length} workflow file${found.length > 1 ? "s are" : " is"} active:`);
    for (const f of found) console.error(`  ${f}`);
    console.error(`Move the gate to .buildkite (via ${ARCHIVE_DIR}/ci.yml and scripts/buildkite/pipeline.mjs), ci:local or vercel-build.`);
    return 1;
  }
  console.log(`no-workflows: no active GitHub Actions workflows (archive: ${ARCHIVE_DIR})`);
  return 0;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) process.exit(main(process.argv.slice(2)));
