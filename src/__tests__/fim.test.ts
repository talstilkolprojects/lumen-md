/**
 * Plan 6.9 — local fill-in-the-middle autocomplete: model choice (never
 * the 3B), the `/api/generate` body with `suffix`, cache, cancel on every
 * keystroke, debounce, latency in the trace, the web-llm fallback, and no
 * cloud route under any policy.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const webllm = vi.hoisted(() => ({ loaded: null as string | null }));
vi.mock("../ai/webllmEngine", () => ({ loadedWebLlmModel: () => webllm.loaded }));
const runAgentOrThrow = vi.hoisted(() => vi.fn(async (..._args: unknown[]) => " from the browser"));
vi.mock("../agents/runtime", () => ({ runAgentOrThrow }));
const recordRun = vi.hoisted(() => vi.fn(async (_run: unknown) => {}));
vi.mock("../agents/trace", () => ({ recordRun }));
vi.mock("../lib/logger", () => ({ log: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } }));

import { FIM_MODELS, FimCache, FimScheduler, cleanFim, fimRequestBody, percentile, pickFimModel, type Timers } from "../ai/fimCore";
import { __resetFim, completeFim, fimLatency, ollamaFimModel } from "../ai/fim";

describe("fimCore", () => {
  it("picks qwen2.5-coder 1.5B, else 7B — never the 3B (not an open licence)", () => {
    expect(FIM_MODELS).toEqual(["qwen2.5-coder:1.5b", "qwen2.5-coder:7b"]);
    expect(pickFimModel(["qwen2.5:7b", "qwen2.5-coder:3b", "qwen2.5-coder:7b"])).toBe("qwen2.5-coder:7b");
    expect(pickFimModel(["qwen2.5-coder:7b", "qwen2.5-coder:1.5b-base-q8_0"])).toBe("qwen2.5-coder:1.5b-base-q8_0");
    expect(pickFimModel(["qwen2.5-coder:3b"])).toBeNull();
    expect(pickFimModel(["qwen2.5-coder:3b"], "qwen2.5-coder:3b")).toBeNull();
    expect(pickFimModel(["my-coder:latest", "qwen2.5-coder:7b"], "my-coder:latest")).toBe("my-coder:latest");
    expect(pickFimModel(["qwen2.5-coder:7b"], "not-installed")).toBe("qwen2.5-coder:7b");
  });

  it("sends the text before the cursor as the prompt and the text after it as suffix", () => {
    const body = fimRequestBody("qwen2.5-coder:1.5b", "x".repeat(3000) + "before", "after" + "y".repeat(3000));
    expect(body.model).toBe("qwen2.5-coder:1.5b");
    expect(body.prompt.endsWith("before")).toBe(true);
    expect(body.prompt.length).toBe(1500);
    expect(body.suffix.startsWith("after")).toBe(true);
    expect(body.suffix.length).toBe(500);
    expect(body.stream).toBe(false);
    expect(body.options.num_predict).toBeLessThanOrEqual(64);
  });

  it("cleans a completion: no special tokens, no overlap with the text after the cursor, two lines at most", () => {
    expect(cleanFim("world();<|endoftext|>", "}")).toBe("world();");
    expect(cleanFim(" fox jumps over", "over the dog")).toBe(" fox jumps ");
    expect(cleanFim("a\nb\nc", "")).toBe("a\nb");
  });

  it("the cache is a small LRU keyed by model and context", () => {
    const c = new FimCache(2);
    c.set("a", "1");
    c.set("b", "2");
    expect(c.get("a")).toBe("1");
    c.set("c", "3");
    expect(c.get("b")).toBeUndefined();
    expect(c.size).toBe(2);
    expect(FimCache.key("m", "p", "s")).not.toBe(FimCache.key("m2", "p", "s"));
  });

  it("debounces, and every new keystroke cancels the request before it — waiting or in flight", async () => {
    const pending: Array<() => void> = [];
    const timers: Timers = { set: (fn) => (pending.push(fn), pending.length), clear: (id) => (pending[(id as number) - 1] = () => {}) };
    const signals: AbortSignal[] = [];
    const finish: Array<(v: string) => void> = [];
    const s = new FimScheduler<string>((signal) => {
      signals.push(signal);
      return new Promise((r) => finish.push(r));
    }, 150, timers);
    // Two keystrokes inside the debounce: only the second one runs.
    const first = s.request();
    const second = s.request();
    expect(await first).toBeNull();
    pending.forEach((fn) => fn());
    expect(signals).toHaveLength(1);
    // A third keystroke while the second is in flight aborts it.
    const third = s.request();
    expect(signals[0].aborted).toBe(true);
    finish[0]("late");
    expect(await second).toBeNull();
    pending[pending.length - 1]();
    finish[1]("fresh");
    expect(await third).toBe("fresh");
    s.cancel();
  });

  it("percentiles by nearest rank", () => {
    expect(percentile([5, 1, 3, 2, 4], 50)).toBe(3);
    expect(percentile(Array.from({ length: 10 }, (_, i) => i + 1), 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
  });
});

describe("completeFim", () => {
  const generated: Array<Record<string, unknown>> = [];
  const fetchSpy = vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
    const u = String(input);
    if (u.endsWith("/api/tags")) return new Response(JSON.stringify({ models: [{ name: "qwen2.5-coder:3b" }, { name: "qwen2.5-coder:1.5b" }] }));
    if (u.endsWith("/api/generate")) {
      generated.push(JSON.parse(String(init?.body)));
      return new Response(JSON.stringify({ response: "jumps over<|endoftext|>", prompt_eval_count: 30, eval_count: 4 }));
    }
    return new Response("{}", { status: 404 });
  });
  const urls = () => fetchSpy.mock.calls.map(([u]) => String(u));

  beforeEach(() => {
    localStorage.clear();
    __resetFim();
    generated.length = 0;
    fetchSpy.mockClear();
    recordRun.mockClear();
    runAgentOrThrow.mockClear();
    webllm.loaded = null;
    vi.stubGlobal("fetch", fetchSpy);
  });
  afterEach(() => vi.unstubAllGlobals());

  it("completes on the local Ollama with suffix, caches the answer, and puts the latency in the trace", async () => {
    const r = await completeFim("The quick brown fox ", " the lazy dog");
    expect(r).toMatchObject({ text: "jumps over", engine: "ollama", model: "qwen2.5-coder:1.5b", cached: false });
    expect(generated).toEqual([expect.objectContaining({ model: "qwen2.5-coder:1.5b", prompt: "The quick brown fox ", suffix: " the lazy dog" })]);
    const again = await completeFim("The quick brown fox ", " the lazy dog");
    expect(again).toMatchObject({ text: "jumps over", cached: true, ms: 0 });
    expect(generated).toHaveLength(1);
    expect(fimLatency().n).toBe(1);
    await vi.waitFor(() => expect(recordRun).toHaveBeenCalledTimes(1));
    expect(recordRun.mock.calls[0][0]).toMatchObject({ agentId: "fim", executor: "ollama", model: "qwen2.5-coder:1.5b", status: "ok" });
    // A burst of completions: one trace entry per half minute, not one per keystroke.
    await completeFim("Another context here ", "");
    await completeFim("And one more context ", "");
    expect(recordRun).toHaveBeenCalledTimes(1);
  });

  it("a cancelled request returns nothing and caches nothing", async () => {
    const ctrl = new AbortController();
    ctrl.abort();
    expect(await completeFim("Something to complete ", "", { signal: ctrl.signal })).toBeNull();
    expect(generated).toHaveLength(0);
  });

  it("never a remote Ollama, under any policy; with the in-browser model loaded it falls back there", async () => {
    localStorage.setItem("lumen.ollama.baseUrl", "https://ollama.example.com");
    for (const policy of ["local-only", "local-first", "cloud"]) {
      localStorage.setItem("lumen.ai.policy", policy);
      __resetFim();
      expect(await ollamaFimModel()).toBeNull();
      expect(await completeFim("Some text before the cursor ", "")).toBeNull();
    }
    expect(urls().filter((u) => u.includes("example.com"))).toEqual([]);
    webllm.loaded = "Qwen3-1.7B-q4f16_1-MLC";
    const r = await completeFim("Some text before the cursor ", "");
    expect(r).toMatchObject({ engine: "webllm", text: " from the browser" });
    expect(runAgentOrThrow.mock.calls[0][2]).toMatchObject({ executor: "webllm", prepaid: true });
  });

  it("0 cloud requests: every request went to the local Ollama", async () => {
    for (const policy of ["local-only", "local-first", "cloud"]) {
      localStorage.setItem("lumen.ai.policy", policy);
      localStorage.setItem("lumen.ai.provider", "openai");
      await completeFim(`Text under ${policy} policy `, " and more");
    }
    expect(urls().length).toBeGreaterThan(0);
    expect(urls().every((u) => u.startsWith("http://localhost:11434/"))).toBe(true);
  });

  it("without a FIM model and without a loaded in-browser model: nothing, and no download", async () => {
    fetchSpy.mockImplementationOnce(async () => new Response(JSON.stringify({ models: [{ name: "qwen2.5:7b" }] })));
    expect(await completeFim("Some text before the cursor ", "")).toBeNull();
    expect(runAgentOrThrow).not.toHaveBeenCalled();
    expect(generated).toHaveLength(0);
  });
});
