/**
 * Workspace tools — what an agent may do to the vault.
 *
 * Reads are always granted. `write_file` needs the `write` grant, which
 * the command that runs the agent gives explicitly (and the suggestions
 * panel shows), so a model can never write where the user did not expect.
 */

import { defineTool, optionalNumber, requireString, safeWorkspacePath, ToolError } from "./define";
import {
  isOPFSAvailable,
  listWorkspace,
  readWorkspaceFile,
  workspaceHasFile,
  writeWorkspaceFile,
} from "../../storage/workspace";
import { searchWorkspace } from "../../storage/workspaceIndex";
import { extractFrontmatter } from "../../renderer/pipeline";
import { buildTagsIndex } from "../../views/tagsIndex";

const MAX_READ = 24_000;

function needWorkspace(): void {
  if (!isOPFSAvailable()) throw new ToolError("failed", "Workspace is not available in this browser");
}

export const readFileTool = defineTool<{ path: string; maxChars?: number }, { path: string; content: string; truncated: boolean }>({
  name: "read_file",
  description: "Read a markdown or text file from the workspace. Returns at most maxChars characters (default 24000).",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string", description: "Workspace path, e.g. notes/todo.md" },
      maxChars: { type: "number" },
    },
    required: ["path"],
  },
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
    return { path, content: content.slice(0, max), truncated: content.length > max };
  },
});

export const writeFileTool = defineTool<{ path: string; content: string }, { path: string; bytes: number }>({
  name: "write_file",
  description: "Create or overwrite a file in the workspace with the given content.",
  parameters: {
    type: "object",
    properties: {
      path: { type: "string" },
      content: { type: "string" },
    },
    required: ["path", "content"],
  },
  scope: "write",
  run: async (args) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    // A missing or non-string body is a malformed call, never an empty file.
    if (typeof args.content !== "string") throw new ToolError("bad-args", '"content" must be a string');
    const content = args.content;
    await writeWorkspaceFile(path, content);
    return { path, bytes: content.length };
  },
});

export const listFilesTool = defineTool<{ prefix?: string; limit?: number }, { files: string[]; total: number }>({
  name: "list_files",
  description: "List markdown files in the workspace, optionally under a folder prefix.",
  parameters: {
    type: "object",
    properties: {
      prefix: { type: "string", description: "Folder prefix, e.g. projects/" },
      limit: { type: "number" },
    },
  },
  run: async (args) => {
    needWorkspace();
    const prefix = typeof args.prefix === "string" ? safeWorkspacePath(args.prefix) : "";
    const limit = Math.min(500, Math.max(1, optionalNumber(args, "limit", 200)));
    const all = (await listWorkspace({ includeAssets: false }))
      .map((f) => f.path)
      .filter((p) => /\.(md|markdown|txt)$/i.test(p) && (!prefix || p.startsWith(prefix)))
      .sort();
    return { files: all.slice(0, limit), total: all.length };
  },
});

export const fileExistsTool = defineTool<{ path: string }, { path: string; exists: boolean }>({
  name: "file_exists",
  description: "Check whether a workspace path exists.",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
  run: async (args) => {
    needWorkspace();
    const path = safeWorkspacePath(requireString(args, "path"));
    return { path, exists: await workspaceHasFile(path) };
  },
});

export const searchWorkspaceTool = defineTool<
  { query: string; limit?: number },
  { hits: Array<{ path: string; snippet: string | null; score: number }> }
>({
  name: "search_workspace",
  description:
    "Keyword search (BM25, Hebrew-aware: niqqud, final letters and prefix letters folded) over file names and contents. " +
    "Ask with the key words, or a question. Returns the best matching files with a snippet.",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "number" } },
    required: ["query"],
  },
  run: async (args) => {
    needWorkspace();
    const query = requireString(args, "query");
    const limit = Math.min(50, Math.max(1, optionalNumber(args, "limit", 10)));
    const hits = await searchWorkspace(query, { limit });
    return { hits: hits.map((h) => ({ path: h.path, snippet: h.snippet, score: h.score })) };
  },
});

export const getFrontmatterTool = defineTool<{ path: string }, { path: string; frontmatter: Record<string, unknown> | null }>({
  name: "get_frontmatter",
  description: "Return the YAML frontmatter of a file as JSON (null when it has none).",
  parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
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
  parameters: { type: "object", properties: { limit: { type: "number" } } },
  run: async (args) => {
    needWorkspace();
    const limit = Math.min(300, Math.max(1, optionalNumber(args, "limit", 80)));
    const idx = await buildTagsIndex();
    return { tags: idx.buckets.slice(0, limit).map((b) => ({ tag: b.tag, count: b.count })) };
  },
});

export const WORKSPACE_TOOLS = [
  readFileTool,
  writeFileTool,
  listFilesTool,
  fileExistsTool,
  searchWorkspaceTool,
  getFrontmatterTool,
  listTagsTool,
];
