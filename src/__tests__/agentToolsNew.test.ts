/**
 * Plan 5.1 (T2): the agent tool set — all 16 tools of §3 plus the helpers,
 * each with a JSON Schema and a scope; the new tools' happy paths (git_diff
 * on an in-memory repository, set_frontmatter, replace_range, csv_parse,
 * extract_quotes), the staged-change queue and cancellation.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

/* ── In-memory workspace (OPFS) ── */
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
  createWorkspaceFolder: async () => {},
  deleteWorkspaceFile: async (p: string) => void files.delete(p),
  writeWorkspaceBlob: async (p: string, b: Uint8Array) => void files.set(p, new TextDecoder().decode(b)),
  // The git mirror reads the vault as bytes since #269 (safe git).
  readWorkspaceBlob: async (p: string) => {
    if (!files.has(p)) throw new Error("ENOENT");
    return new Blob([files.get(p)!]);
  },
  workspaceHasEntry: async (p: string) => files.has(p) || [...files.keys()].some((k) => k.startsWith(`${p}/`)),
  isAssetName: () => false,
}));
// …and asks the vault backend what is at a path (#269): the same in-memory files.
vi.mock("../storage/vault", async (orig) => ({
  ...(await orig<typeof import("../storage/vault")>()),
  getVaultBackend: () => ({
    stat: async (p: string) =>
      files.has(p) ? { kind: "file", size: files.get(p)!.length, mtime: 0 } : [...files.keys()].some((k) => k.startsWith(`${p}/`)) ? { kind: "directory", size: 0, mtime: 0 } : null,
  }),
}));
vi.mock("../storage/workspaceIndex", () => ({
  searchWorkspace: async (q: string) => [...files.entries()].filter(([, c]) => c.includes(q)).map(([path, c]) => ({ path, name: path, score: 5, snippet: c.slice(0, 40) })),
  ensureIndex: async () => {},
  indexedFiles: () => [...files.entries()].map(([path, content]) => ({ path, name: path.split("/").pop() ?? path, content, modified: 0, wikiTargets: [] })),
}));
const parse = vi.fn();
vi.mock("mermaid", () => ({ default: { parse } }));

/* ── In-memory file system for isomorphic-git (stands in for lightning-fs / IndexedDB) ── */
const mem = vi.hoisted(() => {
  const files = new Map<string, Uint8Array>();
  const dirs = new Set<string>(["/"]);
  const mtimes = new Map<string, number>();
  let tick = 1;
  const norm = (p: string) => ("/" + p).replace(/\/+/g, "/").replace(/(.)\/$/, "$1");
  const parent = (p: string) => p.slice(0, p.lastIndexOf("/")) || "/";
  const err = (code: string, p: string) => Object.assign(new Error(`${code}: ${p}`), { code });
  const ensureDirs = (p: string) => {
    let cur = "";
    for (const part of p.split("/").filter(Boolean)) {
      cur += "/" + part;
      dirs.add(cur);
    }
  };
  const stat = async (raw: string) => {
    const p = norm(raw);
    const isDir = dirs.has(p);
    const f = files.get(p);
    if (!isDir && !f) throw err("ENOENT", p);
    const t = mtimes.get(p) ?? 0;
    return { type: isDir ? "dir" : "file", mode: isDir ? 0o40000 : 0o100644, size: f?.length ?? 0, ino: 0, mtimeMs: t, ctimeMs: t, uid: 1, gid: 1, dev: 1, isFile: () => !isDir, isDirectory: () => isDir, isSymbolicLink: () => false };
  };
  const promises = {
    async readFile(raw: string, opts?: unknown) {
      const p = norm(raw);
      const b = files.get(p);
      if (!b) throw err(dirs.has(p) ? "EISDIR" : "ENOENT", p);
      const enc = typeof opts === "string" ? opts : (opts as { encoding?: string } | undefined)?.encoding;
      return enc === "utf8" ? new TextDecoder().decode(b) : b;
    },
    async writeFile(raw: string, data: Uint8Array | string) {
      const p = norm(raw);
      if (dirs.has(p)) throw err("EISDIR", p);
      ensureDirs(parent(p));
      files.set(p, typeof data === "string" ? new TextEncoder().encode(data) : new Uint8Array(data));
      mtimes.set(p, tick++ * 1000);
    },
    async mkdir(raw: string) {
      const p = norm(raw);
      if (dirs.has(p) || files.has(p)) throw err("EEXIST", p);
      ensureDirs(p);
    },
    async rmdir(raw: string) {
      if (!dirs.delete(norm(raw))) throw err("ENOENT", raw);
    },
    async unlink(raw: string) {
      if (!files.delete(norm(raw))) throw err("ENOENT", raw);
    },
    async readdir(raw: string) {
      const p = norm(raw);
      if (files.has(p)) throw err("ENOTDIR", p);
      if (!dirs.has(p)) throw err("ENOENT", p);
      const prefix = p === "/" ? "/" : p + "/";
      const names = new Set<string>();
      for (const k of [...files.keys(), ...dirs]) if (k !== p && k.startsWith(prefix)) names.add(k.slice(prefix.length).split("/")[0]);
      return [...names];
    },
    stat,
    lstat: stat,
    async readlink(raw: string) {
      throw err("ENOENT", raw);
    },
    async symlink() {
      throw err("EPERM", "symlink");
    },
    async chmod() {},
  };
  const reset = () => {
    files.clear();
    dirs.clear();
    dirs.add("/");
    mtimes.clear();
  };
  return { promises, reset };
});
vi.mock("@isomorphic-git/lightning-fs", () => ({
  default: class {
    promises = mem.promises;
  },
}));

