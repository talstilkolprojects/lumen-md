/**
 * Workspace tools — what an agent may do to the vault.
 *
 * Reads are always granted. The write tools (`write_file`,
 * `set_frontmatter`) need the `write` grant, which the command that runs
 * the agent gives explicitly — and even then they never write: they stage
 * the change (`../staging.ts`) and the user approves it.
 */

import YAML from "yaml";
import { defineTool, optionalNumber, requireString, safeWorkspacePath, stageChange, throwIfAborted, ToolError } from "./define";
import { rangeContext } from "../staging";
import type { StagedReceipt } from "../types";
import {
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
  workspaceHasFile,
} from "../../storage/workspace";
import { searchWorkspace } from "../../storage/workspaceIndex";
import { extractFrontmatter } from "../../renderer/pipeline";
import { buildTagsIndex } from "../../views/tagsIndex";

const MAX_READ = 24_000;

function needWorkspace(): void {
  if (!isOPFSAvailable()) throw new ToolError("failed", "Workspace is not available in this browser");
}

export const readFileTool = defineTool<{ path: string; maxChars?: number; offset?: number }, { path: string; content: string; truncated: boolean }>({
  name: "read_file",
  description:
    "Read a markdown or text file from the workspace. Returns at most maxChars characters (default 24000), " +
    "from character offset `offset` (default 0); `truncated` says more follows.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Workspace path, e.g. notes/todo.md" },
      maxChars: { type: "number", minimum: 1 },
      offset: { type: "number", minimum: 0 },
    },
    required: ["path"],
    additionalProperties: false,
  },
  untrusted: async (_args, result) => (await import("../untrusted")).untrustedSourcesOfNote(result.path, result.content),
  run: async (args) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    const max = Math.min(MAX_READ, Math.max(200, optionalNumber(args, "maxChars", MAX_READ)));
    let content: string;
    try {
      content = await readWorkspaceFile(path);
    } catch {
      throw new ToolError("not-found", `No such file: ${path}`);
    }
    const from = Math.max(0, Math.floor(optionalNumber(args, "offset", 0)));
    return { path, content: content.slice(from, from + max), truncated: content.length > from + max };
  },
});

async function readOrNull(path: string): Promise<string | null> {
  if (!(await workspaceHasFile(path))) return null;
  try {
    return await readWorkspaceFile(path);
  } catch {
    return null;
  }
}

export const writeFileTool = defineTool<{ path: string; content: string }, StagedReceipt>({
  name: "write_file",
  description: "Propose creating or overwriting a workspace file with the given content. The write is staged for the user's approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1 },
      content: { type: "string" },
    },
    required: ["path", "content"],
    additionalProperties: false,
  },
  scope: "write",
  run: async (args, ctx) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    // A missing or non-string body is a malformed call, never an empty file.
    if (typeof args.content !== "string") throw new ToolError("bad-args", '"content" must be a string');
    const content = args.content;
    const before = await readOrNull(path);
    throwIfAborted(ctx.signal);
    if (before === content) throw new ToolError("bad-args", `${path} already has exactly this content`);
    return stageChange(ctx, "write_file", {
      kind: "file",
      path,
      before,
      after: content,
      summary: `${before === null ? "Create" : "Overwrite"} ${path} (${content.length} chars)`,
    });
  },
});

export const listFilesTool = defineTool<
  { prefix?: string; limit?: number; offset?: number; modifiedSince?: number; withModified?: boolean },
  { files: string[]; total: number; modified?: Record<string, number> }
>({
  name: "list_files",
  description:
    "List markdown files in the workspace, optionally under a folder prefix, or only those modified since a time (ms since epoch). " +
    "withModified adds each file's modification time. `offset` skips that many files (paging: `total` is the full count).",
  parameters: {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Folder prefix, e.g. projects/" },
      limit: { type: "number", minimum: 1 },
      offset: { type: "number", minimum: 0 },
      modifiedSince: { type: "number", minimum: 0, description: "Only files modified after this time (ms since epoch)" },
      withModified: { type: "boolean" },
    },
    additionalProperties: false,
  },
  // Plan 2.7: names of outside notes (clipped, imported, pulled) are outside text
  // too. Path and records only — a `source:` frontmatter is not read here.
  untrusted: async (_args, result) => {
    const { ensureProvenanceBackfill, untrustedSourcesOfNote } = await import("../untrusted");
    await ensureProvenanceBackfill();
    const out = new Set<string>();
    for (const p of result.files) for (const s of untrustedSourcesOfNote(p)) out.add(s);
    return [...out].slice(0, 20);
  },
  run: async (args) => {
    needWorkspace();
    const prefix = typeof args.prefix === "string" ? safeWorkspacePath(args.prefix) : "";
    const limit = Math.min(500, Math.max(1, optionalNumber(args, "limit", 200)));
    const since = typeof args.modifiedSince === "number" ? args.modifiedSince : null;
    const all = (await listWorkspace({ includeAssets: false }))
      .filter((f) => /\.(md|markdown|txt)$/i.test(f.path) && (!prefix || f.path.startsWith(prefix)) && (since === null || f.modified > since))
      .sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
    const from = Math.max(0, Math.floor(optionalNumber(args, "offset", 0)));
    const shown = all.slice(from, from + limit);
    return {
      files: shown.map((f) => f.path),
      total: all.length,
      ...(args.withModified ? { modified: Object.fromEntries(shown.map((f) => [f.path, f.modified])) } : {}),
    };
  },
});

