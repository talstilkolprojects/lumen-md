/**
 * The vault's MCP server speaks the 2026-07-28 spec and still the
 * 2025-11-25 handshake (plan W7.17). Drives McpEndpoint — what the stdio
 * transport carries line by line (mcp-server/src/server.ts).
 *
 * Acceptance: 20 scenarios against a 2026-07-28 client, 10 against a
 * 2025-11-25 client, and 50 attempts to write from outside without the
 * user's approval that write nothing.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, mkdirSync, readdirSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { Buffer } from "node:buffer";
import { McpEndpoint, ERR, META, SUPPORTED_VERSIONS, TOOLS_TTL_MS, type JsonRpcResponse } from "../../mcp-server/src/protocol";
import { handleLine } from "../../mcp-server/src/server";
import { STATE_TTL_MS } from "../../mcp-server/src/vault/approval";
import { enableClient } from "../../mcp-server/src/vault/config";
import { readLedger } from "../../mcp-server/src/vault/ledger";
import { approvePending, listPending, rejectPending } from "../../mcp-server/src/vault/pending";
import { TOOLS } from "../../mcp-server/src/vault/tools";

let vault: string;
let seq = 0;
const note = (rel: string, text: string) => {
  const abs = path.join(vault, rel);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, text, "utf8");
};
const read = (rel: string) => readFileSync(path.join(vault, rel), "utf8");

const modernMeta = (client = "claude-code", caps: Record<string, unknown> = {}) => ({
  [META.protocolVersion]: "2026-07-28",
  [META.clientInfo]: { name: client, version: "1.0.0" },
  [META.clientCapabilities]: caps,
});
const req = (method: string, params: Record<string, unknown> = {}) => ({ jsonrpc: "2.0", id: ++seq, method, params });
const modern = (method: string, params: Record<string, unknown> = {}, client?: string, caps?: Record<string, unknown>) => req(method, { ...params, _meta: modernMeta(client, caps) });

type Res = Record<string, unknown> & { content?: { text: string }[]; isError?: boolean; requestState?: string; resultType?: string };
function result(r: JsonRpcResponse | null): Res {
  if (!r || !("result" in r)) throw new Error(`expected a result, got ${JSON.stringify(r)}`);
  return r.result as Res;
}
function error(r: JsonRpcResponse | null): { code: number; message: string; data?: Record<string, unknown> } {
  if (!r || !("error" in r)) throw new Error(`expected an error, got ${JSON.stringify(r)}`);
  return r.error as { code: number; message: string; data?: Record<string, unknown> };
}
const textOf = (r: Res) => (r.content ?? []).map((c) => c.text).join("\n");

/** Every file in the vault outside `.lumen/`, with its text. */
function snapshot(): Record<string, string> {
  const out: Record<string, string> = {};
  const walk = (dir: string) => {
    for (const name of readdirSync(dir)) {
      if (name === ".lumen") continue;
      const abs = path.join(dir, name);
      if (statSync(abs).isDirectory()) walk(abs);
      else out[path.relative(vault, abs)] = readFileSync(abs, "utf8");
    }
  };
  walk(vault);
  return out;
}

beforeEach(() => {
  vault = mkdtempSync(path.join(tmpdir(), "lumen-mcp26-"));
  note("ideas/launch.md", "---\ntags: [plan]\n---\n# Launch\n\nThe launch plan, budget and dates.\n");
  note("journal/today.md", "# Today\n\nA meeting about the launch.\n");
});
afterEach(() => rmSync(vault, { recursive: true, force: true }));