import * as isoGit from "isomorphic-git";
import type { AgentTool, ToolContext } from "../agents/types";
import { ALL_TOOLS, PLAN_TOOLS, getTool, pickTools } from "../agents/tools";
import { validateSchema } from "../agents/schema";
import { coerceArgs } from "../agents/tools/define";
import { gitDiffTool } from "../agents/tools/git";
import { setFrontmatterTool, updateFrontmatter } from "../agents/tools/workspace";
import { lineRange, replaceRangeTool } from "../agents/tools/editor";
import { csvParseTool, parseTable } from "../agents/tools/data";
import { extractQuotes, extractQuotesTool, fetchPageTool, locateQuote, searchWebTool } from "../agents/tools/web";
import { validateEChartsTool, validateJsonTool, validateMermaidTool } from "../agents/tools/validate";
import {
  applyRangeToText,
  approveStagedChange,
  clearStagedChanges,
  discardRunChanges,
  getStagedChange,
  listStagedChanges,
  onStagedChanges,
  receiptOf,
  rejectStagedChange,
  rangeContext,
  setDocumentApplier,
  stageChange,
} from "../agents/staging";
import { diffLines, fileDiff, unifiedDiff } from "../lib/lineDiff";

/** A context whose `stage` is the real queue (what the runtime gives a write tool). */
const ctx = (extra: Partial<ToolContext> = {}): ToolContext => ({
  grants: new Set(["read", "write", "network"]),
  stage: (p) => receiptOf(stageChange(p, { tool: "test" })),
  ...extra,
});

/** One valid and one invalid argument object per tool. */
const SAMPLES: Record<string, { valid: Record<string, unknown>; invalid: Record<string, unknown> }> = {
  read_file: { valid: { path: "notes/a.md", maxChars: 500 }, invalid: { maxChars: 5 } },
  write_file: { valid: { path: "notes/a.md", content: "" }, invalid: { path: "notes/a.md" } },
  list_files: { valid: { prefix: "notes/" }, invalid: { limit: "many" } },
  file_exists: { valid: { path: "a.md" }, invalid: {} },
  search_workspace: { valid: { query: "x", limit: 3 }, invalid: { query: "" } },
  get_frontmatter: { valid: { path: "a.md" }, invalid: { path: 1 } },
  set_frontmatter: { valid: { set: { title: "x" }, remove: ["draft"] }, invalid: { remove: "draft" } },
  list_tags: { valid: {}, invalid: { limit: 0 } },
  get_document: { valid: { maxChars: 1000 }, invalid: { maxChars: "all" } },
  get_selection: { valid: {}, invalid: { extra: true } },
  get_headings: { valid: {}, invalid: { level: 1 } },
  replace_range: { valid: { text: "x", from: 0, to: 1 }, invalid: { text: "x", from: -1 } },
  validate_mermaid: { valid: { code: "graph TD; A-->B" }, invalid: {} },
  validate_echarts: { valid: { option: "{}" }, invalid: { option: {} } },
  validate_json: { valid: { text: "{}", requiredKeys: ["a"] }, invalid: { text: 1 } },
  git_diff: { valid: { staged: true, paths: ["a.md"], context: 2 }, invalid: { context: 99 } },
  search_web: { valid: { query: "lumen", count: 3 }, invalid: { query: "lumen", count: 50 } },
  fetch_page: { valid: { url: "https://example.com/a" }, invalid: { url: "ftp://example.com" } },
  extract_quotes: { valid: { quotes: ["a quote"], url: "https://e.com" }, invalid: { quotes: [] } },
  csv_parse: { valid: { text: "a,b\n1,2", header: true }, invalid: { delimiter: ";;" } },
  run_python: { valid: { code: "print(1)", inputs: { a: 1 }, timeoutMs: 1000 }, invalid: { code: "" } },
};

