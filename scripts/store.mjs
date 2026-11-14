#!/usr/bin/env node
/**
 * Store submission prep (plan 13.7). Nothing here submits anything: the
 * submission is Tal's, with the store accounts (plan 15.7).
 *
 *   node scripts/store.mjs check                 limits, URLs, and that the generated files are current
 *   node scripts/store.mjs metadata              write fastlane/metadata/** from store/listing.json
 *   node scripts/store.mjs privacy               write store/privacy-answers.md from store/privacy-labels.json
 *   node scripts/store.mjs desktop --version X --sums release/SHA256SUMS --windows <exe> --mac <dmg>
 *                                                write winget manifests and the Homebrew cask into store/desktop/
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { desktopManifests, fastlaneFiles, listingProblems, privacyAnswers } from "./lib/store.mjs";

const [cmd, ...args] = process.argv.slice(2);
const opt = (f) => {
  const i = args.indexOf(f);
  return i >= 0 ? args[i + 1] : undefined;
};
const listing = JSON.parse(readFileSync("store/listing.json", "utf8"));
const write = (files, base = ".") => {
  for (const [p, text] of Object.entries(files)) {
    const full = join(base, p);
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, text);
  }
  console.error(`wrote ${Object.keys(files).length} file(s)`);
};
const privacyText = () => privacyAnswers(JSON.parse(readFileSync("store/privacy-labels.json", "utf8")));

if (cmd === "metadata") write(fastlaneFiles(listing));
else if (cmd === "privacy") write({ "store/privacy-answers.md": privacyText() });
else if (cmd === "desktop") {
  const version = opt("--version");
  const sums = readFileSync(opt("--sums") ?? "release/SHA256SUMS", "utf8");
  write(desktopManifests({ version, sums, files: { windows: opt("--windows"), mac: opt("--mac") }, listing }), "store/desktop");
} else if (cmd === "check") {
  const problems = listingProblems(listing);
  for (const [p, text] of Object.entries(fastlaneFiles(listing))) if (!existsSync(p) || readFileSync(p, "utf8") !== text) problems.push(`${p} is out of date: run node scripts/store.mjs metadata`);
  if (!existsSync("store/privacy-answers.md") || readFileSync("store/privacy-answers.md", "utf8") !== privacyText()) problems.push("store/privacy-answers.md is out of date: run node scripts/store.mjs privacy");
  if (problems.length) {
    for (const p of problems) console.error(`✖ ${p}`);
    process.exit(1);
  }
  console.log("✓ store: listings within every store's limits (en, he), metadata and privacy answers current");
} else {
  console.error("usage: node scripts/store.mjs check | metadata | privacy | desktop --version X --sums SHA256SUMS --windows <exe> --mac <dmg>");
  process.exit(2);
}