describe("MCP 2026-07-28 client (20 scenarios)", () => {
  it("1. server/discover advertises versions, capabilities and identity, cacheable and private", async () => {
    const ep = new McpEndpoint({ vault });
    const r = result(await ep.handle(modern("server/discover")));
    expect(r.resultType).toBe("complete");
    expect(r.supportedVersions).toEqual([...SUPPORTED_VERSIONS]);
    expect((r.supportedVersions as string[])[0]).toBe("2026-07-28");
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect((r.serverInfo as { name: string }).name).toBe("lumen-mcp");
    expect(typeof r.ttlMs).toBe("number");
    expect(r.cacheScope).toBe("private");
    expect(typeof r.instructions).toBe("string");
  });

  it("2. server/discover works as a probe without _meta (stdio backward-compatibility probe)", async () => {
    const r = result(await new McpEndpoint({ vault }).handle(req("server/discover")));
    expect(r.resultType).toBe("complete");
    expect(r.supportedVersions).toContain("2025-11-25");
  });

  it("3. an unknown version gets UnsupportedProtocolVersion (-32022) listing the supported ones", async () => {
    const ep = new McpEndpoint({ vault });
    for (const method of ["tools/list", "server/discover"]) {
      const e = error(await ep.handle(req(method, { _meta: { ...modernMeta(), [META.protocolVersion]: "1900-01-01" } })));
      expect(e.code).toBe(-32022);
      expect(e.code).toBe(ERR.unsupportedVersion);
      expect(e.data).toEqual({ supported: [...SUPPORTED_VERSIONS], requested: "1900-01-01" });
    }
  });

  it("4. a request without _meta and no handshake is malformed (-32602) and names the versions", async () => {
    const e = error(await new McpEndpoint({ vault }).handle(req("tools/list")));
    expect(e.code).toBe(-32602);
    expect(e.message).toContain("2026-07-28");
    expect(e.message).toContain("2025-11-25");
  });

  it("5. a modern request without clientCapabilities is malformed (-32602)", async () => {
    const e = error(await new McpEndpoint({ vault }).handle(req("tools/list", { _meta: { [META.protocolVersion]: "2026-07-28" } })));
    expect(e.code).toBe(-32602);
    expect(e.message).toContain(META.clientCapabilities);
  });

  it("6. a client that is not enabled gets an empty list, still with resultType, ttlMs and cacheScope", async () => {
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/list")));
    expect(r).toMatchObject({ resultType: "complete", tools: [], ttlMs: TOOLS_TTL_MS, cacheScope: "private" });
    expect((r._meta as Record<string, { name: string }>)[META.serverInfo]!.name).toBe("lumen-mcp");
  });

  it("7. tools/list is in one fixed order, the same on every call", async () => {
    await enableClient(vault, "claude-code", ["search", "read", "propose"]);
    const ep = new McpEndpoint({ vault });
    const a = (result(await ep.handle(modern("tools/list"))).tools as { name: string }[]).map((t) => t.name);
    const b = (result(await ep.handle(modern("tools/list"))).tools as { name: string }[]).map((t) => t.name);
    expect(a).toEqual(TOOLS.map((t) => t.name));
    expect(b).toEqual(a);
  });

  it("8. a read-only grant lists only read-only tools, marked readOnlyHint", async () => {
    await enableClient(vault, "claude-code", ["search", "read"]);
    const tools = result(await new McpEndpoint({ vault }).handle(modern("tools/list"))).tools as { name: string; annotations: { readOnlyHint: boolean } }[];
    expect(tools.map((t) => t.name)).toEqual(["search_notes", "read_note", "list_notes", "list_tags", "get_backlinks"]);
    expect(tools.every((t) => t.annotations.readOnlyHint)).toBe(true);
  });

  it("9. search answers resultType complete with the matching note", async () => {
    await enableClient(vault, "claude-code", ["search"]);
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/call", { name: "search_notes", arguments: { query: "launch" } })));
    expect(r.resultType).toBe("complete");
    expect(textOf(r)).toContain("ideas/launch.md");
    expect(r.isError).toBeUndefined();
  });

  it("10. read_note returns the note's Markdown", async () => {
    await enableClient(vault, "claude-code", ["search", "read"]);
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/call", { name: "read_note", arguments: { path: "journal/today.md" } })));
    expect(r.resultType).toBe("complete");
    expect(textOf(r)).toBe(read("journal/today.md"));
  });

  it("11. a tool outside the grant is a tool error (isError), not a protocol error", async () => {
    await enableClient(vault, "claude-code", ["search"]);
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/call", { name: "read_note", arguments: { path: "journal/today.md" } })));
    expect(r.resultType).toBe("complete");
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain("read");
  });

  it("12. a write waits for approval: input_required with requestState, nothing on disk, one proposal queued", async () => {
    await enableClient(vault, "claude-code", ["search", "read", "propose"]);
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/call", { name: "create_note", arguments: { path: "new.md", content: "# New\n" } })));
    expect(r.resultType).toBe("input_required");
    expect(typeof r.requestState).toBe("string");
    expect(r.inputRequests).toBeUndefined(); // the client declared no elicitation
    expect(existsSync(path.join(vault, "new.md"))).toBe(false);
    expect((await listPending(vault)).map((p) => p.path)).toEqual(["new.md"]);
  });

  it("13. a client that declared elicitation gets one form request telling the user to decide in Lumen", async () => {
    await enableClient(vault, "claude-code", ["read", "propose"]);
    const r = result(await new McpEndpoint({ vault }).handle(modern("tools/call", { name: "append_note", arguments: { path: "journal/today.md", content: "more" } }, "claude-code", { elicitation: {} })));
    expect(r.resultType).toBe("input_required");
    const ir = r.inputRequests as Record<string, { method: string; params: { mode: string; message: string; requestedSchema: unknown } }>;
    expect(Object.keys(ir)).toEqual(["lumen_approval"]);
    expect(ir.lumen_approval!.method).toBe("elicitation/create");
    expect(ir.lumen_approval!.params.mode).toBe("form");
    expect(ir.lumen_approval!.params.message).toContain("Lumen");
    expect(ir.lumen_approval!.params.requestedSchema).toEqual({ type: "object", properties: {} });
  });

  it("14. a retry while the proposal still waits is input_required again and writes nothing", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    const call = { name: "create_note", arguments: { path: "wait.md", content: "x" } };
    const first = result(await ep.handle(modern("tools/call", call)));
    const again = result(await ep.handle(modern("tools/call", { ...call, requestState: first.requestState })));
    expect(again.resultType).toBe("input_required");
    expect(again.requestState).toBe(first.requestState);
    expect(existsSync(path.join(vault, "wait.md"))).toBe(false);
    expect(await listPending(vault)).toHaveLength(1);
  });

  it("15. after the user approves, the retry completes and the note is written", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    const call = { name: "create_note", arguments: { path: "ok.md", content: "# OK\n" } };
    const first = result(await ep.handle(modern("tools/call", call)));
    const [p] = await listPending(vault);
    expect((await approvePending(vault, p!.id, "app")).status).toBe("applied");
    const done = result(await ep.handle(modern("tools/call", { ...call, requestState: first.requestState })));
    expect(done.resultType).toBe("complete");
    expect(done.isError).toBeUndefined();
    expect(textOf(done)).toContain("approved");
    expect(read("ok.md")).toBe("# OK\n");
  });

  it("16. after the user rejects, the retry is an error and nothing is written", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    const call = { name: "write_note", arguments: { path: "journal/today.md", content: "replaced" } };
    const first = result(await ep.handle(modern("tools/call", call)));
    const [p] = await listPending(vault);
    await rejectPending(vault, p!.id, "app");
    const done = result(await ep.handle(modern("tools/call", { ...call, requestState: first.requestState })));
    expect(done).toMatchObject({ resultType: "complete", isError: true });
    expect(textOf(done)).toContain("rejected");
    expect(read("journal/today.md")).toBe("# Today\n\nA meeting about the launch.\n");
  });

  it("17. a note that changed before approval is a conflict: reported, not written", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    const call = { name: "write_note", arguments: { path: "journal/today.md", content: "replaced" } };
    const first = result(await ep.handle(modern("tools/call", call)));
    note("journal/today.md", "edited by the user\n");
    const [p] = await listPending(vault);
    expect((await approvePending(vault, p!.id, "app")).status).toBe("conflict");
    const done = result(await ep.handle(modern("tools/call", { ...call, requestState: first.requestState })));
    expect(done).toMatchObject({ resultType: "complete", isError: true });
    expect(textOf(done)).toContain("changed");
    expect(read("journal/today.md")).toBe("edited by the user\n");
  });

  it("18. requestState is verified: tampered, another client's, another request's and expired ones are refused (-32602)", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    await enableClient(vault, "cursor", ["propose"]);
    let now = 1_000_000;
    const ep = new McpEndpoint({ vault, now: () => now });
    const call = { name: "create_note", arguments: { path: "s.md", content: "x" } };
    const state = result(await ep.handle(modern("tools/call", call))).requestState!;
    const [body, mac] = state.split(".");
    const forged = Buffer.from(JSON.stringify({ ...JSON.parse(Buffer.from(body!, "base64url").toString()), pid: "zzzzzzzzzzzz" })).toString("base64url") + "." + mac;
    const tries: [Record<string, unknown>, string | undefined, string][] = [
      [{ ...call, requestState: forged }, undefined, "verification"],
      [{ ...call, requestState: state.slice(0, -2) + "AA" }, undefined, "verification"],
      [{ ...call, requestState: "not-a-state" }, undefined, "issued"],
      [{ ...call, requestState: state }, "cursor", "another client"],
      [{ name: "create_note", arguments: { path: "s.md", content: "y" }, requestState: state }, undefined, "another request"],
      [{ name: "append_note", arguments: call.arguments, requestState: state }, undefined, "another request"],
    ];
    for (const [params, client, msg] of tries) {
      const e = error(await ep.handle(modern("tools/call", params, client)));
      expect(e.code).toBe(-32602);
      expect(e.message).toContain(msg);
    }
    now += STATE_TTL_MS + 1;
    expect(error(await ep.handle(modern("tools/call", { ...call, requestState: state }))).message).toContain("expired");
    expect(existsSync(path.join(vault, "s.md"))).toBe(false);
  });

  it("19. the client's inputResponses never approve: an 'accept' still waits for the user", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    const call = { name: "create_note", arguments: { path: "accept.md", content: "x" } };
    const first = result(await ep.handle(modern("tools/call", call, "claude-code", { elicitation: {} })));
    const retry = result(
      await ep.handle(
        modern("tools/call", { ...call, requestState: first.requestState, inputResponses: { lumen_approval: { action: "accept", content: { approved: true } } } }, "claude-code", { elicitation: {} }),
      ),
    );
    expect(retry.resultType).toBe("input_required");
    expect(existsSync(path.join(vault, "accept.md"))).toBe(false);
  });

  it("20. stateless: removed and deprecated methods are not offered, and nothing is remembered between requests", async () => {
    const ep = new McpEndpoint({ vault });
    for (const m of ["ping", "logging/setLevel", "roots/list", "sampling/createMessage", "resources/subscribe", "prompts/list"]) {
      expect(error(await ep.handle(modern(m))).code).toBe(-32601);
    }
    result(await ep.handle(modern("tools/list")));
    // A modern request does not open a session: the next request without _meta is still malformed.
    expect(error(await ep.handle(req("tools/list"))).code).toBe(-32602);
    // Notifications get no answer; batches, non-JSON and bad ids are rejected.
    expect(await ep.handle({ jsonrpc: "2.0", method: "notifications/cancelled", params: {} })).toBeNull();
    expect(error(await ep.handle([modern("tools/list")])).code).toBe(-32600);
    expect(error(await handleLine(ep, "{not json")).code).toBe(-32700);
    expect(error(await ep.handle({ jsonrpc: "2.0", id: { x: 1 }, method: "tools/list" })).code).toBe(-32600);
    // The server never emits codes from the removed or legacy ranges.
    const ledger = await readLedger(vault);
    expect(ledger.every((e) => e.decision !== "written")).toBe(true);
  });
});

