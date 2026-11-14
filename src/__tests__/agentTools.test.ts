import { describe, it, expect, vi, beforeEach } from "vitest";

const files = new Map<string, string>();
vi.mock("../storage/workspace", () => ({
  isOPFSAvailable: () => true,
  listWorkspace: async () => [...files.keys()].map((path) => ({ path, name: path.split("/").pop() })),
  readWorkspaceFile: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return files.get(p)!;
  },
  writeWorkspaceFile: async (p: string, c: string) => void files.set(p, c),
  workspaceHasFile: async (p: string) => files.has(p),
  isAssetName: () => false,
}));
vi.mock("../storage/workspaceIndex", () => ({
  searchWorkspace: async (q: string) =>
    [...files.entries()].filter(([, c]) => c.includes(q)).map(([path, c]) => ({ path, name: path, score: 5, snippet: c.slice(0, 40) })),
  ensureIndex: async () => {},
  indexedFiles: () => [...files.entries()].map(([path, content]) => ({ path, name: path.split("/").pop() ?? path, content, modified: 0, wikiTargets: [] })),
}));
const parse = vi.fn();
vi.mock("mermaid", () => ({ default: { parse } }));

import { checkECharts, checkJson, checkMermaid, stripMermaidFence, echartsValidator, jsonValidator, nonEmptyValidator } from "../agents/tools/validate";
import { readFileTool, writeFileTool, listFilesTool, fileExistsTool, searchWorkspaceTool, getFrontmatterTool, listTagsTool } from "../agents/tools/workspace";
import { getDocumentTool, getSelectionTool, getHeadingsTool } from "../agents/tools/editor";
import { safeWorkspacePath, ToolError } from "../agents/tools/define";
import type { ToolContext } from "../agents/types";

const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({ grants: new Set(["read"]), ...extra });

describe("validation checks", () => {
  it("checkJson tolerates fences and prose, and requires keys", () => {
    expect(checkJson('```json\n{"a":1}\n```').ok).toBe(true);
    expect(checkJson('Here: {"tags":["x"]}', ["tags"]).ok).toBe(true);
    const r = checkJson('{"other":1}', ["tags"]);
    expect(r.ok).toBe(false);
    expect(r.missing).toEqual(["tags"]);
    expect(checkJson("nope").ok).toBe(false);
    expect(checkJson("[1,2]", ["a"]).error).toContain("object");
  });

  it("checkECharts wants typed series with data, and axes for cartesian charts", () => {
    expect(checkECharts('{"series":[{"type":"pie","data":[1]}]}')).toEqual({ ok: true, seriesTypes: ["pie"] });
    expect(checkECharts('{"xAxis":{},"yAxis":{},"series":[{"type":"bar","data":[1,2]}]}').ok).toBe(true);
    expect(checkECharts('{"series":[{"type":"bar","data":[1]}]}').error).toContain("xAxis");
    expect(checkECharts('{"series":[]}').error).toContain("non-empty");
    expect(checkECharts('{"series":[{"data":[1]}]}').error).toContain("type");
    expect(checkECharts('{"series":[{"type":"line","data":[]}]}').error).toContain("no data");
    expect(checkECharts("[]").error).toContain("option object");
  });

  it("checkMermaid strips fences and reports the parser's error", async () => {
    parse.mockResolvedValueOnce({ diagramType: "flowchart-v2" });
    expect(await checkMermaid("```mermaid\ngraph TD; A-->B\n```")).toEqual({ ok: true, diagramType: "flowchart-v2" });
    expect(parse).toHaveBeenCalledWith("graph TD; A-->B", { suppressErrors: false });
    parse.mockRejectedValueOnce(new Error("Parse error on line 1:\n...^\nExpecting 'SEMI'"));
    const bad = await checkMermaid("graph TD A-->");
    expect(bad.ok).toBe(false);
    expect(bad.error).toContain("Parse error on line 1");
    expect(await checkMermaid("   ")).toEqual({ ok: false, error: "Empty diagram" });
    expect(stripMermaidFence("```\nx\n```")).toBe("x");
  });

  it("validators wrap the checks", async () => {
    expect(jsonValidator(["a"]).check('{"a":1}')).toEqual({ ok: true });
    expect(jsonValidator().check("x").ok).toBe(false);
    expect(echartsValidator.check({ series: [{ type: "pie", data: [1] }] })).toEqual({ ok: true });
    expect(nonEmptyValidator().check("  ").ok).toBe(false);
    expect(nonEmptyValidator(3).check("ab").ok).toBe(false);
  });
});