beforeEach(() => {
  files.clear();
  clearStagedChanges();
});

describe("the tool set (plan §3, T2)", () => {
  it("has all 16 tools of §3, each with a JSON Schema and a scope", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const name of PLAN_TOOLS) expect(names, name).toContain(name);
    expect(PLAN_TOOLS).toHaveLength(16);
    for (const t of ALL_TOOLS) {
      expect(["read", "write", "network"]).toContain(t.scope);
      expect(t.parameters).toMatchObject({ type: "object", additionalProperties: false });
      expect(typeof (t.parameters as { properties?: unknown }).properties).toBe("object");
      expect(t.description.length).toBeGreaterThan(20);
    }
    const scopes = Object.fromEntries(ALL_TOOLS.map((t) => [t.name, t.scope]));
    expect(Object.entries(scopes).filter(([, s]) => s === "write").map(([n]) => n).sort()).toEqual(["replace_range", "set_frontmatter", "write_file"]);
    expect(Object.entries(scopes).filter(([, s]) => s === "network").map(([n]) => n).sort()).toEqual(["fetch_page", "search_web"]);
    expect(pickTools("git_diff", "csv_parse").map((t) => t.name)).toEqual(["git_diff", "csv_parse"]);
    expect(() => pickTools("nope")).toThrow(/Unknown agent tool/);
  });

  it("every tool's schema accepts a valid call and rejects a malformed one", () => {
    expect(Object.keys(SAMPLES).sort()).toEqual(ALL_TOOLS.map((t) => t.name).sort());
    for (const t of ALL_TOOLS) {
      const s = SAMPLES[t.name];
      expect(validateSchema(s.valid, t.parameters), `${t.name} valid`).toEqual([]);
      expect(validateSchema(s.invalid, t.parameters).length, `${t.name} invalid`).toBeGreaterThan(0);
    }
  });

  it("coerces numeric and boolean strings the schema asks for, and nothing else", () => {
    const params = getTool("git_diff")!.parameters;
    expect(coerceArgs({ context: "2", staged: "true", repo: "12" }, params)).toEqual({ context: 2, staged: true, repo: "12" });
    const same = { context: 2 };
    expect(coerceArgs(same, params)).toBe(same);
    expect(coerceArgs({ context: "two" }, params)).toEqual({ context: "two" });
  });

  it("every tool honours an aborted signal before doing anything", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    for (const t of ALL_TOOLS as AgentTool[]) {
      await expect(t.run(SAMPLES[t.name].valid, ctx({ signal: ctrl.signal, document: "x", selection: "a,b" })), t.name).rejects.toMatchObject({ name: "AbortError" });
    }
    expect(listStagedChanges()).toHaveLength(0);
  });
});

describe("validate_* tools", () => {
  it("wrap the deterministic checks", async () => {
    expect(await validateJsonTool.run({ text: '{"a":1}', requiredKeys: ["a"] }, ctx())).toEqual({ ok: true });
    expect((await validateJsonTool.run({ text: '{"b":1}', requiredKeys: ["a"] }, ctx())).missing).toEqual(["a"]);
    expect(await validateEChartsTool.run({ option: '{"series":[{"type":"pie","data":[1]}]}' }, ctx())).toEqual({ ok: true, seriesTypes: ["pie"] });
    parse.mockResolvedValueOnce({ diagramType: "flowchart-v2" });
    expect(await validateMermaidTool.run({ code: "graph TD; A-->B" }, ctx())).toEqual({ ok: true, diagramType: "flowchart-v2" });
  });
});