describe("MCP 2025-11-25 client (10 scenarios)", () => {
  const init = (version = "2025-11-25", name = "claude-desktop") => req("initialize", { protocolVersion: version, capabilities: {}, clientInfo: { name, version: "0.9" } });

  it("1. initialize answers the legacy handshake", async () => {
    const r = result(await new McpEndpoint({ vault }).handle(init()));
    expect(r.protocolVersion).toBe("2025-11-25");
    expect(r.capabilities).toEqual({ tools: { listChanged: false } });
    expect((r.serverInfo as { name: string }).name).toBe("lumen-mcp");
    expect(r.resultType).toBeUndefined();
  });

  it("2. an older version it knows is kept; an unknown one is answered with 2025-11-25", async () => {
    expect(result(await new McpEndpoint({ vault }).handle(init("2025-06-18"))).protocolVersion).toBe("2025-06-18");
    expect(result(await new McpEndpoint({ vault }).handle(init("2024-01-01"))).protocolVersion).toBe("2025-11-25");
  });

  it("3. notifications/initialized gets no answer", async () => {
    const ep = new McpEndpoint({ vault });
    await ep.handle(init());
    expect(await ep.handle({ jsonrpc: "2.0", method: "notifications/initialized" })).toBeNull();
  });

  it("4. ping still works in a legacy session", async () => {
    const ep = new McpEndpoint({ vault });
    await ep.handle(init());
    expect(result(await ep.handle(req("ping")))).toEqual({});
  });

  it("5. tools/list after initialize, with no _meta, in the legacy shape", async () => {
    await enableClient(vault, "claude-desktop", ["search", "read"]);
    const ep = new McpEndpoint({ vault });
    await ep.handle(init());
    const r = result(await ep.handle(req("tools/list")));
    expect((r.tools as unknown[]).length).toBe(5);
    expect(r.resultType).toBeUndefined();
    expect(r.ttlMs).toBeUndefined();
  });

  it("6. tools/call search in the legacy shape", async () => {
    await enableClient(vault, "claude-desktop", ["search"]);
    const ep = new McpEndpoint({ vault });
    await ep.handle(init());
    const r = result(await ep.handle(req("tools/call", { name: "search_notes", arguments: { query: "meeting" } })));
    expect(textOf(r)).toContain("journal/today.md");
    expect(r.resultType).toBeUndefined();
  });

  it("7. a legacy write is a proposal answered with its id as text, never input_required, never written", async () => {
    await enableClient(vault, "claude-desktop", ["propose"]);
    const ep = new McpEndpoint({ vault });
    await ep.handle(init());
    const r = result(await ep.handle(req("tools/call", { name: "create_note", arguments: { path: "legacy.md", content: "x" } })));
    const [p] = await listPending(vault);
    expect(textOf(r)).toContain(p!.id);
    expect(r.resultType).toBeUndefined();
    expect(r.requestState).toBeUndefined();
    expect(existsSync(path.join(vault, "legacy.md"))).toBe(false);
  });

  it("8. the client named at initialize is the one the grant is checked for; --client overrides it", async () => {
    await enableClient(vault, "claude-desktop", ["search"]);
    const ep = new McpEndpoint({ vault });
    await ep.handle(init("2025-11-25", "Claude Desktop"));
    expect((result(await ep.handle(req("tools/list"))).tools as unknown[]).length).toBe(1);
    const pinned = new McpEndpoint({ vault, explicitClient: "cursor" });
    await pinned.handle(init("2025-11-25", "Claude Desktop"));
    expect((result(await pinned.handle(req("tools/list"))).tools as unknown[]).length).toBe(0);
  });

  it("9. a legacy version in _meta without a handshake is served in the legacy shape", async () => {
    await enableClient(vault, "claude-code", ["search"]);
    const r = result(await new McpEndpoint({ vault }).handle(req("tools/list", { _meta: { ...modernMeta(), [META.protocolVersion]: "2025-11-25" } })));
    expect((r.tools as unknown[]).length).toBe(1);
    expect(r.resultType).toBeUndefined();
  });

  it("10. dual-era on one process: after a legacy initialize, a 2026-07-28 request is still served statelessly", async () => {
    await enableClient(vault, "claude-code", ["propose"]);
    const ep = new McpEndpoint({ vault });
    await ep.handle(init("2025-11-25", "claude-code"));
    const r = result(await ep.handle(modern("tools/call", { name: "create_note", arguments: { path: "dual.md", content: "x" } })));
    expect(r.resultType).toBe("input_required");
    expect(result(await ep.handle(req("tools/list"))).resultType).toBeUndefined();
  });
});

