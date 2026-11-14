/**
 * Plan W4.31 — tool calls from small local models: the slips they make are
 * repaired without inventing values, an invalid call gets one retry with
 * the schema error, a second one asks the user, and repair never lets a
 * call past the runtime's grants (0 unapproved writes).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDefinition, AgentTool, Executor, ExecutorRequest, ExecutorResponse } from "../agents/types";
import { defineTool } from "../agents/tools/define";

vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => ({ aiKey: null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null }) } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));

import { callErrors, lenientJson, repairArgs, repairCall, resolveToolName, retryMessage, unwrapTurn } from "../agents/toolRepair";
import { parseProtocolTurn } from "../agents/protocol";
import { runAgent } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";

const search = defineTool<{ query: string; limit?: number; tags?: string[]; exact?: boolean }, { hits: string[] }>({
  name: "search_notes",
  description: "search the vault",
  parameters: {
    type: "object",
    properties: { query: { type: "string" }, limit: { type: "integer", minimum: 1, maximum: 50 }, tags: { type: "array", items: { type: "string" } }, exact: { type: "boolean" } },
    required: ["query"],
    additionalProperties: false,
  },
  run: async (a) => ({ hits: [`${a.query}:${a.limit ?? 10}`] }),
});
const writer = defineTool<{ path: string; content: string }, { ok: true }>({
  name: "write_file",
  description: "writes",
  parameters: { type: "object", properties: { path: { type: "string" }, content: { type: "string" } }, required: ["path", "content"] },
  scope: "write",
  run: async () => ({ ok: true }),
});
const tools = [search, writer] as AgentTool[];

describe("lenient JSON", () => {
  it("accepts trailing commas, Python literals, smart and single quotes — but not inside strings", () => {
    expect(lenientJson('{"a": [1, 2,], "b": True, "c": None,}')).toEqual({ a: [1, 2], b: true, c: null });
    expect(lenientJson("{'tool': 'search_notes'}")).toEqual({ tool: "search_notes" });
    expect(lenientJson("{“tool”: “search_notes”}")).toEqual({ tool: "search_notes" });
    expect(lenientJson('{"q": "True, None,]"}')).toEqual({ q: "True, None,]" });
    expect(lenientJson("not json")).toBeUndefined();
  });
});

describe("the call's shape", () => {
  it("reads the envelopes models invent, when they name one of the agent's tools", () => {
    expect(unwrapTurn({ name: "search_notes", arguments: '{"query": "x"}' }, tools)).toEqual({ tool: "search_notes", args: { query: "x" } });
    expect(unwrapTurn({ function: { name: "search_notes", arguments: { query: "x" } } }, tools)).toEqual({ tool: "search_notes", args: { query: "x" } });
    expect(unwrapTurn({ tool_calls: [{ function: { name: "write_file", arguments: { path: "a.md", content: "" } } }] }, tools)).toEqual({ tool: "write_file", args: { path: "a.md", content: "" } });
    expect(unwrapTurn({ action: "search_notes", action_input: { query: "x" } }, tools)).toEqual({ tool: "search_notes", args: { query: "x" } });
    expect(unwrapTurn({ action: "Final Answer", action_input: "done" }, tools)).toEqual({ final: "done" });
    // A final answer that has a `name` field is not a call.
    expect(unwrapTurn({ name: "Dana", role: "owner" }, tools)).toBeNull();
    expect(parseProtocolTurn('{"name": "SearchNotes", "parameters": {"query": "q",},}', tools)).toMatchObject({ kind: "tool", call: { name: "SearchNotes", args: { query: "q" } } });
    expect(parseProtocolTurn('{"name": "SearchNotes"}')).toEqual({ kind: "text", content: '{"name": "SearchNotes"}' });
  });

  it("resolves a tool name in another case or separator style, never an ambiguous one", () => {
    expect(resolveToolName("search_notes", tools)).toBe("search_notes");
    expect(resolveToolName("SearchNotes", tools)).toBe("search_notes");
    expect(resolveToolName("functions.search-notes", tools)).toBe("search_notes");
    expect(resolveToolName("search", tools)).toBeNull();
    const twins = [{ ...search, name: "a_b" }, { ...search, name: "aB" }] as AgentTool[];
    expect(resolveToolName("AB", twins)).toBeNull();
  });
});

describe("argument repair", () => {
  it("fixes types, keys, wrappers and extras against the schema", () => {
    const r = repairArgs({ arguments: { Query: "x", limit: "5", exact: "TRUE", tags: "a, b", extra: 1 } }, search.parameters);
    expect(r.args).toEqual({ query: "x", limit: 5, exact: true, tags: ["a", "b"] });
    expect(r.repairs).toEqual(['unwrapped "arguments"', "renamed Query → query", "limit: string → integer", "exact: string → boolean", "tags: string → array", "dropped extra"]);
    expect(repairArgs({ query: 2026, tags: '["x","y"]' }, search.parameters).args).toEqual({ query: "2026", tags: ["x", "y"] });
    expect(repairArgs({ query: "x", tags: "one" }, search.parameters).args).toEqual({ query: "x", tags: ["one"] });
  });

  it("leaves a clean call untouched and never invents a missing value", () => {
    const clean = { id: "c", name: "search_notes", args: { query: "x" } };
    expect(repairCall(clean, tools)).toEqual({ call: clean, repairs: [] });
    const missing = repairCall({ id: "c", name: "write_file", args: { path: "a.md" } }, tools);
    expect(missing.call.args).toEqual({ path: "a.md" });
    expect(callErrors(missing.call, tools)).toEqual([{ path: "$.content", message: "is required" }]);
    expect(callErrors({ id: "c", name: "nope", args: {} }, tools)).toBe("unknown-tool");
    expect(repairArgs({ query: "x", limit: "many" }, search.parameters).args).toEqual({ query: "x", limit: "many" });
  });

  it("tells the model what was wrong and the exact schema, once", () => {
    const m = retryMessage({ id: "c", name: "write_file", args: {} }, tools, "bad-args: $.content is required");
    expect(m).toContain("$.content is required");
    expect(m).toContain('"required":["path","content"]');
    expect(m).toContain("Do not invent values");
  });
});

type Script = (req: ExecutorRequest, n: number) => ExecutorResponse;
function fakeExecutor(script: Script, opts: Partial<Executor> = {}): Executor & { calls: ExecutorRequest[] } {
  const calls: ExecutorRequest[] = [];
  return { id: "ollama", label: "fake", calls, available: async () => ({ available: true }), supportsTools: () => false, supportsSchema: () => true, modelFor: (tier) => `fake-${tier}`, chat: async (req) => (calls.push(req), script(req, calls.length)), ...opts };
}
const reply = (content: string): ExecutorResponse => ({ content, toolCalls: [], model: "fake-small", usage: { inputTokens: 1, outputTokens: 1, estimated: true } });
const agent = (over: Partial<AgentDefinition> = {}): AgentDefinition => ({ id: "probe", description: "", system: "sys", user: () => "u", tools: [search, writer], ...over });

describe("the runtime's tool-call policy", () => {
  beforeEach(() => resetExecutors());
  afterEach(() => resetExecutors());

  it("holds every local tool turn to the protocol's JSON schema, at any tier", async () => {
    const ex = fakeExecutor(() => reply('{"final":"ok"}'), { supportsTools: () => true });
    registerExecutor(ex);
    await runAgent(agent({ tier: "large" }), {});
    expect(ex.calls[0].tools).toBeUndefined();
    const names = (ex.calls[0].schema as { anyOf: Array<{ properties: { tool?: { enum: string[] } } }> }).anyOf.flatMap((b) => b.properties.tool?.enum ?? []);
    expect(names).toEqual(["search_notes", "write_file"]);
  });

  it("runs a repaired call and records what was repaired", async () => {
    const ex = fakeExecutor((_r, n) => reply(n === 1 ? '{"name":"SearchNotes","arguments":"{\\"query\\": \\"cats\\", \\"limit\\": \\"3\\"}"}' : '{"final":"done"}'));
    registerExecutor(ex);
    const run = await runAgent(agent(), {});
    expect(run.status).toBe("ok");
    const tool = run.steps.find((s) => s.kind === "tool")!;
    expect(tool).toMatchObject({ label: "search_notes", ok: true });
    expect(tool.detail).toContain("repaired: tool SearchNotes → search_notes, limit: string → integer");
    expect(ex.calls[1].messages[ex.calls[1].messages.length - 1].content).toContain("cats:3");
  });

  it("gives an invalid call one retry with the schema error", async () => {
    let fed = "";
    const ex = fakeExecutor((r, n) => {
      if (n === 2) fed = r.messages[r.messages.length - 1].content; // what the model reads before its retry
      return reply(n === 1 ? '{"tool":"search_notes","args":{"limit":3}}' : n === 2 ? '{"tool":"search_notes","args":{"query":"cats"}}' : '{"final":"done"}');
    });
    registerExecutor(ex);
    const run = await runAgent(agent(), {});
    expect(run.status).toBe("ok");
    const error = (JSON.parse(fed) as { error: string }).error;
    expect(error).toContain("Invalid tool call: bad-args: $.query is required");
    expect(error).toContain('"required":["query"]');
    expect(run.steps.filter((s) => s.kind === "tool").map((s) => s.ok)).toEqual([false, true]);
  });

  it("asks the user after a second invalid call instead of guessing", async () => {
    const ex = fakeExecutor(() => reply('{"tool":"search_notes","args":{"limit":"lots"}}'));
    registerExecutor(ex);
    const run = await runAgent(agent({ maxRetries: 2 }), {});
    expect(run.status).toBe("failed");
    expect(run.errorCode).toBe("tool-args");
    expect(ex.calls).toHaveLength(2);
    expect(run.suggestions.map((x) => [x.id, x.title, x.params?.tool])).toEqual([["clarify-tool", "agent.suggest.clarifyTool", "search_notes"]]);
    expect(String(run.suggestions[0].params?.problem)).toContain("$.query is required");
    expect(run.error).toContain("Say exactly what it needs");
  });

  it("never lets a repaired call past the grants: 0 unapproved writes", async () => {
    const wrote = vi.fn();
    const w = { ...writer, run: async () => (wrote(), { ok: true }) } as AgentTool;
    const ex = fakeExecutor((_r, n) => reply(n === 1 ? '{"name":"WriteFile","arguments":{"path":"a.md","content":"x"}}' : '{"final":"gave up"}'));
    registerExecutor(ex);
    const run = await runAgent(agent({ tools: [search, w] }), {});
    expect(run.status).toBe("ok");
    expect(run.steps.find((s) => s.kind === "tool")).toMatchObject({ label: "write_file", ok: false });
    expect(ex.calls[1].messages[ex.calls[1].messages.length - 1].content).toContain("permission");
    expect(wrote).not.toHaveBeenCalled();
  });
});
