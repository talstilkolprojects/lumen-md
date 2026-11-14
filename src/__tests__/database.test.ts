/**
 * Tests for the database query engine. We mock the workspace adapter so the
 * full pipeline (frontmatter parse → filter → sort → group) can be exercised
 * without touching OPFS.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";
import {
  parseDatabaseSpec,
  groupRows,
  NO_VALUE,
  displayValue,
  resolveFields,
  runDatabaseQuery,
  type DatabaseRow,
} from "../views/database";

// Workspace mock — same pattern as cloudSync.test.ts.
vi.mock("../storage/workspace", () => {
  const files = new Map<string, string>();
  return {
    isOPFSAvailable: () => true,
    listWorkspace: async () => {
      return [...files.entries()].map(([path]) => ({
        path,
        name: path.split("/").pop() ?? path,
        size: 0,
        modified: 0,
      }));
    },
    readWorkspaceFile: async (p: string) => {
      const f = files.get(p);
      if (f === undefined) throw new Error(`missing ${p}`);
      return f;
    },
    writeWorkspaceFile: async () => {},
    isAssetName: () => false,
    __setFiles(initial: Record<string, string>) {
      files.clear();
      for (const [k, v] of Object.entries(initial)) files.set(k, v);
    },
  };
});

import * as workspaceMock from "../storage/workspace";

function withFm(meta: Record<string, unknown>, body = "Hi"): string {
  const yaml = Object.entries(meta)
    .map(([k, v]) => `${k}: ${typeof v === "string" ? JSON.stringify(v) : v}`)
    .join("\n");
  return `---\n${yaml}\n---\n\n${body}`;
}

beforeEach(() => {
  (workspaceMock as unknown as { __setFiles(d: Record<string, string>): void }).__setFiles({});
});

describe("parseDatabaseSpec", () => {
  it("returns null + error on empty input", () => {
    expect(parseDatabaseSpec("").error).toMatch(/empty/);
  });

  it("parses a minimal spec", () => {
    const r = parseDatabaseSpec("type: book\nview: kanban");
    expect(r.spec).toEqual({ type: "book", view: "kanban" });
  });

  it("rejects non-object YAML", () => {
    expect(parseDatabaseSpec("just a string").spec).toBeNull();
  });
});

describe("groupRows", () => {
  const rows: DatabaseRow[] = [
    { path: "a.md", basename: "a", fm: { status: "todo" } },
    { path: "b.md", basename: "b", fm: { status: "todo" } },
    { path: "c.md", basename: "c", fm: { status: "done" } },
    { path: "d.md", basename: "d", fm: {} },
  ];

  it("groups by the requested column", () => {
    const groups = groupRows(rows, "status");
    expect(groups.get("todo")).toHaveLength(2);
    expect(groups.get("done")).toHaveLength(1);
    expect(groups.get(NO_VALUE)).toHaveLength(1);
  });
});

describe("displayValue", () => {
  it("formats arrays as comma-separated", () => {
    expect(displayValue(["a", "b", "c"])).toBe("a, b, c");
  });
  it("returns empty string for null/undefined", () => {
    expect(displayValue(null)).toBe("");
    expect(displayValue(undefined)).toBe("");
  });
  it("formats Date as ISO date", () => {
    const d = new Date("2026-04-26T00:00:00Z");
    expect(displayValue(d)).toBe("2026-04-26");
  });
});

describe("resolveFields", () => {
  it("returns the explicit fields when provided", () => {
    const rows: DatabaseRow[] = [{ path: "a.md", basename: "a", fm: {} }];
    expect(resolveFields(rows, { fields: ["x", "y"] })).toEqual(["x", "y"]);
  });

  it("falls back to union of frontmatter keys, excluding type", () => {
    const rows: DatabaseRow[] = [
      { path: "a.md", basename: "a", fm: { type: "book", title: "A", author: "X" } },
      { path: "b.md", basename: "b", fm: { type: "book", rating: 5 } },
    ];
    const fields = resolveFields(rows, {});
    expect(fields).toContain("title");
    expect(fields).toContain("author");
    expect(fields).toContain("rating");
    expect(fields).not.toContain("type");
  });
});

describe("runDatabaseQuery", () => {
  const setFiles = (d: Record<string, string>) =>
    (workspaceMock as unknown as { __setFiles(d: Record<string, string>): void }).__setFiles(d);

  it("filters rows by frontmatter type", async () => {
    setFiles({
      "books/it-calvino.md": withFm({ type: "book", title: "Invisible Cities" }),
      "books/orwell.md": withFm({ type: "book", title: "1984" }),
      "movies/godfather.md": withFm({ type: "movie", title: "The Godfather" }),
      "scratch.md": "no frontmatter here",
    });
    const rows = await runDatabaseQuery({ type: "book" });
    expect(rows).toHaveLength(2);
    expect(rows.map((r) => r.basename).sort()).toEqual(["it-calvino", "orwell"]);
  });

  it("scopes by source folder", async () => {
    setFiles({
      "books/a.md": withFm({ type: "book", title: "A" }),
      "movies/b.md": withFm({ type: "book", title: "B" }),
    });
    const rows = await runDatabaseQuery({ type: "book", source: "books" });
    expect(rows).toHaveLength(1);
    expect(rows[0].basename).toBe("a");
  });

  it("sorts ascending by sortBy", async () => {
    setFiles({
      "a.md": withFm({ type: "book", rating: 3 }),
      "b.md": withFm({ type: "book", rating: 5 }),
      "c.md": withFm({ type: "book", rating: 1 }),
    });
    const rows = await runDatabaseQuery({ type: "book", sortBy: "rating" });
    expect(rows.map((r) => r.fm.rating)).toEqual([1, 3, 5]);
  });

  it("sorts descending with '-' prefix", async () => {
    setFiles({
      "a.md": withFm({ type: "book", rating: 3 }),
      "b.md": withFm({ type: "book", rating: 5 }),
      "c.md": withFm({ type: "book", rating: 1 }),
    });
    const rows = await runDatabaseQuery({ type: "book", sortBy: "-rating" });
    expect(rows.map((r) => r.fm.rating)).toEqual([5, 3, 1]);
  });

  it("returns empty when nothing matches", async () => {
    setFiles({ "a.md": withFm({ type: "movie" }) });
    expect(await runDatabaseQuery({ type: "book" })).toEqual([]);
  });
});