export const fileExistsTool = defineTool<{ path: string }, { path: string; exists: boolean }>({
  name: "file_exists",
  description: "Check whether a workspace path exists.",
  parameters: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
  run: async (args) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    return { path, exists: await workspaceHasFile(path) };
  },
});

export const searchWorkspaceTool = defineTool<
  { query: string; limit?: number; folder?: string },
  { hits: Array<{ path: string; snippet: string | null; score: number }> }
>({
  name: "search_workspace",
  description:
    "Keyword search (BM25, Hebrew-aware: niqqud, final letters and prefix letters folded) over file names and contents. " +
    "Ask with the key words, or a question. Returns the best matching files with a snippet. `folder` limits the search to that folder (e.g. the clip library).",
  parameters: {
    type: "object",
    properties: { query: { type: "string", minLength: 1 }, limit: { type: "number", minimum: 1 }, folder: { type: "string", description: "Only files under this folder, e.g. Library/" } },
    required: ["query"],
    additionalProperties: false,
  },
  // Snippets of outside notes are outside text too.
  untrusted: async (_args, result) => {
    const { untrustedSourcesOfNote } = await import("../untrusted");
    const { readWorkspaceFile } = await import("../../storage/workspace");
    const out: string[] = [];
    for (const h of result.hits) out.push(...untrustedSourcesOfNote(h.path, await readWorkspaceFile(h.path).catch(() => null)));
    return out;
  },
  run: async (args) => {
    needWorkspace();
    const query = requireString(args, "query");
    const limit = Math.min(50, Math.max(1, optionalNumber(args, "limit", 10)));
    const folder = typeof args.folder === "string" && args.folder.trim() ? safeWorkspacePath(args.folder).replace(/\/?$/, "/") : "";
    const hits = await searchWorkspace(query, { limit, ...(folder ? { filter: (p: string) => p.startsWith(folder) } : {}) });
    return { hits: hits.map((h) => ({ path: h.path, snippet: h.snippet, score: h.score })) };
  },
});

export const getFrontmatterTool = defineTool<{ path: string }, { path: string; frontmatter: Record<string, unknown> | null }>({
  name: "get_frontmatter",
  description: "Return the YAML frontmatter of a file as JSON (null when it has none).",
  parameters: { type: "object", properties: { path: { type: "string", minLength: 1 } }, required: ["path"], additionalProperties: false },
  untrusted: async (_args, result) => {
    const { readWorkspaceFile } = await import("../../storage/workspace");
    return (await import("../untrusted")).untrustedSourcesOfNote(result.path, await readWorkspaceFile(result.path).catch(() => null));
  },
  run: async (args) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    let body: string;
    try {
      body = await readWorkspaceFile(path);
    } catch {
      throw new ToolError("not-found", `No such file: ${path}`);
    }
    return { path, frontmatter: extractFrontmatter(body) };
  },
});

export const listTagsTool = defineTool<{ limit?: number }, { tags: Array<{ tag: string; count: number }> }>({
  name: "list_tags",
  description: "List the tags already used in the workspace, most used first.",
  parameters: { type: "object", properties: { limit: { type: "number", minimum: 1 } }, additionalProperties: false },
  run: async (args) => {
    needWorkspace();
    const limit = Math.min(300, Math.max(1, optionalNumber(args, "limit", 80)));
    const idx = await buildTagsIndex();
    return { tags: idx.buckets.slice(0, limit).map((b) => ({ tag: b.tag, count: b.count })) };
  },
});

/** The frontmatter block at the top of a document: `---` … `---`, with its line break. */
const FRONTMATTER = /^---[ \t]*\r?\n(?:([\s\S]*?)\r?\n)?---[ \t]*(?:\r?\n|$)/;

/**
 * `text` with its frontmatter changed: keys in `set` added or replaced,
 * keys in `remove` deleted. Edited through the `yaml` Document API, so
 * comments, key order and the style of untouched values survive (a flow
 * list stays a flow list when it is replaced). An empty result drops the
 * block. Throws when the existing frontmatter is not a valid YAML map.
 */