describe("git_diff", () => {
  const dir = "/git/repo";
  const fs = { promises: mem.promises };
  const author = { name: "T", email: "t@example.invalid" };

  beforeEach(async () => {
    mem.reset();
    await isoGit.init({ fs, dir });
    await mem.promises.writeFile(`${dir}/a.md`, "one\ntwo\nthree\n");
    await mem.promises.writeFile(`${dir}/keep.md`, "same\n");
    await isoGit.add({ fs, dir, filepath: "a.md" });
    await isoGit.add({ fs, dir, filepath: "keep.md" });
    await isoGit.commit({ fs, dir, message: "init", author });
    // The user's edits live in the workspace (OPFS) copy of the repo.
    files.set("repo/a.md", "one\n2\nthree\n");
    files.set("repo/keep.md", "same\n");
    files.set("repo/new.md", "fresh\n");
  });

  it("diffs HEAD against the working copy (what the next commit records)", async () => {
    const r = await gitDiffTool.run({}, ctx({ path: "repo/a.md" }));
    expect(r.repo).toBe("repo");
    expect(r.staged).toBe(false);
    expect(r.files).toEqual([
      { path: "repo/a.md", state: "modified", binary: false, added: 1, removed: 1 },
      { path: "repo/new.md", state: "added", binary: false, added: 1, removed: 0 },
    ]);
    expect(r.diff).toContain("diff --git a/a.md b/a.md\n--- a/a.md\n+++ b/a.md\n@@ -1,3 +1,3 @@\n one\n-two\n+2\n three");
    expect(r.diff).toContain("--- /dev/null\n+++ b/new.md\n@@ -0,0 +1,1 @@\n+fresh");
    expect(r.diff).not.toContain("keep.md");
    expect(r.truncated).toBe(false);
  });

  it("carries the repository's provenance: a cloned or pulled repo's diff is outside content (plan 2.7)", async () => {
    localStorage.setItem("lumen.agents.provenanceBackfill.v1", "1");
    const { markUntrustedNote } = await import("../agents/provenance");
    const r = await gitDiffTool.run({}, ctx({ path: "repo/a.md" }));
    expect(await gitDiffTool.untrusted!({}, r, ctx())).toEqual([]);
    markUntrustedNote("repo", "cloned from git");
    expect(await gitDiffTool.untrusted!({}, r, ctx())).toEqual(["cloned from git (repo/a.md)", "cloned from git (repo/new.md)"]);
    localStorage.removeItem("lumen.agents.untrustedNotes");
  });

  it("diffs the index with staged=true, and narrows to paths", async () => {
    await gitDiffTool.run({}, ctx()); // mirrors the workspace into the checkout
    await isoGit.add({ fs, dir, filepath: "new.md" });
    const staged = await gitDiffTool.run({ repo: "repo", staged: true }, ctx());
    expect(staged.files.map((f) => f.path)).toEqual(["repo/new.md"]);
    const only = await gitDiffTool.run({ paths: ["repo/a.md"], maxChars: 200 }, ctx());
    expect(only.files.map((f) => f.path)).toEqual(["repo/a.md"]);
  });

  it("counts a rewrite too large to diff line by line, and says so (review: #205)", async () => {
    files.set("repo/a.md", Array.from({ length: 2100 }, (_, i) => `line ${i}`).join("\n") + "\n");
    const r = await gitDiffTool.run({ paths: ["repo/a.md"] }, ctx());
    expect(r.files).toEqual([{ path: "repo/a.md", state: "modified", binary: false, added: 2100, removed: 3, rewritten: true }]);
    expect(r.diff).toContain("[too many changes to show line by line: 3 → 2100 lines]");
  });

  it("shows a file deleted or renamed in the workspace (review: #205)", async () => {
    files.delete("repo/keep.md");
    files.delete("repo/a.md");
    files.set("repo/b.md", "one\n2\nthree\n"); // a.md renamed to b.md, with an edit
    const r = await gitDiffTool.run({}, ctx({ path: "repo/b.md" }));
    expect(r.files.map((f: { path: string; state: string }) => `${f.state} ${f.path}`).sort()).toEqual([
      "added repo/b.md",
      "added repo/new.md",
      "deleted repo/a.md",
      "deleted repo/keep.md",
    ]);
  });

  it("shows every file deleted when the repository's folder was emptied (review: #241)", async () => {
    await gitDiffTool.run({}, ctx()); // mirrors the workspace into the checkout
    for (const p of [...files.keys()]) if (p.startsWith("repo/")) files.delete(p);
    files.set("elsewhere.md", "other notes stay");
    const r = await gitDiffTool.run({ repo: "repo" }, ctx());
    expect(r.files.map((f: { path: string; state: string }) => `${f.state} ${f.path}`).sort()).toEqual(["deleted repo/a.md", "deleted repo/keep.md"]);
    // An entirely empty listing is not trusted: the checkout stays.
    files.clear();
    const empty = await gitDiffTool.run({ repo: "repo" }, ctx());
    expect(empty.files.map((f: { path: string; state: string }) => f.state)).not.toContain("added");
  });

  it("names the repositories when the one asked for does not exist, and stops when cancelled", async () => {
    await expect(gitDiffTool.run({ repo: "other" }, ctx())).rejects.toMatchObject({ code: "not-found", message: expect.stringContaining("repo") });
    const ctrl = new AbortController();
    const read = files.get.bind(files);
    // Cancel while the workspace is being mirrored into the checkout.
    vi.spyOn(files, "get").mockImplementation((k: string) => {
      ctrl.abort();
      return read(k);
    });
    await expect(gitDiffTool.run({}, ctx({ signal: ctrl.signal }))).rejects.toMatchObject({ name: "AbortError" });
    vi.restoreAllMocks();
  });
});

