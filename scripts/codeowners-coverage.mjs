#!/usr/bin/env node
/**
 * `npm run codeowners:check` (plan W8.6): every security-sensitive file in
 * the tree has an owner in .github/CODEOWNERS, or a dated exception in
 * security/codeowners-exceptions.json. The sensitive files are found from
 * the code (scripts/lib/sensitivePaths.mjs), not from a hand-kept list.
 *
 *   npm run codeowners:check               # the whole tree; exit 1 on a gap
 *   npm run codeowners:check -- --list     # also print every sensitive file and its owner line
 *   npm run codeowners:check -- --json out.json
 *
 * `npm run pr:check` runs the same check on the files a PR changes.
 */
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseCodeowners } from "./lib/humanReview.mjs";
import { coverage, EXCEPTIONS_FILE, RULES, suggestedLines } from "./lib/sensitivePaths.mjs";

/** [{ path, text }] for `paths` under `cwd` (missing files are skipped; text is null past 2 MB). */
export function readFiles(cwd, paths) {
  const out = [];
  for (const p of paths) {
    const f = join(cwd, p);
    if (!existsSync(f)) continue;
    let text = null;
    try {
      const buf = readFileSync(f);
      if (buf.length <= 2 * 1024 * 1024) text = buf.toString("utf8");
    } catch {
      continue;
    }
    out.push({ path: p, text });
  }
  return out;
}

/** The tree's coverage → the coverage() result, or null when the tree has no CODEOWNERS. */
export function treeCoverage(cwd, paths, today = new Date()) {
  const owners = join(cwd, ".github", "CODEOWNERS");
  if (!existsSync(owners)) return null;
  const exc = join(cwd, EXCEPTIONS_FILE);
  return coverage(readFiles(cwd, paths), parseCodeowners(readFileSync(owners, "utf8")), existsSync(exc) ? readFileSync(exc, "utf8") : null, today);
}

const label = (id) => RULES.find((r) => r.id === id)?.id ?? id;

/** Markdown lines for a coverage result. */
export function coverageLines(c, { list = false } = {}) {
  const lines = [];
  lines.push(`${c.sensitive.length} sensitive file${c.sensitive.length === 1 ? "" : "s"}: ${c.sensitive.length - c.uncovered.length - c.excepted.length} owned, ${c.excepted.length} excepted, ${c.uncovered.length} without an owner.`);
  if (c.uncovered.length) {
    lines.push("", "No owner in `.github/CODEOWNERS` (add these lines, or a dated exception in `" + EXCEPTIONS_FILE + "`):", "");
    for (const u of c.uncovered.slice(0, 40)) lines.push(`- \`${u.file}\` (${u.rules.map(label).join(", ")})`);
    if (c.uncovered.length > 40) lines.push(`- and ${c.uncovered.length - 40} more`);
    lines.push("", "```", ...suggestedLines(c.uncovered), "```");
  }
  if (c.problems.length) lines.push("", "Exceptions that don't count:", "", ...c.problems.map((p) => `- ${p}`));
  if (c.excepted.length) lines.push("", "Excepted:", "", ...c.excepted.map((e) => `- \`${e.file}\` until ${e.expires}: ${e.reason}`));
  if (c.stale.length) lines.push("", "Exceptions no longer needed (owned, gone, or not sensitive): " + c.stale.map((s) => `\`${s}\``).join(", ") + ".");
  if (list) lines.push("", "| File | Rules | CODEOWNERS entry |", "|---|---|---|", ...c.sensitive.map((s) => `| \`${s.file}\` | ${s.rules.join(", ")} | ${s.owner ? `\`${s.owner}\`` : "—"} |`));
  return lines;
}

function main() {
  const argv = process.argv.slice(2);
  const cwd = resolve(argv.includes("--cwd") ? argv[argv.indexOf("--cwd") + 1] : process.cwd());
  const paths = execFileSync("git", ["ls-files", "-z"], { cwd, encoding: "utf8", maxBuffer: 256 * 1024 * 1024 }).split("\0").filter(Boolean);
  const c = treeCoverage(cwd, paths);
  if (!c) {
    console.error(".github/CODEOWNERS is not in this tree.");
    process.exit(1);
  }
  console.log(coverageLines(c, { list: argv.includes("--list") }).join("\n"));
  if (argv.includes("--json")) writeFileSync(argv[argv.indexOf("--json") + 1], JSON.stringify(c, null, 2) + "\n");
  process.exit(c.uncovered.length || c.problems.length ? 1 : 0);
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) main();
