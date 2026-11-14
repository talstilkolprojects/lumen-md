#!/usr/bin/env node
/**
 * GitHub Discussions (plan W4.34): every form in .github/DISCUSSION_TEMPLATE/
 * must match a category slug of the repository, or GitHub ignores it.
 *
 *   node scripts/discussions-check.mjs              # needs `gh` signed in (reads the categories with GraphQL)
 *   node scripts/discussions-check.mjs --offline    # only checks the forms' own structure
 *
 * Setup and the owner's steps: docs/dev/github-discussions.md.
 */
import { spawnSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(fileURLToPath(new URL("..", import.meta.url)));
const DIR = join(ROOT, ".github", "DISCUSSION_TEMPLATE");
export const REPO = { owner: "talstilkol", name: "lumen-md" };
/** The categories docs/dev/github-discussions.md sets up: the default slug → the name to give it (English · Hebrew). */
export const CATEGORIES = {
  announcements: "Announcements · הודעות",
  "q-a": "Q&A · שאלות ותשובות",
  ideas: "Ideas · רעיונות",
  "show-and-tell": "Show and tell · הראו מה בניתם",
  general: "General · כללי",
  polls: "Polls · סקרים",
  // The beta (plan W2.25, launch/checklist.md): two categories added by hand.
  beta: "Beta · בטא",
  "beta-feedback": "Beta feedback · משוב על הבטא",
};

/** Problems with a form's text (a light check of the category-form schema, no YAML parser needed). */
export function formProblems(name, text) {
  const out = [];
  if (!/^body:\s*$/m.test(text)) out.push(`${name}: no "body:"`);
  if (!/^\s+- type: (textarea|input|dropdown|checkboxes)\s*$/m.test(text)) out.push(`${name}: no input field (a form needs at least one textarea, input, dropdown or checkboxes)`);
  const ids = [...text.matchAll(/^\s+id: ([\w-]+)\s*$/gm)].map((m) => m[1]);
  if (new Set(ids).size !== ids.length) out.push(`${name}: duplicate field ids`);
  if (/^\s+- type: (textarea|input|dropdown|checkboxes)\s*$/m.test(text) && ids.length === 0) out.push(`${name}: fields need ids`);
  const first = /^# Category "([^"]+)"/m.exec(text)?.[1];
  if (!first || !Object.values(CATEGORIES).includes(first)) out.push(`${name}: its first line must name its category: # Category "<one of the names in docs/dev/github-discussions.md>"`);
  if (name === "polls.yml") out.push("polls.yml: GitHub does not support forms for poll categories");
  return out;
}

function main() {
  const forms = readdirSync(DIR).filter((f) => /\.ya?ml$/.test(f)).sort();
  const problems = forms.flatMap((f) => formProblems(f, readFileSync(join(DIR, f), "utf8")));
  if (!process.argv.includes("--offline")) {
    const q = `query { repository(owner: "${REPO.owner}", name: "${REPO.name}") { hasDiscussionsEnabled discussionCategories(first: 25) { nodes { name slug } } } }`;
    const r = spawnSync("gh", ["api", "graphql", "-f", `query=${q}`], { encoding: "utf8" });
    if (r.status !== 0) {
      console.error(`✗ could not read the categories with gh: ${(r.stderr || r.stdout).trim()}`);
      process.exit(1);
    }
    const repo = JSON.parse(r.stdout).data.repository;
    if (!repo.hasDiscussionsEnabled) problems.push("Discussions are not enabled on the repository (docs/dev/github-discussions.md, step 1)");
    const nodes = repo.discussionCategories.nodes;
    const slugs = new Set(nodes.map((n) => n.slug));
    // Renaming a category can change its slug: match by the English part of the name, then compare slugs.
    for (const [slug, name] of Object.entries(CATEGORIES)) {
      const en = name.split(" · ")[0].toLowerCase();
      const node = nodes.find((n) => n.name === name) ?? nodes.find((n) => n.name.toLowerCase().startsWith(en));
      if (!node) problems.push(`category "${name}" is missing`);
      else if (node.name !== name) problems.push(`category "${node.name}" should be named "${name}"`);
      else if (node.slug !== slug && forms.includes(`${slug}.yml`)) problems.push(`category "${name}" has the slug ${node.slug}: rename .github/DISCUSSION_TEMPLATE/${slug}.yml to ${node.slug}.yml`);
    }
    for (const f of forms) if (!slugs.has(f.replace(/\.ya?ml$/, "")) && !problems.some((p) => p.includes(f))) problems.push(`${f}: no category with the slug ${f.replace(/\.ya?ml$/, "")}`);
  }
  for (const p of problems) console.error(`✗ ${p}`);
  if (problems.length) process.exit(1);
  console.error(`✓ ${forms.length} discussion forms${process.argv.includes("--offline") ? "" : ", each with its category"}`);
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) main();
