import { describe, it, expect } from "vitest";
import { extractJsonObject, parseProtocolTurn, toolProtocolPrompt, toolResultMessage } from "../agents/protocol";
import { defineTool } from "../agents/tools/define";
import { classifyError, diagnose, nextTier } from "../agents/critic";

const tool = defineTool<{ q: string }, string>({
  name: "search",
  description: "search things",
  parameters: { type: "object", properties: { q: { type: "string" } }, required: ["q"] },
  run: async (a) => a.q,
});

describe("JSON-ReAct protocol", () => {
  it("extracts the first balanced JSON object through fences and prose", () => {
    expect(extractJsonObject('```json\n{"a":1}\n```')).toBe('{"a":1}');
    expect(extractJsonObject('Sure! Here it is: {"tool":"x","args":{"s":"}"}} trailing')).toBe('{"tool":"x","args":{"s":"}"}}');
    expect(extractJsonObject('{"s":"with \\" escaped"}')).toBe('{"s":"with \\" escaped"}');
    expect(extractJsonObject("no json here")).toBeNull();
    expect(extractJsonObject('{"unbalanced":')).toBeNull();
  });

  it("parses tool calls, finals and plain text", () => {
    const t = parseProtocolTurn('{"tool":"search","args":{"q":"cats"}}');
    expect(t.kind).toBe("tool");
    if (t.kind === "tool") {
      expect(t.call.name).toBe("search");
      expect(t.call.args).toEqual({ q: "cats" });
      expect(t.call.id).toMatch(/^call_/);
    }
    expect(parseProtocolTurn('{"final":"the answer"}')).toEqual({ kind: "final", content: "the answer" });
    expect(parseProtocolTurn('{"final":{"tags":["a"]}}')).toEqual({ kind: "final", content: '{"tags":["a"]}' });
    expect(parseProtocolTurn("  just words  ")).toEqual({ kind: "text", content: "just words" });
    // A tool call with non-object args gets empty args rather than crashing.
    const bad = parseProtocolTurn('{"tool":"search","args":"nope"}');
    expect(bad.kind === "tool" && bad.call.args).toEqual({});
  });

  it("describes the tools and the answer format in the prompt", () => {
    const p = toolProtocolPrompt([tool]);
    expect(p).toContain('"name":"search"');
    expect(p).toContain('{"tool": "<name>", "args": {<arguments>}}');
    expect(p).toContain('{"final": "<answer text>"}');
    const withSchema = toolProtocolPrompt([tool], { type: "object", required: ["x"] });
    expect(withSchema).toContain('"required":["x"]');
  });

  it("serialises tool results and errors", () => {
    const call = { id: "c", name: "search", args: {} };
    expect(JSON.parse(toolResultMessage(call, { hits: 2 }))).toEqual({ tool: "search", result: { hits: 2 } });
    expect(JSON.parse(toolResultMessage(call, undefined, "boom"))).toEqual({ tool: "search", error: "boom" });
  });
});

describe("critic (stage 1)", () => {
  it("classifies executor errors", () => {
    expect(classifyError("Ollama API error 403: forbidden")).toBe("cors");
    expect(classifyError('model "qwen2.5:7b" not found, try pulling it first')).toBe("model-missing");
    expect(classifyError("prompt exceeds the maximum context length")).toBe("context");
    expect(classifyError("TypeError: Failed to fetch")).toBe("offline");
    expect(classifyError("something odd")).toBe("error");
  });

  it("climbs tiers and stops at large", () => {
    expect(nextTier("tiny")).toBe("small");
    expect(nextTier("medium")).toBe("large");
    expect(nextTier("large")).toBeNull();
  });

  it("proposes a retry with the validator's hint, then a larger model", () => {
    const base = { kind: "validation" as const, maxRetries: 2, tier: "small" as const, executor: "ollama" as const, label: "mermaid", reason: "Parse error on line 2", hint: "Fix the syntax." };
    const first = diagnose({ ...base, attempt: 1 });
    expect(first.retry).toEqual({ temperature: 0, promptSuffix: "Previous answer was rejected: Parse error on line 2. Fix the syntax." });
    const second = diagnose({ ...base, attempt: 2 });
    expect(second.retry?.tier).toBe("medium");
    const done = diagnose({ ...base, attempt: 3, alternatives: ["webllm"] });
    expect(done.retry).toBeUndefined();
    expect(done.suggestions.map((s) => s.id)).toEqual(["larger-model", "switch-webllm", "retry"]);
  });

  it("maps availability reasons to suggestions without duplicates", () => {
    const v = diagnose({
      kind: "no-executor",
      attempt: 1,
      maxRetries: 2,
      tier: "small",
      executor: null,
      skipped: [
        { id: "ollama", availability: { available: false, reason: "ollama-offline" } },
        { id: "webllm", availability: { available: false, reason: "no-webgpu" } },
        { id: "chat", availability: { available: false, reason: "policy" } },
      ],
    });
    expect(v.diagnosis).toBe("ollama-offline");
    expect(v.suggestions.map((s) => s.id)).toEqual(["start-ollama", "use-ollama", "webgpu-browser", "allow-cloud"]);
    expect(v.suggestions.find((s) => s.id === "allow-cloud")?.action).toEqual({ type: "set-policy", policy: "local-first" });
  });

  it("suggests pulling a missing model, with its name", () => {
    const v = diagnose({ kind: "error", attempt: 3, maxRetries: 2, tier: "small", executor: "ollama", reason: 'model "gemma3:12b" not found' });
    expect(v.diagnosis).toBe("model-missing");
    expect(v.suggestions[0]).toMatchObject({ id: "pull-model", action: { type: "pull-model", executor: "ollama", model: "gemma3:12b" } });
  });

  it("suggests splitting long input on context errors", () => {
    // An agent that can run per part (5.6.2) is offered the split; any other asks for a smaller selection (#315).
    const v = diagnose({ kind: "error", attempt: 1, maxRetries: 2, tier: "small", executor: "webllm", reason: "context window exceeded", inputChars: 20000, splittable: true });
    expect(v.diagnosis).toBe("context");
    expect(v.retry).toBeTruthy();
    expect(v.suggestions.map((s) => s.id)).toEqual(["split-input"]);
    const other = diagnose({ kind: "error", attempt: 1, maxRetries: 2, tier: "small", executor: "webllm", reason: "context window exceeded", inputChars: 20000 });
    expect(other.suggestions.map((s) => s.id)).toEqual(["select-part"]);
  });
});