export function updateFrontmatter(
  text: string,
  set: Record<string, unknown>,
  remove: string[] = [],
): { text: string; block: { from: number; to: number; before: string; after: string }; frontmatter: Record<string, unknown> | null } {
  const m = FRONTMATTER.exec(text);
  const eol = m && /\r\n/.test(m[0]) ? "\r\n" : "\n";
  const doc = YAML.parseDocument(m?.[1] ?? "");
  if (doc.errors.length) throw new ToolError("failed", `The frontmatter is not valid YAML (${doc.errors[0].message.split("\n")[0]}); fix it before changing it`);
  if (doc.contents !== null && !YAML.isMap(doc.contents)) throw new ToolError("failed", "The frontmatter is not a key/value map");
  for (const [key, value] of Object.entries(set)) {
    if (value === undefined) continue;
    const prev = YAML.isMap(doc.contents) ? doc.get(key, true) : undefined;
    const flow = (YAML.isSeq(prev) || YAML.isMap(prev)) && !!(prev as { flow?: boolean }).flow;
    doc.set(key, value !== null && typeof value === "object" ? doc.createNode(value, { flow }) : value);
  }
  for (const key of remove) doc.delete(key);
  const empty = !YAML.isMap(doc.contents) || doc.contents.items.length === 0;
  const body = empty ? "" : doc.toString().replace(/\n/g, eol);
  const after = empty ? "" : `---${eol}${body}---${eol}`;
  const before = m?.[0] ?? "";
  const value = empty ? null : (doc.toJS() as Record<string, unknown>);
  return { text: after + text.slice(before.length), block: { from: 0, to: before.length, before, after }, frontmatter: value };
}

export const setFrontmatterTool = defineTool<
  { path?: string; set?: Record<string, unknown>; remove?: string[] },
  StagedReceipt & { frontmatter: Record<string, unknown> | null }
>({
  name: "set_frontmatter",
  description:
    "Propose changing the YAML frontmatter of the open document (no path) or of a workspace file: `set` adds or replaces keys, " +
    "`remove` deletes keys. Comments and the other keys are kept. The change is staged for the user's approval.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", minLength: 1, description: "Workspace path; default: the open document" },
      set: { type: "object", description: "Keys to add or replace, with JSON values" },
      remove: { type: "array", items: { type: "string", minLength: 1 }, maxItems: 50 },
    },
    additionalProperties: false,
  },
  scope: "write",
  run: async (args, ctx) => {
    const set = args.set && typeof args.set === "object" && !Array.isArray(args.set) ? args.set : {};
    const remove = Array.isArray(args.remove) ? args.remove.filter((k): k is string => typeof k === "string" && !!k) : [];
    if (!Object.keys(set).length && !remove.length) throw new ToolError("bad-args", 'Nothing to change: give "set" and/or "remove"');
    if (Object.keys(set).some((k) => !k.trim())) throw new ToolError("bad-args", "Frontmatter keys must be non-empty");
    const path = typeof args.path === "string" && args.path.trim() ? safeWorkspacePath(args.path) : null;
    const onOpenDocument = ctx.document !== undefined && (!path || path === ctx.path);
    if (onOpenDocument) {
      const r = updateFrontmatter(ctx.document!, set, remove);
      if (r.block.before === r.block.after) throw new ToolError("bad-args", "The frontmatter already has these values");
      const receipt = stageChange(ctx, "set_frontmatter", {
        kind: "range",
        path: ctx.path ?? null,
        ...r.block,
        context: rangeContext(ctx.document!, r.block.from, r.block.to),
        summary: `Frontmatter: ${[...Object.keys(set).map((k) => `set ${k}`), ...remove.map((k) => `remove ${k}`)].join(", ")}`,
      });
      return { ...receipt, frontmatter: r.frontmatter };
    }
    if (!path) throw new ToolError("bad-args", 'No document is open: pass "path"');
    needWorkspace();
    const before = await readOrNull(path);
    if (before === null) throw new ToolError("not-found", `No such file: ${path}`);
    throwIfAborted(ctx.signal);
    const r = updateFrontmatter(before, set, remove);
    if (r.text === before) throw new ToolError("bad-args", "The frontmatter already has these values");
    const receipt = stageChange(ctx, "set_frontmatter", {
      kind: "file",
      path,
      before,
      after: r.text,
      summary: `Frontmatter of ${path}: ${[...Object.keys(set).map((k) => `set ${k}`), ...remove.map((k) => `remove ${k}`)].join(", ")}`,
    });
    return { ...receipt, frontmatter: r.frontmatter };
  },
});

export const WORKSPACE_TOOLS = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  fileExistsTool,
  searchWorkspaceTool,
  getFrontmatterTool,
  setFrontmatterTool,
  listTagsTool,
];
