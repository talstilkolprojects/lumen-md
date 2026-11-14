import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  ollamaExecutor,
  parseParams,
  pickModel,
  tierOf,
  toOllamaMessages,
  toOllamaTools,
  versionAtLeast,
  refreshOllama,
  probeToolSupport,
  __resetOllamaState,
  type InstalledModel,
} from "../agents/executors/ollama";
import { defineTool } from "../agents/tools/define";

const base = vi.hoisted(() => ({ url: "http://127.0.0.1:11434" }));
vi.mock("../ai/ollamaProvider", () => ({ getBaseUrl: () => base.url }));

type Route = (url: string, init?: RequestInit) => Response | Promise<Response>;
const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status, headers: { "Content-Type": "application/json" } });
const ndjson = (lines: unknown[]) => new Response(lines.map((l) => JSON.stringify(l)).join("\n") + "\n", { status: 200 });

const TAGS = {
  models: [
    { name: "qwen2.5:7b", details: { parameter_size: "7.6B", family: "qwen2" } },
    { name: "llama3.2:3b", details: { parameter_size: "3.2B", family: "llama" } },
    { name: "gemma3:12b", details: { parameter_size: "12.2B", family: "gemma3" } },
    { name: "nomic-embed-text:latest", details: { parameter_size: "137M", family: "nomic-bert" } },
  ],
};

let routes: Record<string, Route>;
let calls: Array<{ url: string; body: Record<string, unknown> | null }>;

function install() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      const path = new URL(url).pathname;
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      const r = routes[path];
      if (!r) return new Response("not found", { status: 404 });
      return r(url, init);
    }),
  );
}

describe("ollama executor — model choice", () => {
  const models: InstalledModel[] = [
    { name: "qwen2.5:7b", params: 7.6, family: "qwen2" },
    { name: "llama3.2:3b", params: 3.2, family: "llama" },
    { name: "gemma3:12b", params: 12.2, family: "gemma3" },
    { name: "qwen3:0.6b", params: 0.6, family: "qwen3" },
    { name: "nomic-embed-text:latest", params: 0.137, family: "nomic-bert" },
    { name: "qwen3:14b", params: 14.8, family: "qwen3" },
  ];

  it("parses parameter sizes and tiers", () => {
    expect(parseParams("7.6B")).toBe(7.6);
    expect(parseParams("137M")).toBeCloseTo(0.137);
    expect(parseParams(undefined)).toBeNull();
    expect(tierOf(0.6)).toBe("tiny");
    expect(tierOf(7.6)).toBe("small");
    expect(tierOf(12.2)).toBe("medium");
    expect(tierOf(70)).toBe("large");
    expect(tierOf(null)).toBe("small");
  });

  it("keeps the configured model when it fits the tier, else the largest in the band", () => {
    expect(pickModel("small", models, "llama3.2:3b")).toBe("llama3.2:3b");
    expect(pickModel("small", models, null)).toBe("qwen2.5:7b");
    // gemma3:12b is in the medium band too, but a custom licence (Gemma Terms) is only run when configured.
    expect(pickModel("medium", models, "qwen2.5:7b")).toBe("qwen3:14b");
    expect(pickModel("medium", models, "gemma3:12b")).toBe("gemma3:12b");
    expect(pickModel("tiny", models, null)).toBe("qwen3:0.6b");
    // Nothing in the large band: the largest below it.
    expect(pickModel("large", models, null)).toBe("qwen3:14b");
    // Everything installed is bigger than the tier: the smallest.
    expect(pickModel("tiny", [models[0], models[2]], null)).toBe("qwen2.5:7b");
    // Embedding models are never chosen for chat.
    expect(pickModel("tiny", [models[4]], "x")).toBe("x");
    expect(pickModel("small", [], "llama3.1")).toBe("llama3.1");
  });

  it("compares versions", () => {
    expect(versionAtLeast("0.5.0", [0, 5, 0])).toBe(true);
    expect(versionAtLeast("0.12.3", [0, 5, 0])).toBe(true);
    expect(versionAtLeast("0.4.9", [0, 5, 0])).toBe(false);
    expect(versionAtLeast(null, [0, 5, 0])).toBe(false);
  });

  it("maps messages and tools to Ollama's wire format", () => {
    const wire = toOllamaMessages([
      { role: "system", content: "s" },
      { role: "assistant", content: "", toolCalls: [{ id: "c1", name: "upper", args: { text: "a" } }] },
      { role: "tool", content: '{"result":1}', toolCallId: "c1", name: "upper" },
    ]);
    expect(wire[1]).toEqual({ role: "assistant", content: "", tool_calls: [{ function: { name: "upper", arguments: { text: "a" } } }] });
    expect(wire[2]).toEqual({ role: "tool", content: '{"result":1}', tool_name: "upper" });
    const t = defineTool({ name: "n", description: "d", parameters: { type: "object" }, run: async () => 1 });
    expect(toOllamaTools([t])).toEqual([{ type: "function", function: { name: "n", description: "d", parameters: { type: "object" } } }]);
  });
});