describe("line diff — end of file", () => {
  it("a change of only the final newline shows, with git's marker (review: #205)", () => {
    const d = unifiedDiff("a.md", "one\ntwo\n", "one\ntwo");
    expect(d).toContain("-two\n+two\n\\ No newline at end of file");
    expect(unifiedDiff("a.md", "one\ntwo", "one\ntwo\n")).toContain("-two\n\\ No newline at end of file\n+two");
    expect(unifiedDiff("a.md", "one\ntwo", "one\ntwo")).toBe("");
  });

  it("a change of only the line endings (LF ↔ CRLF) shows, with the CR as ^M (review: #205)", () => {
    expect(unifiedDiff("a.md", "one\ntwo\n", "one\r\ntwo\r\n")).toBe(["--- a/a.md", "+++ b/a.md", "@@ -1,2 +1,2 @@", "-one", "-two", "+one^M", "+two^M"].join("\n"));
    expect(fileDiff("a.md", "x\r\ny\r\n", "x\r\ny\n")).toMatchObject({ added: 1, removed: 1, rewritten: false });
    expect(unifiedDiff("a.md", "x\r\n", "x\r\n")).toBe("");
  });

  it("counts the lines of a change too large to diff line by line as a rewrite (review: #205)", () => {
    const before = Array.from({ length: 1500 }, (_, i) => `old ${i}`).join("\n") + "\n";
    const after = Array.from({ length: 1600 }, (_, i) => `new ${i}`).join("\n") + "\n";
    const d = fileDiff("big.md", before, after);
    expect(d).toMatchObject({ added: 1600, removed: 1500, rewritten: true });
    expect(d.text).toContain("@@ -1,1500 +1,1600 @@");
  });
});

describe("line diff", () => {
  it("produces an edit script that rebuilds both sides", () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2147483648) / 2147483648;
    for (let t = 0; t < 300; t++) {
      const a = Array.from({ length: Math.floor(rnd() * 25) }, () => "abcde"[Math.floor(rnd() * 5)]);
      const b = Array.from({ length: Math.floor(rnd() * 25) }, () => "abcde"[Math.floor(rnd() * 5)]);
      const ops = diffLines(a, b)!;
      expect(ops.filter((o) => o.op !== "add").map((o) => o.line)).toEqual(a);
      expect(ops.filter((o) => o.op !== "del").map((o) => o.line)).toEqual(b);
    }
  });

  it("formats unified hunks with context, and gives up past the edit budget", () => {
    const a = "a\nb\nc\nd\ne\nf\ng\nh\ni\nj\nk\n";
    const b = "a\nB\nc\nd\ne\nf\ng\nh\ni\nj\nK\nl\n";
    expect(unifiedDiff("x.md", a, b, 1)).toBe(
      ["--- a/x.md", "+++ b/x.md", "@@ -1,3 +1,3 @@", " a", "-b", "+B", " c", "@@ -10,2 +10,3 @@", " j", "-k", "+K", "+l"].join("\n"),
    );
    expect(unifiedDiff("x.md", a, a)).toBe("");
    expect(diffLines(["a", "b", "c"], ["x", "y", "z"], 2)).toBeNull();
  });
});

