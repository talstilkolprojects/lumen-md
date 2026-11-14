import { describe, it, expect, vi, beforeEach } from "vitest";

const state = { aiKey: null as string | null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => state } }));
const ollama = { up: false, base: "http://localhost:11434", models: [] as Array<{ name: string }> };
vi.mock("../ai/ollamaProvider", () => ({
  getBaseUrl: () => ollama.base,
  isOllamaAvailable: async () => ollama.up,
  listOllamaModels: async () => ollama.models,
}));
const embedTextsLocal = vi.fn(async (texts: string[]) => ({ vectors: texts.map(() => [0.6, 0.8]), dims: 2 }));
vi.mock("../ai/transformersEngine", () => ({ embedTextsLocal: (t: string[]) => embedTextsLocal(t) }));

import { pickEmbeddingProvider } from "../ai/embeddingProvider";

describe("embedding provider choice", () => {
  beforeEach(() => {
    localStorage.clear();
    state.aiKey = null;
    ollama.up = false;
    ollama.base = "http://localhost:11434";
    ollama.models = [];
    embedTextsLocal.mockClear();
  });

  it("defaults to transformers.js e5 with query/passage prefixes", async () => {
    const p = await pickEmbeddingProvider();
    expect(p.id).toBe("transformers:Xenova/multilingual-e5-small");
    const v = await p.embed(["שלום"], "query");
    expect(embedTextsLocal).toHaveBeenCalledWith(["query: שלום"]);
    expect(Array.from(v[0])).toEqual([Float32Array.from([0.6])[0], Float32Array.from([0.8])[0]]);
  });

  it("uses a local Ollama embedding model when one is installed, not a remote one", async () => {
    ollama.up = true;
    ollama.models = [{ name: "qwen2.5:7b" }, { name: "nomic-embed-text:latest" }];
    expect((await pickEmbeddingProvider()).id).toBe("ollama:nomic-embed-text:latest");
    ollama.base = "https://ollama.example.com";
    expect((await pickEmbeddingProvider()).id).toBe("transformers:Xenova/multilingual-e5-small");
    ollama.base = "http://localhost:11434";
    ollama.models = [{ name: "qwen2.5:7b" }];
    expect((await pickEmbeddingProvider()).id).toBe("transformers:Xenova/multilingual-e5-small");
  });

  it("uses OpenAI only under the cloud policy with a key", async () => {
    state.aiKey = "sk";
    expect((await pickEmbeddingProvider()).id).not.toContain("openai");
    localStorage.setItem("lumen.ai.policy", "cloud");
    expect((await pickEmbeddingProvider()).id).toBe("openai:text-embedding-3-small");
  });
});