describe("workspace tools", () => {
  beforeEach(() => {
    files.clear();
    files.set("notes/a.md", "---\ntags: [alpha, beta]\n---\n# A\nhello world");
    files.set("notes/b.md", "---\ntags:\n  - beta\n---\nnothing");
    files.set("img.png", "binary");
  });

  it("reads, truncates and reports missing files", async () => {
    const r = await readFileTool.run({ path: "notes/a.md", maxChars: 200 }, ctx());
    expect(r.content).toContain("hello world");
    expect(r.truncated).toBe(false);
    await expect(readFileTool.run({ path: "nope.md" }, ctx())).rejects.toMatchObject({ code: "not-found" });
    await expect(readFileTool.run({ path: "../etc/passwd" }, ctx())).rejects.toBeInstanceOf(ToolError);
  });

  it("stages writes (scope write) instead of writing, and lists markdown only", async () => {
    expect(writeFileTool.scope).toBe("write");
    const staged: unknown[] = [];
    const stage = (p: unknown) => (staged.push(p), { staged: true as const, changeId: `c${staged.length}`, kind: "file" as const, path: "notes/c.md", summary: "" });
    const w = ctx({ grants: new Set(["read", "write"]), stage });
    // A malformed call never erases a file.
    await expect(writeFileTool.run({ path: "notes/a.md" } as never, w)).rejects.toMatchObject({ code: "bad-args" });
    await expect(writeFileTool.run({ path: "notes/a.md", content: 42 } as never, w)).rejects.toMatchObject({ code: "bad-args" });
    expect(files.get("notes/a.md")).toContain("hello world");
    // Outside the runtime (no stage function) a write tool refuses.
    await expect(writeFileTool.run({ path: "notes/c.md", content: "# C" }, ctx({ grants: new Set(["read", "write"]) }))).rejects.toMatchObject({ code: "denied" });
    const receipt = await writeFileTool.run({ path: "notes/c.md", content: "# C" }, w);
    expect(receipt).toMatchObject({ staged: true, changeId: "c1" });
    expect(staged).toEqual([{ kind: "file", path: "notes/c.md", before: null, after: "# C", summary: "Create notes/c.md (3 chars)" }]);
    expect(files.has("notes/c.md")).toBe(false);
    files.set("notes/c.md", "# C");
    const l = await listFilesTool.run({ prefix: "notes/" }, ctx());
    expect(l.files).toEqual(["notes/a.md", "notes/b.md", "notes/c.md"]);
    expect((await listFilesTool.run({}, ctx())).files).not.toContain("img.png");
    expect(await fileExistsTool.run({ path: "notes/a.md" }, ctx())).toEqual({ path: "notes/a.md", exists: true });
  });

  it("searches, reads frontmatter and lists tags by frequency", async () => {
    const s = await searchWorkspaceTool.run({ query: "hello" }, ctx());
    expect(s.hits.map((h) => h.path)).toEqual(["notes/a.md"]);
    const fm = await getFrontmatterTool.run({ path: "notes/a.md" }, ctx());
    expect(fm.frontmatter).toEqual({ tags: ["alpha", "beta"] });
    const tags = await listTagsTool.run({}, ctx());
    expect(tags.tags).toEqual([
      { tag: "beta", count: 2 },
      { tag: "alpha", count: 1 },
    ]);
  });

  it("rejects paths that leave the workspace", () => {
    expect(safeWorkspacePath("/a/b.md")).toBe("a/b.md");
    expect(() => safeWorkspacePath("a/../../b")).toThrow(ToolError);
    expect(() => safeWorkspacePath("")).toThrow(ToolError);
  });
});

describe("editor tools", () => {
  const doc = "# Title\n\ntext\n\n```\n# not a heading\n```\n\n## Sub ##\n### Third";
  it("expose the document, selection and headings from the run context", async () => {
    const d = await getDocumentTool.run({}, ctx({ document: doc, path: "x.md" }));
    expect(d.path).toBe("x.md");
    expect(d.chars).toBe(doc.length);
    expect(await getSelectionTool.run({}, ctx({ selection: "sel" }))).toEqual({ selection: "sel", empty: false });
    expect(await getSelectionTool.run({}, ctx())).toEqual({ selection: "", empty: true });
    const h = await getHeadingsTool.run({}, ctx({ document: doc }));
    expect(h.headings).toEqual([
      { level: 1, text: "Title", line: 1 },
      { level: 2, text: "Sub", line: 9 },
      { level: 3, text: "Third", line: 10 },
    ]);
  });
});