describe("set_frontmatter", () => {
  const doc = "---\n# keep this comment\ntitle: Old # inline\ntags: [a, b]\n---\n# Body\ntext\n";

  it("edits the open document's frontmatter with comments kept, as a staged range", async () => {
    const r = await setFrontmatterTool.run({ set: { title: "New", tags: ["a", "b", "c"], status: "draft" } }, ctx({ document: doc, path: "notes/x.md" }));
    expect(r).toMatchObject({ staged: true, kind: "range", path: "notes/x.md", frontmatter: { title: "New", tags: ["a", "b", "c"], status: "draft" } });
    const change = getStagedChange(r.changeId)!;
    expect(change).toMatchObject({ kind: "range", from: 0, status: "pending" });
    const next = applyRangeToText(doc, change as { from: number; to: number; before: string; after: string })!;
    expect(next).toContain("# keep this comment\ntitle: New # inline\n");
    expect(next).toMatch(/tags: \[ ?a, b, c ?\]/); // a flow list stays a flow list
    expect(next).toContain("status: draft\n---\n# Body\ntext\n");
    expect(files.size).toBe(0); // nothing written
  });

  it("creates, removes and refuses to rewrite broken YAML", () => {
    expect(updateFrontmatter("# Body\n", { title: "T" }).text).toBe("---\ntitle: T\n---\n# Body\n");
    expect(updateFrontmatter("---\ntitle: T\n---\n# Body\n", {}, ["title"]).text).toBe("# Body\n");
    expect(updateFrontmatter("---\r\na: 1\r\n---\r\nx", { b: 2 }).text).toBe("---\r\na: 1\r\nb: 2\r\n---\r\nx");
    expect(() => updateFrontmatter("---\na: [1,\n---\nx", { b: 1 })).toThrow(/not valid YAML/);
    expect(() => updateFrontmatter("---\n- a\n---\nx", { b: 1 })).toThrow(/key\/value map/);
  });

  it("stages a whole-file change for another workspace file", async () => {
    files.set("notes/other.md", "---\ntags: [x]\n---\nbody");
    const r = await setFrontmatterTool.run({ path: "notes/other.md", remove: ["tags"], set: { done: true } }, ctx({ document: doc, path: "notes/x.md" }));
    const change = getStagedChange(r.changeId)!;
    expect(change).toMatchObject({ kind: "file", path: "notes/other.md", before: "---\ntags: [x]\n---\nbody", after: "---\ndone: true\n---\nbody" });
    expect(files.get("notes/other.md")).toBe("---\ntags: [x]\n---\nbody");
    await expect(setFrontmatterTool.run({ path: "nope.md", set: { a: 1 } }, ctx())).rejects.toMatchObject({ code: "not-found" });
    await expect(setFrontmatterTool.run({}, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
  });
});

describe("replace_range", () => {
  const doc = "line1\nline2\r\nline3";

  it("stages a range by lines or offsets, checked against the expected text", async () => {
    expect(lineRange(doc, 2, 2)).toEqual({ from: 6, to: 11 });
    expect(lineRange(doc, 3, 3)).toEqual({ from: 13, to: 18 });
    const r = await replaceRangeTool.run({ startLine: 2, text: "LINE2", expected: "line2" }, ctx({ document: doc, path: "a.md" }));
    expect(r).toMatchObject({ staged: true, kind: "range", from: 6, to: 11 });
    expect(getStagedChange(r.changeId)).toMatchObject({ before: "line2", after: "LINE2", path: "a.md", status: "pending" });
    const ins = await replaceRangeTool.run({ from: 0, text: "# Title\n" }, ctx({ document: doc }));
    expect(getStagedChange(ins.changeId)).toMatchObject({ from: 0, to: 0, before: "" });
  });

  it("refuses wrong ranges, a mismatched expectation and a missing document", async () => {
    await expect(replaceRangeTool.run({ from: 0, to: 5, text: "X", expected: "nope" }, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
    await expect(replaceRangeTool.run({ from: 3, to: 999, text: "X" }, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
    await expect(replaceRangeTool.run({ startLine: 4, text: "X" }, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
    await expect(replaceRangeTool.run({ text: "X" }, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
    await expect(replaceRangeTool.run({ from: 0, to: 5, text: "line1" }, ctx({ document: doc }))).rejects.toMatchObject({ code: "bad-args" });
    await expect(replaceRangeTool.run({ from: 0, text: "X" }, ctx())).rejects.toMatchObject({ code: "failed" });
    expect(listStagedChanges()).toHaveLength(0);
  });
});

describe("the staged-change queue", () => {
  it("writes a file only on approval, and not over a newer version", async () => {
    files.set("a.md", "old");
    const seen: number[] = [];
    const off = onStagedChanges((l) => seen.push(l.length));
    const c = stageChange({ kind: "file", path: "a.md", before: "old", after: "new", summary: "s" }, { tool: "write_file", runId: "r1" });
    expect(files.get("a.md")).toBe("old");
    expect(listStagedChanges({ runId: "r1" }).map((x) => x.id)).toEqual([c.id]);
    expect((await approveStagedChange(c.id)).status).toBe("applied");
    expect(files.get("a.md")).toBe("new");
    await expect(approveStagedChange(c.id)).rejects.toThrow(/already applied/);

    const stale = stageChange({ kind: "file", path: "a.md", before: "old", after: "x", summary: "s" }, { tool: "write_file" });
    expect(await approveStagedChange(stale.id)).toMatchObject({ status: "conflict", error: expect.stringContaining("changed") });
    expect(files.get("a.md")).toBe("new");
    const created = stageChange({ kind: "file", path: "b.md", before: null, after: "b", summary: "s" }, { tool: "write_file" });
    files.set("b.md", "someone else");
    expect((await approveStagedChange(created.id)).status).toBe("conflict");
    off();
    expect(seen.length).toBeGreaterThan(3);
  });

  it("applies document ranges through the editor's applier, or to the saved file, relocating moved text", async () => {
    const applied: string[] = [];
    setDocumentApplier((ch) => (applied.push(ch.after), true));
    const c = stageChange({ kind: "range", path: "a.md", from: 0, to: 3, before: "abc", after: "ABC", summary: "s" }, { tool: "replace_range" });
    expect((await approveStagedChange(c.id)).status).toBe("applied");
    expect(applied).toEqual(["ABC"]);
    setDocumentApplier(null);

    files.set("a.md", "xx abc yy");
    const moved = stageChange({ kind: "range", path: "a.md", from: 0, to: 3, before: "abc", after: "ABC", summary: "s" }, { tool: "replace_range" });
    expect((await approveStagedChange(moved.id)).status).toBe("applied");
    expect(files.get("a.md")).toBe("xx ABC yy");
    expect(applyRangeToText("abc abc", { from: 9, to: 12, before: "abc", after: "X" })).toBeNull(); // ambiguous
    const unsaved = stageChange({ kind: "range", path: null, from: 0, to: 0, before: "", after: "x", summary: "s" }, { tool: "replace_range" });
    expect(await approveStagedChange(unsaved.id)).toMatchObject({ status: "conflict", error: expect.stringContaining("no editor") });
  });

  it("an insertion is located by its surroundings: shifted text is followed, a lost anchor is a conflict (review: #205)", () => {
    const doc = "# Title\n\nIntro paragraph.\n\nBody text here.\n";
    const at = doc.indexOf("Body");
    const change = { from: at, to: at, before: "", after: "NEW ", context: rangeContext(doc, at, at) };
    expect(applyRangeToText(doc, change)).toBe(doc.replace("Body", "NEW Body"));
    const shifted = "Added line.\n" + doc; // edited after the proposal: the offset is stale
    expect(applyRangeToText(shifted, change)).toBe(shifted.replace("Body", "NEW Body"));
    expect(applyRangeToText(doc.replace("Intro paragraph.", "Intro."), change)).toBeNull(); // the context changed: refuse
    expect(applyRangeToText(doc, { from: at, to: at, before: "", after: "x" })).toBeNull(); // no context, empty before: cannot locate
  });

  it("new frontmatter is refused when the document gained frontmatter meanwhile", () => {
    const doc = "Some text.\n";
    const r = updateFrontmatter(doc, { tags: ["a"] });
    const change = { ...r.block, context: rangeContext(doc, r.block.from, r.block.to) };
    expect(applyRangeToText(doc, change)).toBe(r.text);
    const meanwhile = "---\ntitle: T\n---\n" + doc;
    expect(applyRangeToText(meanwhile, change)).toBeNull(); // not a second frontmatter block
  });

  it("never drops a pending proposal at the cap: a new one is refused instead (review: #205)", () => {
    clearStagedChanges();
    for (let i = 0; i < 200; i++) stageChange({ kind: "file", path: `f${i}.md`, before: null, after: "x", summary: "s" }, { tool: "write_file" });
    expect(() => stageChange({ kind: "file", path: "over.md", before: null, after: "x", summary: "s" }, { tool: "write_file" })).toThrow(/waiting for review/);
    expect(listStagedChanges()).toHaveLength(200);
    rejectStagedChange(listStagedChanges()[0].id); // a settled entry may go
    const ok = stageChange({ kind: "file", path: "over.md", before: null, after: "x", summary: "s" }, { tool: "write_file" });
    expect(getStagedChange(ok.id)?.status).toBe("pending");
    expect(listStagedChanges()).toHaveLength(200);
    clearStagedChanges();
  });

  it("rejects, and withdraws a cancelled run's proposals", () => {
    const a = stageChange({ kind: "file", path: "a.md", before: null, after: "a", summary: "s" }, { tool: "write_file", runId: "r1" });
    const b = stageChange({ kind: "file", path: "b.md", before: null, after: "b", summary: "s" }, { tool: "write_file", runId: "r2" });
    expect(rejectStagedChange(b.id)?.status).toBe("rejected");
    expect(discardRunChanges("r1")).toBe(1);
    expect(getStagedChange(a.id)).toMatchObject({ status: "rejected", error: "the run was cancelled" });
    expect(listStagedChanges()).toHaveLength(0);
    expect(listStagedChanges({ all: true })).toHaveLength(2);
  });
});

describe("csv_parse", () => {
  it("types the columns of CSV, TSV and Markdown tables", async () => {
    const r = await csvParseTool.run({ text: "name,value,when\nA,1,2024-01-02\nB,2.5,2024-02-03\n" }, ctx());
    expect(r.columns).toEqual([
      { name: "name", type: "string", filled: 2 },
      { name: "value", type: "number", filled: 2, min: 1, max: 2.5 },
      { name: "when", type: "date", filled: 2 },
    ]);
    expect(r.rows).toEqual([
      ["A", 1, "2024-01-02"],
      ["B", 2.5, "2024-02-03"],
    ]);
    expect(r).toMatchObject({ rowCount: 2, truncated: false, delimiter: ",", format: "csv" });
    expect(parseTable("a\tb\n1\t2").delimiter).toBe("\t");
    const md = parseTable("| city | n |\n|---|:---:|\n| Haifa | 3 |\n| Eilat | 4 |");
    expect(md).toMatchObject({ format: "markdown-table", rows: [["Haifa", 3], ["Eilat", 4]] });
    // GFM's outer pipes are optional (review: #205).
    const bare = parseTable("Name | Count\n--- | ---:\nA | 1\nB \\| C | 2");
    expect(bare).toMatchObject({ format: "markdown-table", rowCount: 2, rows: [["A", 1], ["B | C", 2]] });
    expect(bare.columns).toEqual([
      { name: "Name", type: "string", filled: 2 },
      { name: "Count", type: "number", filled: 2, min: 1, max: 2 },
    ]);
    // Not a table: no delimiter row, or a rule without pipes.
    expect(parseTable("a | b\nc | d").format).toBe("csv");
    expect(parseTable("title\n---\ntext").format).toBe("csv");
    expect(parseTable("1,2\n3,4", { header: false, maxRows: 1 })).toMatchObject({ columns: [{ name: "c1" }, { name: "c2" }], rows: [[1, 2]], rowCount: 2, truncated: true });
  });

  it("reports the range of a numeric column of any length, and caps only the rows returned (review: #205)", () => {
    const text = "n\n" + Array.from({ length: 250_000 }, (_, i) => String(i - 1000)).join("\n");
    const r = parseTable(text, { maxRows: 3 });
    expect(r.columns).toEqual([{ name: "n", type: "number", filled: 250_000, min: -1000, max: 248_999 }]);
    expect(r).toMatchObject({ rowCount: 250_000, truncated: true, rows: [[-1000], [-999], [-998]] });
  });

  it("parses the selection by default", async () => {
    expect((await csvParseTool.run({}, ctx({ selection: "x,y\n1,2" }))).rows).toEqual([[1, 2]]);
    await expect(csvParseTool.run({}, ctx())).rejects.toMatchObject({ code: "bad-args" });
  });
});

describe("extract_quotes", () => {
  const page = "The Quick, brown fox — jumped over\nthe lazy dog. Alice never approved the plan.";

  it("returns exact quotes with their offsets, and rejects what is not in the source", () => {
    const [q1, q2, q3] = extractQuotes(["quick brown fox jumped", "Alice approved", "quick … lazy dog"], page);
    expect(q1).toEqual({ quote: "quick brown fox jumped", found: true, exact: "Quick, brown fox — jumped", start: 4, end: 29 });
    expect(page.slice(q1.start, q1.end)).toBe(q1.exact);
    expect(q2).toEqual({ quote: "Alice approved", found: false }); // a dropped word fails
    expect(q3).toMatchObject({ found: true, exact: "Quick, brown fox — jumped over\nthe lazy dog" });
    expect(locateQuote("שלום עולם", "אמר: שָׁלוֹם? לא. שלום, עולם!")).toEqual({ start: 18, end: 28 });
  });

  it("quotes the open document, a workspace file, or a page fetched in the run", async () => {
    const d = await extractQuotesTool.run({ quotes: ["lazy dog"] }, ctx({ document: page, path: "n.md" }));
    expect(d).toMatchObject({ source: "n.md", found: 1, quotes: [{ exact: "lazy dog", start: 39, end: 47 }] });
    files.set("lib/p.md", page);
    expect((await extractQuotesTool.run({ quotes: ["the plan"], path: "lib/p.md" }, ctx())).found).toBe(1);
    const pages = new Map([["https://e.com/a", { url: "https://e.com/a", finalUrl: "https://e.com/a", text: page }]]);
    expect((await extractQuotesTool.run({ quotes: ["brown fox"], url: "https://e.com/a" }, ctx({ pages }))).found).toBe(1);
    await expect(extractQuotesTool.run({ quotes: ["x"], url: "https://other.com" }, ctx({ pages }))).rejects.toMatchObject({ code: "not-found" });
  });
});

describe("network tools outside the runtime", () => {
  it("refuse to run without the gate's fetch", async () => {
    await expect(searchWebTool.run({ query: "x" }, ctx())).rejects.toMatchObject({ code: "denied" });
    await expect(fetchPageTool.run({ url: "https://e.com" }, ctx())).rejects.toMatchObject({ code: "denied" });
  });
});
