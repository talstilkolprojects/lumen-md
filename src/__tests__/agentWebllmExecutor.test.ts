import { describe, it, expect, vi, beforeEach } from "vitest";
import type { Hardware } from "../ai/modelManager";

const chat = vi.fn();
let hardware: Hardware = { webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false };

vi.mock("../ai/webllmEngine", () => ({
  webLlmChat: (model: string, request: unknown, opts: unknown) => chat(model, request, opts),
}));
const state = { useLocalAi: false, aiKey: null as string | null, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => state } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ai/modelManager", async (orig) => {
  const real = await orig<typeof import("../ai/modelManager")>();
  return { ...real, detectHardware: async () => hardware };
});

import { webllmExecutor, toOpenAiMessages, parseOpenAiToolCalls, describeWebLlmModel, WEBLLM_TOOL_MODELS } from "../agents/executors/webllm";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { setWebLlmModel } from "../ai/modelManager";
import { defineTool } from "../agents/tools/define";

const tool = defineTool({ name: "upper", description: "d", parameters: { type: "object" }, run: async () => 1 });

describe("webllm executor", () => {
  beforeEach(() => {
    chat.mockReset();
    setWebLlmModel(null);
    state.useLocalAi = false;
    localStorage.removeItem("lumen.ai.provider");
    localStorage.setItem("lumen.ai.policy", "local-only");
    hardware = { webgpu: true, f16: true, maxBufferMB: 2048, deviceMemoryGB: 8, cores: 8, mobile: false };
  });

  it("is available only with WebGPU, when the user opted into in-browser AI, and picks models by tier", async () => {
    localStorage.setItem("lumen.ai.policy", "local-only");
    expect(await webllmExecutor.available()).toEqual({ available: true });
    // local-first without Privacy Mode or the WebGPU provider: no surprise download.
    localStorage.setItem("lumen.ai.policy", "local-first");
    expect(await webllmExecutor.available()).toMatchObject({ available: false, reason: "not-opted-in" });
    localStorage.setItem("lumen.ai.provider", "local-webgpu");
    expect(await webllmExecutor.available()).toEqual({ available: true });
    localStorage.removeItem("lumen.ai.provider");
    // Choosing "Model in the browser" in the AI settings is an opt-in too.
    localStorage.setItem("lumen.ai.executor", "webllm");
    expect(await webllmExecutor.available()).toEqual({ available: true });
    localStorage.removeItem("lumen.ai.executor");
    state.useLocalAi = true;
    expect(await webllmExecutor.available()).toEqual({ available: true });
    localStorage.setItem("lumen.ai.policy", "cloud");
    expect(await webllmExecutor.available()).toMatchObject({ available: false, reason: "policy" });
    localStorage.setItem("lumen.ai.policy", "local-only");
    expect(webllmExecutor.modelFor("small")).toBe("Phi-3.5-mini-instruct-q4f16_1-MLC");
    expect(webllmExecutor.supportsSchema()).toBe(true);
    expect(webllmExecutor.supportsTools("Hermes-3-Llama-3.1-8B-q4f16_1-MLC")).toBe(true);
    expect(webllmExecutor.supportsTools("Hermes-3-Llama-3.2-3B-q4f16_1-MLC")).toBe(false);
    expect(webllmExecutor.supportsTools("Qwen3-4B-q4f16_1-MLC")).toBe(false);
    hardware = { ...hardware, webgpu: false, reason: "no-webgpu" };
    expect(await webllmExecutor.available()).toMatchObject({ available: false, reason: "no-webgpu" });
  });

  it("answers non-streaming with exact usage and a JSON schema as response_format", async () => {
    chat.mockResolvedValue({ model: "m", content: ' {"a":1} ', tool_calls: [], usage: { prompt_tokens: 12, completion_tokens: 4 } });
    const res = await webllmExecutor.chat({ messages: [{ role: "user", content: "hi" }], schema: { type: "object" }, model: "Qwen3-4B-q4f16_1-MLC", temperature: 0, maxTokens: 50 });
    expect(res).toEqual({ content: '{"a":1}', toolCalls: [], model: "m", usage: { inputTokens: 12, outputTokens: 4, estimated: false } });
    expect(chat.mock.calls[0][0]).toBe("Qwen3-4B-q4f16_1-MLC");
    const req = chat.mock.calls[0][1];
    expect(req.response_format).toEqual({ type: "json_object", schema: '{"type":"object"}' });
    expect(req.temperature).toBe(0);
    expect(req.max_tokens).toBe(50);
    expect(chat.mock.calls[0][2].onDelta).toBeUndefined();
  });

  it("streams deltas and takes usage from the last chunk", async () => {
    chat.mockImplementation(async (_m: string, _r: unknown, opts: { onDelta?: (t: string) => void }) => {
      opts.onDelta?.("He");
      opts.onDelta?.("llo");
      return { content: "Hello", tool_calls: [], model: "m", usage: { prompt_tokens: 3, completion_tokens: 2 } };
    });
    const deltas: string[] = [];
    const res = await webllmExecutor.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["He", "llo"]);
    expect(res.content).toBe("Hello");
    expect(res.usage).toEqual({ inputTokens: 3, outputTokens: 2, estimated: false });
    // Without usage from the worker the executor estimates.
    chat.mockResolvedValue({ content: "four words in here", tool_calls: [], model: "m" });
    expect((await webllmExecutor.chat({ messages: [{ role: "user", content: "hi" }] })).usage?.estimated).toBe(true);
  });

  it("uses native tools on a Hermes model and flattens tool turns otherwise", async () => {
    chat.mockResolvedValue({ content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "upper", arguments: '{"text":"a"}' } }], model: "h" });
    const res = await webllmExecutor.chat({ messages: [{ role: "user", content: "hi" }], tools: [tool], model: "Hermes-3-Llama-3.1-8B-q4f16_1-MLC", onDelta: () => {} });
    expect(res.toolCalls).toEqual([{ id: "c1", name: "upper", args: { text: "a" } }]);
    expect(chat.mock.calls[0][1].tools).toEqual([{ type: "function", function: { name: "upper", description: "d", parameters: { type: "object" } } }]);
    // Tool turns are never streamed.
    expect(chat.mock.calls[0][2].onDelta).toBeUndefined();

    chat.mockResolvedValue({ content: '{"final":"x"}', tool_calls: [], model: "q" });
    await webllmExecutor.chat({
      messages: [
        { role: "system", content: "s" },
        { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "upper", args: {} }] },
        { role: "tool", content: '{"result":1}', toolCallId: "c1", name: "upper" },
      ],
      tools: [tool],
      model: "Qwen3-4B-q4f16_1-MLC",
    });
    const msgs = chat.mock.calls[1][1].messages;
    expect(msgs.map((m: { role: string }) => m.role)).toEqual(["system", "assistant", "user"]);
    expect(chat.mock.calls[1][1].tools).toBeUndefined();
  });

  it("passes the abort signal through to the worker client", async () => {
    const ctrl = new AbortController();
    chat.mockResolvedValue({ content: "x", tool_calls: [], model: "m" });
    await webllmExecutor.chat({ messages: [{ role: "user", content: "hi" }], signal: ctrl.signal });
    expect(chat.mock.calls[0][2].signal).toBe(ctrl.signal);
  });

  it("lists exactly the installed library's function-calling models", () => {
    const lib = readFileSync(join(__dirname, "..", "..", "node_modules", "@mlc-ai", "web-llm", "lib", "index.js"), "utf8");
    const m = lib.match(/functionCallingModelIds = \[([^\]]+)\]/);
    expect(m).toBeTruthy();
    const ids = [...m![1].matchAll(/"([^"]+)"/g)].map((x) => x[1]).sort();
    expect([...WEBLLM_TOOL_MODELS].sort()).toEqual(ids);
  });

  it("maps messages and tool calls to the OpenAI shape", () => {
    const wire = toOpenAiMessages([
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "f", args: { a: 1 } }] },
      { role: "tool", content: "r", toolCallId: "c1", name: "f" },
    ]);
    expect(wire[0]).toEqual({ role: "assistant", content: "", tool_calls: [{ id: "c1", type: "function", function: { name: "f", arguments: '{"a":1}' } }] });
    expect(wire[1]).toEqual({ role: "tool", content: "r", tool_call_id: "c1" });
    expect(parseOpenAiToolCalls([{ function: { name: "f", arguments: "not json" } }])).toEqual([{ id: expect.any(String), name: "f", args: {} }]);
    expect(parseOpenAiToolCalls("nope")).toEqual([]);
    expect(describeWebLlmModel("Qwen3-4B-q4f16_1-MLC")).toBe("Qwen3 4B (3.4 GB)");
    expect(describeWebLlmModel("Other")).toBe("Other");
  });
});
