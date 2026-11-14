import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const state = { aiKey: null as string | null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => state } }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
const ollamaUp = vi.fn().mockResolvedValue(false);
const ollamaChat = vi.fn().mockResolvedValue("from ollama");
let ollamaBase = "http://127.0.0.1:11434";
vi.mock("../ai/ollamaProvider", () => ({
  isOllamaAvailable: () => ollamaUp(),
  chatOllama: (m: unknown, o: unknown) => ollamaChat(m, o),
  chatOllamaStream: async function* () {
    yield "ollama-stream";
  },
  getBaseUrl: () => ollamaBase,
  ollamaKnownAvailable: () => probe.ok,
}));
const probe = vi.hoisted(() => ({ ok: false }));
const webgpu = { available: false };
const chatLocal = vi.fn(async (_m: unknown, _o: unknown) => "from webgpu");
vi.mock("../ai/localLlm", () => ({
  localLlmAvailable: () => webgpu,
  chatLocal: (m: unknown, o: unknown) => chatLocal(m, o),
  chatLocalStream: async function* () {
    yield "from webgpu";
  },
  defaultLocalModel: async () => "Qwen3-4B-q4f16_1-MLC",
  onLocalLlmProgress: () => () => {},
}));
vi.mock("../ai/anthropicProvider", () => ({ chatAnthropic: vi.fn().mockResolvedValue("from claude"), chatAnthropicStream: vi.fn() }));

import { getAiPolicy, setAiPolicy, cloudAllowed, providerAllowed, hasExplicitAiPolicy, hasAnyCloudKey } from "../ai/policy";
import { chat, chatStream } from "../ai/llm";
import { hasAiCredentials } from "../ai/credentials";

const KEYS = ["lumen.ai.policy", "lumen.ai.provider", "lumen.ai.key.anthropic", "lumen.ai.key.gemini"];

