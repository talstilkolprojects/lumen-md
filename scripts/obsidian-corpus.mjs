#!/usr/bin/env node
/**
 * The real-vault corpus for Obsidian compatibility (plan W4.30).
 *
 *   node scripts/obsidian-corpus.mjs           check every file against manifest.json (sha256)
 *   node scripts/obsidian-corpus.mjs --fetch   download each vault at its pinned commit and copy the files again
 *
 * The files live in src/__tests__/fixtures/obsidian-corpus/<vault>/ as
 * byte-for-byte copies; src/__tests__/obsidianCorpus.test.ts runs Lumen's
 * open → save path over them.
 */
import { createHash } from "node:crypto";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { execFileSync } from "node:child_process";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..", "src", "__tests__", "fixtures", "obsidian-corpus");
const manifest = JSON.parse(readFileSync(join(root, "manifest.json"), "utf8"));
const sha = (p) => createHash("sha256").update(readFileSync(p)).digest("hex");

if (process.argv.includes("--fetch")) {
  for (const v of manifest.vaults) {
    const tmp = mkdtempSync(join(tmpdir(), `obsidian-${v.id}-`));
    try {
      const git = (...args) => execFileSync("git", ["-C", tmp, ...args], { stdio: ["ignore", "ignore", "inherit"] });
      git("init", "-q");
      git("remote", "add", "origin", v.repo);
      git("fetch", "-q", "--depth", "1", "origin", v.commit);
      git("-c", "core.autocrlf=false", "checkout", "-q", "FETCH_HEAD");
      for (const f of v.files) {
        const to = join(root, v.id, f.path);
        mkdirSync(dirname(to), { recursive: true });
        copyFileSync(join(tmp, f.path), to);
      }
      copyFileSync(join(tmp, v.licenceFile), join(root, v.id, "LICENSE.upstream"));
      console.log(`${v.id}: ${v.files.length} files at ${v.commit.slice(0, 12)}`);
    } finally {
      rmSync(tmp, { recursive: true, force: true });
    }
  }
}

let bad = 0;
let n = 0;
for (const v of manifest.vaults) {
  if (!existsSync(join(root, v.id, "LICENSE.upstream"))) {
    console.error(`${v.id}: LICENSE.upstream is missing`);
    bad++;
  }
  for (const f of v.files) {
    n++;
    const p = join(root, v.id, f.path);
    if (!existsSync(p)) {
      console.error(`missing: ${v.id}/${f.path}`);
      bad++;
    } else if (sha(p) !== f.sha256) {
      console.error(`changed: ${v.id}/${f.path}`);
      bad++;
    }
  }
}
console.log(`${n - bad}/${n} corpus files match the manifest`);
process.exit(bad ? 1 : 0);
