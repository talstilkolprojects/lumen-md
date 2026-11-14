/**
 * Git tools — what changed in a repository cloned into the workspace,
 * through the existing isomorphic-git integration (`src/sync/git.ts`).
 * Read-only: nothing is staged, committed or pushed.
 */

import { defineTool, optionalNumber, ToolError, throwIfAborted } from "./define";
import { fileDiff } from "../../lib/lineDiff";

const MAX_DIFF = 16_000;

export interface GitDiffResult {
  repo: string;
  staged: boolean;
  /** `rewritten`: too large to diff line by line; the counts are then the file's whole old / new length. */
  files: Array<{ path: string; state: "added" | "modified" | "deleted"; binary: boolean; added: number; removed: number; rewritten?: true }>;
  diff: string;
  truncated: boolean;
}

/** The repo a call means: the one named, the one holding the open document, or the only one there is. */
async function resolveRepo(arg: unknown, path: string | null | undefined): Promise<string> {
  const { listGitRepos } = await import("../../sync/git");
  const repos = await listGitRepos();
  if (typeof arg === "string" && arg.trim()) {
    const name = arg.trim().replace(/^\/+|\/+$/g, "");
    if (!repos.includes(name)) throw new ToolError("not-found", `No cloned repository "${name}". Cloned: ${repos.join(", ") || "none"}`);
    return name;
  }
  const fromDoc = path ? repos.find((r) => path === r || path.startsWith(`${r}/`)) : undefined;
  if (fromDoc) return fromDoc;
  if (repos.length === 1) return repos[0];
  if (!repos.length) throw new ToolError("not-found", "No git repository is cloned in this workspace (Git: Clone)");
  throw new ToolError("bad-args", `Several repositories are cloned; pass "repo": ${repos.join(", ")}`);
}

export const gitDiffTool = defineTool<
  { repo?: string; staged?: boolean; paths?: string[]; context?: number; maxChars?: number },
  GitDiffResult
>({
  name: "git_diff",
  description:
    "Unified diff of a cloned git repository: by default HEAD against the working copy (what the next commit records); " +
    "staged=true for HEAD against the index. Optional paths (files or folders) narrow it.",
  parameters: {
    type: "object",
    properties: {
      repo: { type: "string", description: "Repository folder; default: the repo of the open document, or the only one" },
      staged: { type: "boolean", description: "Diff the index (staged changes) instead of the working copy" },
      paths: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 50 },
      context: { type: "integer", minimum: 0, maximum: 20 },
      maxChars: { type: "integer", minimum: 200, maximum: MAX_DIFF },
    },
    additionalProperties: false,
  },
  // Plan 2.7: HEAD's side of a cloned or pulled repo (deleted and context
  // lines) is someone else's text, so the diff carries the repo's provenance.
  untrusted: async (_args, result) => {
    if (!result.files.length && !result.diff) return [];
    const { ensureProvenanceBackfill, untrustedSourcesOfNote } = await import("../untrusted");
    await ensureProvenanceBackfill();
    const sources = new Set<string>();
    for (const f of result.files.length ? result.files.map((x) => x.path) : [`${result.repo}/`]) for (const s of untrustedSourcesOfNote(f)) sources.add(s);
    return [...sources].slice(0, 20);
  },
  run: async (args, ctx) => {
    const repo = await resolveRepo(args.repo, ctx.path);
    throwIfAborted(ctx.signal);
    const staged = args.staged === true;
    const prefix = `${repo}/`;
    const paths = Array.isArray(args.paths) ? args.paths.filter((p): p is string => typeof p === "string").map((p) => (p.startsWith(prefix) ? p.slice(prefix.length) : p)) : undefined;
    const { gitDiffEntries } = await import("../../sync/git");
    let changes;
    try {
      changes = await gitDiffEntries(repo, { staged, paths, signal: ctx.signal });
    } catch (e) {
      if (ctx.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
      throw new ToolError("failed", `git diff failed: ${(e as Error)?.message ?? e}`);
    }
    const context = Math.min(20, Math.max(0, optionalNumber(args, "context", 3)));
    const max = Math.min(MAX_DIFF, Math.max(200, optionalNumber(args, "maxChars", MAX_DIFF)));
    const files: GitDiffResult["files"] = [];
    const parts: string[] = [];
    for (const c of changes) {
      throwIfAborted(ctx.signal);
      const rel = c.path.slice(prefix.length);
      if (c.binary) {
        files.push({ path: c.path, state: c.state, binary: true, added: 0, removed: 0 });
        parts.push(`Binary file ${rel} ${c.state}`);
        continue;
      }
      const { text: d, added, removed, rewritten } = fileDiff(rel, c.state === "added" ? null : c.before, c.state === "deleted" ? null : c.after, context);
      files.push({ path: c.path, state: c.state, binary: false, added, removed, ...(rewritten ? { rewritten: true as const } : {}) });
      if (d) parts.push(`diff --git a/${rel} b/${rel}\n${d}`);
    }
    const diff = parts.join("\n");
    return { repo, staged, files, diff: diff.length > max ? diff.slice(0, max) : diff, truncated: diff.length > max };
  },
});

export const GIT_TOOLS = [gitDiffTool];
