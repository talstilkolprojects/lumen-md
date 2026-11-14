import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const cspAllowed = vi.fn((_url: string) => true);
vi.mock("../lib/cspConnect", () => ({ connectAllowedByCsp: (u: string) => cspAllowed(u) }));
vi.mock("../lib/logger", () => ({ log: { warn: vi.fn(), error: vi.fn(), info: vi.fn(), debug: vi.fn() } }));

import { getBaseUrl, setOllamaConfig, isOllamaAvailable, listOllamaModels, chatOllama, chatOllamaStream, embedOllama, pullOllamaModel } from "../ai/ollamaProvider";

const json = (data: unknown, status = 200) => new Response(JSON.stringify(data), { status });
let calls: Array<{ url: string; body: Record<string, unknown> | null }>;
let handler: (path: string) => Response;

function install() {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input);
      calls.push({ url, body: init?.body ? JSON.parse(String(init.body)) : null });
      return handler(new URL(url).pathname);
    }),
  );
}

describe("ollamaProvider", () => {
  beforeEach(() => {
    localStorage.removeItem("lumen.ollama.baseUrl");
    localStorage.removeItem("lumen.ollama.model");
    cspAllowed.mockReturnValue(true);
    install();
  });
  afterEach(() => vi.unstubAllGlobals());

  it("uses the configured base URL only when the CSP allows it", () => {
    expect(getBaseUrl()).toBe("http://localhost:11434");
    setOllamaConfig({ baseUrl: "http://192.168.1.20:11434", model: "gemma3:4b" });
    expect(getBaseUrl()).toBe("http://192.168.1.20:11434");
    cspAllowed.mockReturnValue(false);
    expect(getBaseUrl()).toBe("http://localhost:11434");
  });

  it("probes availability and lists models", async () => {
    handler = () => json({ models: [{ name: "llama3.1:8b", size: 1, digest: "abcdef1234567890", modified_at: "t", details: { family: "llama" } }] });
    expect(await isOllamaAvailable()).toBe(true);
    const list = await listOllamaModels();
    expect(list).toEqual([{ name: "llama3.1:8b", size: 1, digest: "abcdef123456", modifiedAt: "t", details: { family: "llama" } }]);
    handler = () => {
      throw new TypeError("Failed to fetch");
    };
    expect(await isOllamaAvailable()).toBe(false);
    expect(await listOllamaModels()).toEqual([]);
  });

  it("with no model chosen, runs the same open-licence default that usage and the cache record (1.7)", async () => {
    handler = () => json({ choices: [{ message: { content: "ok" } }] });
    await chatOllama([{ role: "user", content: "hello" }]);
    const { DEFAULT_OLLAMA_MODEL } = await import("../ai/ollamaProvider");
    const { effectiveModel } = await import("../ai/llm");
    expect(DEFAULT_OLLAMA_MODEL).toBe("qwen2.5:7b");
    expect(calls[0].body).toMatchObject({ model: DEFAULT_OLLAMA_MODEL });
    expect(effectiveModel("ollama")).toBe(DEFAULT_OLLAMA_MODEL);
  });

  it("chats through the OpenAI-compatible endpoint with the configured model", async () => {
    setOllamaConfig({ model: "qwen2.5:7b" });
    handler = () => json({ choices: [{ message: { content: "  hi there " } }] });
    expect(await chatOllama([{ role: "user", content: "hello" }], { maxTokens: 10, temperature: 0.2 })).toBe("hi there");
    const c = calls[0];
    expect(c.url).toBe("http://localhost:11434/v1/chat/completions");
    expect(c.body).toMatchObject({ model: "qwen2.5:7b", stream: false, max_tokens: 10, temperature: 0.2 });
    handler = () => new Response("boom", { status: 500 });
    await expect(chatOllama([{ role: "user", content: "x" }])).rejects.toThrow(/Ollama API error 500/);
  });

  it("streams SSE deltas", async () => {
    const sse = ['data: {"choices":[{"delta":{"content":"a"}}]}', 'data: {"choices":[{"delta":{"content":"b"}}]}', "data: [DONE]", ""].join("\n");
    handler = () => new Response(sse, { status: 200 });
    const out: string[] = [];
    for await (const chunk of chatOllamaStream([{ role: "user", content: "x" }], { model: "m" })) out.push(chunk);
    expect(out).toEqual(["a", "b"]);
    expect(calls[0].body).toMatchObject({ model: "m", stream: true });
  });

  it("embeds and pulls", async () => {
    handler = () => json({ embeddings: [[0.1, 0.2]] });
    expect(await embedOllama("text")).toEqual([0.1, 0.2]);
    expect(calls[0].body).toEqual({ model: "nomic-embed-text", input: "text" });
    handler = () => new Response('{"status":"pulling"}\n{"status":"success","completed":5,"total":5}\n', { status: 200 });
    const events: unknown[] = [];
    for await (const e of pullOllamaModel("x")) events.push(e);
    expect(events).toEqual([{ status: "pulling" }, { status: "success", completed: 5, total: 5 }]);
  });
});

describe("the no-models hint names the open-licence default (plan 1.7)", () => {
  it("in English and every locale, and the Ollama Models command uses it", async () => {
    const { readFileSync, readdirSync } = await import("node:fs");
    const { join, resolve } = await import("node:path");
    const { DEFAULT_OLLAMA_MODEL } = await import("../ai/ollamaProvider");
    const root = resolve(__dirname, "..");
    const en = readFileSync(join(root, "i18n/index.ts"), "utf8").match(/"ai\.settings\.ollama\.none":\s*"([^"]+)"/)?.[1];
    expect(en).toContain(`ollama pull ${DEFAULT_OLLAMA_MODEL}`);
    const locales = readdirSync(join(root, "i18n/locales")).filter((f) => f.endsWith(".json"));
    expect(locales.length).toBe(7);
    for (const f of locales) {
      const strings = JSON.parse(readFileSync(join(root, "i18n/locales", f), "utf8")) as Record<string, string>;
      expect([f, strings["ai.settings.ollama.none"]]).toEqual([f, expect.stringContaining(`ollama pull ${DEFAULT_OLLAMA_MODEL}`)]);
    }
    // The palette's AI commands live in commands/domains/ai.ts since the useCommands split.
    const commands = readFileSync(join(root, "commands/domains/ai.ts"), "utf8");
    const block = commands.slice(commands.indexOf('id: "ai.ollamaModels"'), commands.indexOf('id: "ai.usage"'));
    expect(block).toContain('t("ai.settings.ollama.none")');
    expect(commands).not.toMatch(/ollama pull (llama|gemma|aya)/);
  });
});