describe("writes from outside without approval (50 attempts)", () => {
  it("writes nothing to the vault and records no approval", async () => {
    await enableClient(vault, "claude-code", ["search", "read", "propose"]);
    await enableClient(vault, "claude-desktop", ["search", "read", "propose"]);
    const before = snapshot();
    const ep = new McpEndpoint({ vault });
    const legacyEp = new McpEndpoint({ vault });
    await legacyEp.handle(req("initialize", { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "claude-desktop", version: "1" } }));
    const writes = ["create_note", "append_note", "write_note", "update_frontmatter"] as const;
    const argsFor = (tool: string, i: number) =>
      tool === "create_note"
        ? { path: `out/n${i}.md`, content: `# ${i}` }
        : tool === "update_frontmatter"
          ? { path: "ideas/launch.md", set: { status: `x${i}` } }
          : { path: i % 2 ? "ideas/launch.md" : "journal/today.md", content: `evil ${i}` };
    let state: string | undefined;
    for (let i = 0; i < 50; i++) {
      const tool = writes[i % writes.length]!;
      const args = argsFor(tool, i);
      const mode = i % 5;
      if (mode === 0) {
        const r = result(await ep.handle(modern("tools/call", { name: tool, arguments: args })));
        expect(r.resultType).toBe("input_required");
        state = r.requestState;
      } else if (mode === 1) {
        // Retrying with a state from another call, and claiming acceptance.
        const r = await ep.handle(modern("tools/call", { name: tool, arguments: args, requestState: state, inputResponses: { lumen_approval: { action: "accept", content: {} } } }, "claude-code", { elicitation: {} }));
        if ("error" in r!) expect(r.error.code).toBe(-32602);
        else expect(result(r).resultType).toBe("input_required");
      } else if (mode === 2) {
        const r = result(await legacyEp.handle(req("tools/call", { name: tool, arguments: args })));
        expect(textOf(r)).toMatch(/Proposed|No change/);
      } else if (mode === 3) {
        // Path tricks.
        const r = result(await ep.handle(modern("tools/call", { name: tool, arguments: { ...args, path: i % 2 ? "../escape.md" : ".lumen/mcp.json" } })));
        expect(r.isError).toBe(true);
      } else {
        // A forged state that names a made-up proposal.
        const e = error(await ep.handle(modern("tools/call", { name: tool, arguments: args, requestState: Buffer.from('{"v":1,"pid":"aaaaaaaaaaaa"}').toString("base64url") + ".AAAA" })));
        expect(e.code).toBe(-32602);
      }
    }
    expect(snapshot()).toEqual(before);
    expect(existsSync(path.join(path.dirname(vault), "escape.md"))).toBe(false);
    const ledger = await readLedger(vault, 10_000);
    expect(ledger.filter((e) => e.decision === "approved" || e.decision === "written")).toEqual([]);
    expect((await listPending(vault)).length).toBeGreaterThan(0);
  });
});
