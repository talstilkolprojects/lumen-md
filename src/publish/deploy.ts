/**
 * Deploy a built site (./site.ts) to the user's own host (plan 4.18):
 *
 *  - **GitHub Pages**: one commit that replaces the whole content of a branch
 *    (default `gh-pages`) of the user's repository, made with GitHub's REST
 *    git-data API and the user's token, then Pages switched on for that
 *    branch. The commit sits on top of the branch's previous commit (no force
 *    push), so earlier versions of the site stay in its history.
 *  - **A .zip** for any other static host (Netlify Drop, Cloudflare Pages,
 *    a web server): the site's files, unpacked at the root.
 *
 * Only the site's files are sent, only to the repository the user named,
 * only when the user presses Publish. The token is the user's own (the git
 * sync token, or one given for publishing), and goes to api.github.com only.
 */

import { zip } from "../storage/zip";
import type { SiteFile } from "./site";

export const GITHUB_API = "https://api.github.com";

export interface GitHubTarget {
  owner: string;
  repo: string;
  /** Default `gh-pages`. */
  branch?: string;
  token: string;
}

export interface DeployProgress {
  done: number;
  total: number;
  step: "blobs" | "tree" | "commit" | "ref" | "pages";
}

export interface DeployResult {
  /** The published site's address (GitHub's answer, else the usual github.io address). */
  url: string;
  commit: string;
  branch: string;
}

export class DeployError extends Error {
  constructor(
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = "DeployError";
  }
}

const NAME_RE = /^[A-Za-z0-9_.-]+$/;

/** `owner/repo`, a github.com URL or a git remote → owner and repo. */
export function parseRepo(input: string): { owner: string; repo: string } | null {
  const s = input.trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const m = /^(?:https?:\/\/github\.com\/|git@github\.com:)?([^/\s]+)\/([^/\s]+)$/.exec(s);
  if (!m || !NAME_RE.test(m[1]) || !NAME_RE.test(m[2])) return null;
  return { owner: m[1], repo: m[2] };
}

function base64(data: Uint8Array): string {
  let s = "";
  for (let i = 0; i < data.length; i += 0x8000) s += String.fromCharCode(...data.subarray(i, i + 0x8000));
  return btoa(s);
}

/** The usual Pages address of a repository (a user site `<owner>.github.io` is served at the root). */
export function pagesUrl(owner: string, repo: string): string {
  const host = `${owner.toLowerCase()}.github.io`;
  return repo.toLowerCase() === host ? `https://${host}/` : `https://${host}/${repo}/`;
}

/** Publish the site to a branch of a GitHub repository and switch Pages on for it. */
export async function deployToGitHubPages(
  files: readonly SiteFile[],
  target: GitHubTarget,
  opts: { message?: string; fetch?: typeof fetch; onProgress?: (p: DeployProgress) => void } = {},
): Promise<DeployResult> {
  const f = opts.fetch ?? fetch;
  const branch = target.branch?.trim() || "gh-pages";
  if (!NAME_RE.test(target.owner) || !NAME_RE.test(target.repo)) throw new DeployError("owner and repository must be plain names");
  if (!/^[\w./-]+$/.test(branch) || branch.includes("..")) throw new DeployError(`not a branch name: ${branch}`);
  const repoPath = `/repos/${target.owner}/${target.repo}`;
  const call = async <T>(method: string, path: string, body?: unknown, okStatuses: number[] = []): Promise<{ status: number; data: T }> => {
    const res = await f(`${GITHUB_API}${path}`, {
      method,
      headers: { Accept: "application/vnd.github+json", Authorization: `Bearer ${target.token}`, "X-GitHub-Api-Version": "2022-11-28", ...(body ? { "Content-Type": "application/json" } : {}) },
      ...(body ? { body: JSON.stringify(body) } : {}),
    });
    const data = (await res.json().catch(() => ({}))) as T;
    if (!res.ok && !okStatuses.includes(res.status)) {
      const msg = (data as { message?: string }).message ?? res.statusText;
      if (res.status === 401) throw new DeployError(`GitHub refused the token (401): ${msg}`, 401);
      if (res.status === 403 || res.status === 404) throw new DeployError(`No write access to ${target.owner}/${target.repo} with this token (${res.status}): ${msg}`, res.status);
      if (res.status === 409) throw new DeployError(`${target.owner}/${target.repo} is empty: add a first commit (a README) on GitHub, then publish again (409)`, 409);
      throw new DeployError(`GitHub ${method} ${path} failed (${res.status}): ${msg}`, res.status);
    }
    return { status: res.status, data };
  };

  // The branch's current commit, if it exists: the new commit goes on top of it.
  const ref = await call<{ object?: { sha?: string } }>("GET", `${repoPath}/git/ref/heads/${branch}`, undefined, [404]);
  const parent = ref.status === 404 ? null : (ref.data.object?.sha ?? null);

  // Text goes inline in the tree; binary files (images) as base64 blobs first.
  const entries: { path: string; mode: "100644"; type: "blob"; sha?: string; content?: string }[] = [];
  const binary = files.filter((x) => typeof x.data !== "string");
  let done = 0;
  for (const file of files) {
    if (typeof file.data === "string") {
      entries.push({ path: file.path, mode: "100644", type: "blob", content: file.data });
      continue;
    }
    const blob = await call<{ sha: string }>("POST", `${repoPath}/git/blobs`, { content: base64(file.data), encoding: "base64" });
    entries.push({ path: file.path, mode: "100644", type: "blob", sha: blob.data.sha });
    opts.onProgress?.({ done: ++done, total: binary.length, step: "blobs" });
  }
  opts.onProgress?.({ done: 0, total: 1, step: "tree" });
  // No base_tree: the branch holds exactly the site, so pages that were unpublished disappear.
  const tree = await call<{ sha: string }>("POST", `${repoPath}/git/trees`, { tree: entries });
  opts.onProgress?.({ done: 0, total: 1, step: "commit" });
  const commit = await call<{ sha: string }>("POST", `${repoPath}/git/commits`, {
    message: opts.message ?? "Publish site from Lumen",
    tree: tree.data.sha,
    parents: parent ? [parent] : [],
  });
  opts.onProgress?.({ done: 0, total: 1, step: "ref" });
  if (parent) await call("PATCH", `${repoPath}/git/refs/heads/${branch}`, { sha: commit.data.sha, force: false });
  else await call("POST", `${repoPath}/git/refs`, { ref: `refs/heads/${branch}`, sha: commit.data.sha });

  // Pages on, from the root of that branch. 409: already on; then point it at this branch.
  opts.onProgress?.({ done: 0, total: 1, step: "pages" });
  let url = pagesUrl(target.owner, target.repo);
  const pages = await call<{ html_url?: string }>("POST", `${repoPath}/pages`, { source: { branch, path: "/" } }, [409, 422]);
  if (pages.status === 409 || pages.status === 422) {
    await call("PUT", `${repoPath}/pages`, { source: { branch, path: "/" } }, [400, 409, 422]);
    const info = await call<{ html_url?: string }>("GET", `${repoPath}/pages`, undefined, [404]);
    if (info.data.html_url) url = info.data.html_url;
  } else if (pages.data.html_url) url = pages.data.html_url;
  return { url, commit: commit.data.sha, branch };
}

/** The site as one .zip, files at the root. */
export async function siteZip(files: readonly SiteFile[]): Promise<Uint8Array> {
  return zip(files.map((x) => ({ name: x.path, data: x.data })));
}
