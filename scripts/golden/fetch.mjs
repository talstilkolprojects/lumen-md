/**
 * Cached downloads for the golden-set builders. Every source is fetched
 * from an immutable URL (a commit SHA or an exact npm version) and, when
 * the builder pins one, checked against its sha256 before anything reads
 * it. Downloads are untrusted data: they go to their own cache directory,
 * are only ever parsed, and nothing from them is executed.
 *
 * curl, not fetch(): it honours HTTPS_PROXY and the CA bundle on every
 * machine this runs on (the agent container, GitHub Actions, the owner's).
 */
import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync } from "node:fs";
import { join } from "node:path";

const sha256 = (buf) => createHash("sha256").update(buf).digest("hex");

/** Download `url` into `cacheDir` (once) and return its bytes. `sha` (hex) is checked when given. */
export function fetchCached(cacheDir, url, { sha, name } = {}) {
  mkdirSync(cacheDir, { recursive: true });
  const file = join(cacheDir, name ?? sha256(url).slice(0, 24));
  if (!existsSync(file)) {
    const tmp = `${file}.part`;
    const r = spawnSync("curl", ["-fsSL", "--retry", "3", "--retry-delay", "2", "-o", tmp, url], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`download failed (${r.status}): ${url}\n${r.stderr}`);
    renameSync(tmp, file);
  }
  const buf = readFileSync(file);
  if (sha && sha256(buf) !== sha) throw new Error(`sha256 mismatch for ${url}: got ${sha256(buf)}, pinned ${sha}`);
  return buf;
}

export const fetchText = (cacheDir, url, opts) => fetchCached(cacheDir, url, opts).toString("utf8");

/** A file of a GitHub repo at a commit. */
export const rawUrl = (repo, commit, path) => `https://raw.githubusercontent.com/${repo}/${commit}/${path.split("/").map(encodeURIComponent).join("/")}`;

/** File paths under `prefix` in a GitHub repo at a commit (a tree-only fetch: no blobs are downloaded). */
export function gitList(cacheDir, repo, commit, prefix) {
  const dir = join(cacheDir, `git-${repo.replace(/\W+/g, "_")}`);
  mkdirSync(dir, { recursive: true });
  const git = (...a) => {
    const r = spawnSync("git", ["-C", dir, ...a], { encoding: "utf8" });
    if (r.status !== 0) throw new Error(`git ${a.join(" ")} failed: ${r.stderr}`);
    return r.stdout;
  };
  if (!existsSync(join(dir, ".git"))) {
    git("init", "-q");
    git("remote", "add", "origin", `https://github.com/${repo}`);
  }
  const have = spawnSync("git", ["-C", dir, "cat-file", "-e", `${commit}^{commit}`]).status === 0;
  if (!have) git("fetch", "-q", "--depth", "1", "--filter=blob:none", "origin", commit);
  return git("ls-tree", "-r", "--name-only", commit, "--", prefix).split("\n").filter(Boolean).sort();
}

export { sha256 };
