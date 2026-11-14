/**
 * Plan W2.3, the app side: proposals from MCP clients
 * (`.lumen/mcp/pending/*.json`) are staged for the review panel; nothing
 * is written before approval; decisions go to the ledger and the queue
 * file is removed.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createMcpInbox, isSafeNotePath, parseProposal, MCP_LEDGER, MCP_PENDING_DIR, type InboxWorkspace } from "../agents/mcpInbox";
import { approveStagedChange, clearStagedChanges, listStagedChanges, rejectStagedChange } from "../agents/staging";

function fakeWorkspace(files: Record<string, string>): InboxWorkspace & { files: Map<string, string> } {
  const map = new Map(Object.entries(files));
  return {
    files: map,
    async listWorkspaceFolder(dir) {
      return [...map.keys()].filter((k) => k.startsWith(dir + "/") && !k.slice(dir.length + 1).includes("/")).map((k) => k.slice(dir.length + 1)).sort();
    },
    async readWorkspaceFile(p) {
      const v = map.get(p);
      if (v === undefined) throw new Error("missing " + p);
      return v;
    },
    async writeWorkspaceFile(p, c) {
      map.set(p, c);
    },
    async deleteWorkspaceFile(p) {
      if (!map.delete(p)) throw new Error("missing " + p);
    },
    async workspaceHasFile(p) {
      return map.has(p);
    },
  };
}

const prop = (id: string, path: string, before: string | null, after: string) =>
  JSON.stringify({ id, client: "claude-code", tool: before === null ? "create_note" : "append_note", path, before, after, createdAt: "2026-11-10T09:00:00.000Z" });

let stop: (() => void) | undefined;
beforeEach(() => clearStagedChanges());
afterEach(() => {
  stop?.();
  clearStagedChanges();
});

describe("mcpInbox", () => {
  it("validates proposals: id matches the file, safe note paths only", () => {
    expect(parseProposal("abc123.json", prop("abc123", "a/b.md", null, "x"))?.path).toBe("a/b.md");
    expect(parseProposal("other1.json", prop("abc123", "a/b.md", null, "x"))).toBeNull();
    for (const bad of ["../x.md", "/abs.md", ".lumen/mcp.json", "a/.hidden/x.md", "a\\b.md", "x.js", ""]) expect(isSafeNotePath(bad), bad).toBe(false);
    expect(parseProposal("abc123.json", "{not json")).toBeNull();
  });

  it("stages each proposal once, writes only on approval, settles queue and ledger", async () => {
    const ws = fakeWorkspace({
      "notes/a.md": "A\n",
      [`${MCP_PENDING_DIR}/aaaaaa1.json`]: prop("aaaaaa1", "notes/a.md", "A\n", "A\nmore\n"),
      [`${MCP_PENDING_DIR}/bbbbbb2.json`]: prop("bbbbbb2", "new.md", null, "# New\n"),
    });
    const inbox = createMcpInbox(ws, { intervalMs: 60_000, now: () => new Date("2026-11-10T10:00:00Z") });
    stop = inbox.stop;
    expect(await inbox.sync()).toBe(2);
    expect(await inbox.sync()).toBe(0);
    const staged = listStagedChanges();
    expect(staged.map((c) => c.agentId)).toEqual(["mcp:claude-code", "mcp:claude-code"]);
    expect(ws.files.get("notes/a.md")).toBe("A\n");
    expect(ws.files.has("new.md")).toBe(false);

    const [append, create] = staged;
    rejectStagedChange(append.id);
    await approveStagedChange(create.id);
    // The fake workspace is not the app's: approving a file change goes through storage/workspace,
    // so here only the settlement (queue + ledger) is checked; the write itself is the e2e's.
    await vi.waitFor(() => expect(ws.files.has(`${MCP_PENDING_DIR}/aaaaaa1.json`)).toBe(false));
    await vi.waitFor(() => expect((ws.files.get(MCP_LEDGER) ?? "").trim().split("\n").filter(Boolean).length).toBe(2));
    const lines = (ws.files.get(MCP_LEDGER) ?? "").trim().split("\n").map((l) => JSON.parse(l) as { decision: string; id: string; bytesOut: number });
    expect(lines.find((l) => l.id === "aaaaaa1")?.decision).toBe("rejected");
    expect(["approved", "conflict"]).toContain(lines.find((l) => l.id === "bbbbbb2")?.decision);
    expect(ws.files.get("notes/a.md")).toBe("A\n");
    expect(await inbox.sync()).toBe(0);
  });
});
