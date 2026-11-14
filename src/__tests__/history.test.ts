/**
 * T35 — the one history store: dedupe, per-document cap, autosave
 * throttle, quota pruning, and the vault snapshot pass.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { IDBFactory } from "fake-indexeddb";
import * as history from "../storage/history";

const files = vi.hoisted(() => new Map<string, { content: string; modified: number }>());
vi.mock("../storage/workspace", async (orig) => ({
  ...(await orig<object>()),
  isOPFSAvailable: () => true,
  listWorkspace: vi.fn(async () => [...files.entries()].map(([path, f]) => ({ path, name: path, size: f.content.length, modified: f.modified, kind: "file" }))),
  readWorkspaceFile: vi.fn(async (p: string) => files.get(p)!.content),
}));
vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));

beforeEach(() => {
  globalThis.indexedDB = new IDBFactory();
  history.__resetHistoryDb();
  files.clear();
});

describe("history store", () => {
  it("records, lists newest first, and skips identical content", async () => {
    expect(await history.recordSnapshot("a.md", "one", "save", 1000)).toBe(true);
    expect(await history.recordSnapshot("a.md", "one", "save", 2000)).toBe(false);
    expect(await history.recordSnapshot("a.md", "two", "save", 3000)).toBe(true);
    const list = await history.listSnapshots("a.md");
    expect(list.map((s) => [s.content, s.reason])).toEqual([["two", "save"], ["one", "save"]]);
    expect(await history.listSnapshots("b.md")).toEqual([]);
  });

  it("throttles autosave snapshots but never explicit saves", async () => {
    const t0 = 10_000_000;
    expect(await history.recordSnapshot("a.md", "v1", "autosave", t0)).toBe(true);
    expect(await history.recordSnapshot("a.md", "v2", "autosave", t0 + 30_000)).toBe(false);
    expect(await history.recordSnapshot("a.md", "v3", "save", t0 + 31_000)).toBe(true);
    expect(await history.recordSnapshot("a.md", "v4", "autosave", t0 + history.AUTOSAVE_EVERY_MS + 1)).toBe(true);
    expect((await history.listSnapshots("a.md")).map((s) => s.content)).toEqual(["v4", "v3", "v1"]);
  });

  it("keeps each document's newest MAX_PER_DOC snapshots", async () => {
    // The real cap is 1000; a small one keeps the test fast (it must not
    // still be writing when the next test starts).
    const cap = 100;
    history.__setMaxPerDoc(cap);
    for (let i = 0; i < cap + 5; i++) await history.recordSnapshot("a.md", `v${i}`, "save", i);
    const list = await history.listSnapshots("a.md");
    expect(list).toHaveLength(cap);
    expect(list[0].content).toBe(`v${cap + 4}`);
    expect(list.at(-1)!.content).toBe("v5");
  });

  it("prunes the oldest snapshots but keeps every document's newest", async () => {
    for (let i = 0; i < 8; i++) await history.recordSnapshot("a.md", `a${i}`, "save", i);
    await history.recordSnapshot("b.md", "b0", "save", 0);
    const removed = await history.pruneOldest(0.5);
    expect(removed).toBeGreaterThan(0);
    expect((await history.listSnapshots("b.md")).map((s) => s.content)).toEqual(["b0"]);
    expect((await history.listSnapshots("a.md"))[0].content).toBe("a7");
  });

  it("names the document by workspace path, else display name", () => {
    expect(history.historyKey({ name: "x.md", workspaceName: "f/x.md" })).toBe("f/x.md");
    expect(history.historyKey({ name: "Untitled.md", workspaceName: null })).toBe("Untitled.md");
  });

  it("recognises quota errors", () => {
    expect(history.isQuotaError(new DOMException("full", "QuotaExceededError"))).toBe(true);
    expect(history.isQuotaError(new Error("x"))).toBe(false);
  });
});

describe("vault snapshots", () => {
  it("snapshots every changed note once, and again only after it changes", async () => {
    files.set("a.md", { content: "A", modified: 1 });
    files.set("b.md", { content: "B", modified: 1 });
    const { snapshotVault } = await import("../sync/autoBackup");
    expect(await snapshotVault()).toBe(2);
    expect(await snapshotVault()).toBe(0);
    files.set("a.md", { content: "A2", modified: 2 });
    expect(await snapshotVault()).toBe(1);
    expect((await history.listSnapshots("a.md")).map((s) => [s.content, s.reason])).toEqual([["A2", "vault"], ["A", "vault"]]);
  });
});