describe("ollama executor — server", () => {
  beforeEach(() => {
    __resetOllamaState();
    localStorage.removeItem("lumen.ollama.model");
    routes = {
      "/api/tags": () => json(TAGS),
      "/api/version": () => json({ version: "0.12.1" }),
      "/api/show": (_u, init) => {
        const { model } = JSON.parse(String(init?.body));
        return json({ capabilities: model.startsWith("gemma") ? ["completion"] : ["completion", "tools"] });
      },
    };
    install();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("is available with installed models, learns schema and tool support", async () => {
    expect(await ollamaExecutor.available()).toEqual({ available: true });
    expect(ollamaExecutor.supportsSchema()).toBe(true);
    expect(ollamaExecutor.modelFor("small")).toBe("qwen2.5:7b");
    expect(ollamaExecutor.supportsTools("qwen2.5:7b")).toBe(true);
    expect(await probeToolSupport("gemma3:12b")).toBe(false);
    expect(ollamaExecutor.supportsTools("gemma3:12b")).toBe(false);
  });

  it("falls back to the family list when /api/show has no capabilities", async () => {
    routes["/api/show"] = () => json({ license: "x" });
    expect(await probeToolSupport("llama3.1:8b")).toBe(true);
    expect(await probeToolSupport("gemma3:4b")).toBe(false);
  });

  it("reports offline, CORS and no-model states", async () => {
    routes["/api/tags"] = () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await ollamaExecutor.available()).toMatchObject({ available: false, reason: "ollama-offline" });
    __resetOllamaState();
    routes["/api/tags"] = () => new Response("", { status: 403 });
    expect(await ollamaExecutor.available()).toMatchObject({ available: false, reason: "cors" });
    __resetOllamaState();
    routes["/api/tags"] = () => json({ models: [] });
    expect(await ollamaExecutor.available()).toMatchObject({ available: false, reason: "no-model", detail: "qwen2.5:7b" });
  });

  it("caches the tag list briefly", async () => {
    await refreshOllama();
    await refreshOllama();
    expect(calls.filter((c) => c.url.endsWith("/api/tags"))).toHaveLength(1);
    await refreshOllama(true);
    expect(calls.filter((c) => c.url.endsWith("/api/tags"))).toHaveLength(2);
  });

  it("sends tools and schema natively and returns exact usage and tool calls", async () => {
    await ollamaExecutor.available();
    routes["/api/chat"] = () =>
      json({
        model: "qwen2.5:7b",
        message: { role: "assistant", content: "", tool_calls: [{ function: { name: "upper", arguments: { text: "x" } } }] },
        done: true,
        prompt_eval_count: 42,
        eval_count: 7,
      });
    const tool = defineTool({ name: "upper", description: "d", parameters: { type: "object" }, run: async () => 1 });
    const res = await ollamaExecutor.chat({
      messages: [{ role: "user", content: "hi" }],
      tools: [tool],
      schema: { type: "object" },
      tier: "small",
      temperature: 0,
      maxTokens: 100,
    });
    expect(res.toolCalls).toEqual([{ id: expect.any(String), name: "upper", args: { text: "x" } }]);
    expect(res.usage).toEqual({ inputTokens: 42, outputTokens: 7, estimated: false });
    const body = calls.find((c) => c.url.endsWith("/api/chat"))!.body!;
    expect(body.model).toBe("qwen2.5:7b");
    expect(body.stream).toBe(false);
    expect(body.tools).toHaveLength(1);
    expect(body.format).toEqual({ type: "object" });
    expect(body.options).toEqual({ temperature: 0, num_predict: 100 });
  });

  it("streams NDJSON deltas when there are no tools", async () => {
    await ollamaExecutor.available();
    routes["/api/chat"] = () =>
      ndjson([
        { model: "qwen2.5:7b", message: { role: "assistant", content: "Hel" }, done: false },
        { model: "qwen2.5:7b", message: { role: "assistant", content: "lo" }, done: false },
        { model: "qwen2.5:7b", message: { role: "assistant", content: "" }, done: true, prompt_eval_count: 5, eval_count: 2 },
      ]);
    const deltas: string[] = [];
    const res = await ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], onDelta: (d) => deltas.push(d) });
    expect(deltas).toEqual(["Hel", "lo"]);
    expect(res.content).toBe("Hello");
    expect(res.usage).toEqual({ inputTokens: 5, outputTokens: 2, estimated: false });
    expect(calls.find((c) => c.url.endsWith("/api/chat"))!.body!.stream).toBe(true);
  });

  it("treats an `error` object in the NDJSON stream (HTTP 200) as a failure, not a truncated answer", async () => {
    await ollamaExecutor.available();
    routes["/api/chat"] = () => ndjson([{ model: "m", message: { role: "assistant", content: "Hel" }, done: false }, { error: "context canceled" }]);
    await expect(ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} })).rejects.toThrow(/Ollama API error: context canceled/);
    routes["/api/chat"] = () => json({ error: "something broke" });
    await expect(ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }] })).rejects.toThrow(/something broke/);
  });

  it("rejects a stream that ends without its terminal record", async () => {
    await ollamaExecutor.available();
    routes["/api/chat"] = () => ndjson([{ model: "m", message: { role: "assistant", content: "partial" }, done: false }]);
    await expect(ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], onDelta: () => {} })).rejects.toThrow(/stream ended before the final record/);
  });

  it("probes tool support for every tier's model and prefers a tool model for tool agents", async () => {
    localStorage.setItem("lumen.ollama.model", "gemma3:12b");
    await ollamaExecutor.available();
    const probed = calls.filter((c) => c.url.endsWith("/api/show")).map((c) => c.body!.model);
    // llama3.2:3b (custom licence, not configured) is never a pick, so it is not probed.
    expect(new Set(probed)).toEqual(new Set(["qwen2.5:7b", "gemma3:12b"]));
    // medium → the configured gemma3 (no tools); a tool agent on medium gets the best tool-capable model instead.
    expect(ollamaExecutor.modelFor("medium")).toBe("gemma3:12b");
    expect(ollamaExecutor.modelFor("medium", { tools: true })).toBe("qwen2.5:7b");
    expect(ollamaExecutor.supportsTools("gemma3:12b")).toBe(false);
  });

  it("never runs an installed custom-licence model the user did not configure (plan 1.7)", async () => {
    await ollamaExecutor.available();
    for (const tier of ["tiny", "small", "medium", "large"] as const) {
      expect(ollamaExecutor.modelFor(tier)).toBe("qwen2.5:7b");
      expect(ollamaExecutor.modelFor(tier, { tools: true })).toBe("qwen2.5:7b");
    }
    // Only custom-licence models installed: nothing to run until the user picks one.
    __resetOllamaState();
    routes["/api/tags"] = () => json({ models: TAGS.models.filter((m) => /^(llama|gemma)/.test(m.name)) });
    expect(await ollamaExecutor.available()).toMatchObject({ available: false, reason: "no-model", detail: "qwen2.5:7b" });
    localStorage.setItem("lumen.ollama.model", "llama3.2:3b");
    __resetOllamaState();
    expect(await ollamaExecutor.available()).toEqual({ available: true });
    expect(ollamaExecutor.modelFor("small")).toBe("llama3.2:3b");
  });

  it("is not available when only embedding models are installed", async () => {
    routes["/api/tags"] = () => json({ models: [{ name: "nomic-embed-text:latest", details: { parameter_size: "137M" } }] });
    expect(await ollamaExecutor.available()).toMatchObject({ available: false, reason: "no-model" });
  });

  it("surfaces HTTP errors with the status so the critic can classify them", async () => {
    await ollamaExecutor.available();
    routes["/api/chat"] = () => new Response('{"error":"model \\"nope\\" not found"}', { status: 404 });
    await expect(ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], model: "nope" })).rejects.toThrow(/Ollama API error 404.*not found/);
  });

  it("does not send a schema to a server older than 0.5", async () => {
    routes["/api/version"] = () => json({ version: "0.3.14" });
    await ollamaExecutor.available();
    expect(ollamaExecutor.supportsSchema()).toBe(false);
    routes["/api/chat"] = () => json({ model: "m", message: { content: "ok" }, done: true });
    await ollamaExecutor.chat({ messages: [{ role: "user", content: "hi" }], schema: { type: "object" } });
    expect(calls.find((c) => c.url.endsWith("/api/chat"))!.body!.format).toBeUndefined();
  });
});

describe("ollama executor under local-only (review)", () => {
  afterEach(() => {
    base.url = "http://127.0.0.1:11434";
    localStorage.removeItem("lumen.ai.policy");
  });

  it("refuses a remote Ollama before probing or sending anything", async () => {
    const fetchSpy = vi.fn();
    vi.stubGlobal("fetch", fetchSpy);
    base.url = "https://ollama.example.com";
    localStorage.setItem("lumen.ai.policy", "local-only");
    expect(await ollamaExecutor.available()).toEqual({ available: false, reason: "policy", detail: "https://ollama.example.com" });
    await expect(ollamaExecutor.chat({ messages: [{ role: "user", content: "secret" }] })).rejects.toMatchObject({ code: "POLICY" });
    expect(fetchSpy).not.toHaveBeenCalled();
    vi.unstubAllGlobals();
  });
});