describe("AI policy", () => {
  beforeEach(() => {
    for (const k of KEYS) localStorage.removeItem(k);
    state.aiKey = null;
    state.useLocalAi = false;
    ollamaUp.mockResolvedValue(false);
    ollamaChat.mockClear();
    ollamaBase = "http://127.0.0.1:11434";
    localStorage.removeItem("lumen.ai.mode");
    webgpu.available = false;
    chatLocal.mockClear();
    probe.ok = false;
  });
  afterEach(() => {
    for (const k of KEYS) localStorage.removeItem(k);
  });

  it("defaults to local-only on a fresh install", () => {
    expect(getAiPolicy()).toBe("local-only");
    expect(hasExplicitAiPolicy()).toBe(false);
    expect(cloudAllowed()).toBe(false);
    expect(providerAllowed("openai")).toBe(false);
    expect(providerAllowed("ollama")).toBe(true);
  });

  it("keeps a pre-policy cloud setup working: explicit cloud provider → cloud, key only → local-first", () => {
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    expect(hasAnyCloudKey()).toBe(true);
    expect(getAiPolicy()).toBe("local-first");
    localStorage.removeItem("lumen.ai.key.anthropic");
    localStorage.setItem("lumen.ai.provider", "gemini");
    expect(getAiPolicy()).toBe("cloud");
    localStorage.removeItem("lumen.ai.provider");
    state.aiKey = "sk";
    expect(getAiPolicy()).toBe("local-first");
    localStorage.setItem("lumen.ai.provider", "ollama");
    expect(getAiPolicy()).toBe("local-first");
  });

  it("an explicit choice wins over the compatibility default", () => {
    state.aiKey = "sk";
    setAiPolicy("local-only");
    expect(getAiPolicy()).toBe("local-only");
    expect(hasExplicitAiPolicy()).toBe(true);
    expect(() => setAiPolicy("nope" as never)).toThrow();
  });

  it("chat(): no cloud fallback under local-only when Ollama is down (NO_LOCAL, not NO_KEY)", async () => {
    localStorage.setItem("lumen.ai.provider", "ollama");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    // Streaming takes the same gate.
    const gen = chatStream([{ role: "user", content: "hi" }]);
    await expect(gen.next()).rejects.toMatchObject({ code: "NO_LOCAL" });
  });

  it("chatStream(): Ollama down + Privacy Mode + WebGPU → the in-browser model answers, as in chat()", async () => {
    localStorage.setItem("lumen.ai.provider", "ollama");
    setAiPolicy("local-only");
    state.useLocalAi = true;
    webgpu.available = true;
    const gen = chatStream([{ role: "user", content: "hi" }]);
    expect((await gen.next()).value).toBe("from webgpu");
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from webgpu");
  });

  it("chat(): Ollama answers normally under local-only", async () => {
    localStorage.setItem("lumen.ai.provider", "ollama");
    ollamaUp.mockResolvedValue(true);
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from ollama");
  });

  it("chat(): a cloud provider under an explicit local-only policy goes local, or stops (NO_LOCAL)", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-only");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    expect(hasAiCredentials()).toBe(false);
    // Ollama reachable → it answers instead of Claude.
    ollamaUp.mockResolvedValue(true);
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from ollama");
    ollamaUp.mockResolvedValue(false);
    setAiPolicy("cloud");
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from claude");
    expect(hasAiCredentials()).toBe(true);
  });

  it("chat(): local-first tries Ollama before a selected cloud provider, then the cloud", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-first");
    ollamaUp.mockResolvedValue(true);
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from ollama");
    const gen = chatStream([{ role: "user", content: "hi" }]);
    expect((await gen.next()).value).toBe("ollama-stream");
    ollamaUp.mockResolvedValue(false);
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from claude");
  });

  it("drops a router-chosen cloud model when rerouting to Ollama, but keeps a caller-pinned one", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-first");
    ollamaUp.mockResolvedValue(true);
    // tier: light → the router picks claude-haiku; the Ollama call must not carry it.
    await chat([{ role: "user", content: "hi" }], { tier: "light" });
    expect(ollamaChat.mock.calls[0][1].model).toBeUndefined();
    await chat([{ role: "user", content: "hi" }], { model: "my-ollama-model" });
    expect(ollamaChat.mock.calls[1][1].model).toBe("my-ollama-model");
  });

  it("an Ollama server off this machine is not a local route under local-only", async () => {
    ollamaBase = "https://ollama.example.com";
    ollamaUp.mockResolvedValue(true);
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-only");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    expect(ollamaChat).not.toHaveBeenCalled();
    // Selected explicitly, it is refused outright.
    localStorage.setItem("lumen.ai.provider", "ollama");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "POLICY" });
    // Under local-first a remote Ollama the user configured still answers.
    setAiPolicy("local-first");
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from ollama");
  });

  it("streams through WebGPU (whole answer, once) when the local route picks it, never the cloud", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-only");
    webgpu.available = true;
    const chunks: string[] = [];
    for await (const c of chatStream([{ role: "user", content: "hi" }])) chunks.push(c);
    expect(chunks).toEqual(["from webgpu"]);
    expect(await chat([{ role: "user", content: "hi" }])).toBe("from webgpu");
    // local-first + Privacy Mode: WebGPU before Claude, in both chat and stream.
    setAiPolicy("local-first");
    state.useLocalAi = true;
    chunks.length = 0;
    for await (const c of chatStream([{ role: "user", content: "hi" }])) chunks.push(c);
    expect(chunks).toEqual(["from webgpu"]);
  });

  it("falls back to the SELECTED provider when Ollama vanishes between the two probes", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    localStorage.setItem("lumen.ai.key.anthropic", "k");
    setAiPolicy("local-first");
    // First probe (route) says up, second (dispatch) says down.
    ollamaUp.mockResolvedValueOnce(true).mockResolvedValueOnce(false).mockResolvedValue(false);
    await expect(chat([{ role: "user", content: "hi" }])).resolves.toBe("from claude");
    expect(ollamaChat).not.toHaveBeenCalled();
  });

  it("hasAiCredentials recognises the local routes a selected cloud provider would take", async () => {
    localStorage.setItem("lumen.ai.provider", "anthropic");
    setAiPolicy("local-only");
    // Nothing local seen yet → no usable provider (a silent background prompt is not spent).
    expect(hasAiCredentials()).toBe(false);
    probe.ok = true; // a probe saw Ollama
    expect(hasAiCredentials()).toBe(true);
    ollamaBase = "https://ollama.example.com"; // …but not on this machine
    expect(hasAiCredentials()).toBe(false);
    ollamaBase = "http://127.0.0.1:11434";
    probe.ok = false;
    const original = globalThis.navigator;
    Object.defineProperty(globalThis, "navigator", { value: { ...original, gpu: {} }, configurable: true });
    try {
      expect(hasAiCredentials()).toBe(true);
    } finally {
      Object.defineProperty(globalThis, "navigator", { value: original, configurable: true });
    }
  });

  it("direct cloud paths honour the policy: embeddings, transcription, batch, fine-tune, grammar, research", async () => {
    const { assertCloudAllowed, isLocalOrigin, AiPolicyError } = await import("../ai/policy");
    expect(() => assertCloudAllowed("x")).toThrow(AiPolicyError);
    expect(() => assertCloudAllowed("x")).toThrow(/local-only/);
    setAiPolicy("local-first");
    expect(() => assertCloudAllowed("x")).not.toThrow();
    expect(isLocalOrigin("http://localhost:8010/v2/check")).toBe(true);
    expect(isLocalOrigin("http://192.168.1.20:8080")).toBe(true);
    expect(isLocalOrigin("http://10.0.0.5")).toBe(true);
    expect(isLocalOrigin("http://172.20.1.1")).toBe(true);
    expect(isLocalOrigin("http://searx.lan.local")).toBe(true);
    expect(isLocalOrigin("https://api.languagetool.org/v2/check")).toBe(false);
    expect(isLocalOrigin("http://172.32.0.1")).toBe(false);
    expect(isLocalOrigin("not a url")).toBe(false);
  });

  it("chat(): local-first still falls back to OpenAI (NO_KEY when no key)", async () => {
    localStorage.setItem("lumen.ai.provider", "ollama");
    setAiPolicy("local-first");
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_KEY" });
  });

  it("chat(): WebGPU unavailable under local-only stops before OpenAI", async () => {
    state.useLocalAi = true;
    await expect(chat([{ role: "user", content: "hi" }])).rejects.toMatchObject({ code: "NO_LOCAL" });
    expect(hasAiCredentials()).toBe(false);
  });
});
