/**
 * Embedding providers for smart search, local first:
 *
 *   1. Ollama `/api/embed` with `nomic-embed-text` (or another installed
 *      embedding model) — when a local-origin Ollama has one installed;
 *   2. transformers.js `multilingual-e5-small` in a worker (384 dims,
 *      ~100 languages incl. Hebrew) — always available in the browser;
 *   3. OpenAI `text-embedding-3-small` — only under the `cloud` policy.
 *
 * Vectors from different models are not comparable, so the index records
 * which provider/model built it (`embeddingId()`), and a mismatch forces a
 * rebuild. e5 models expect "query: " / "passage: " prefixes.
 */

import { useAppStore } from "../store/useStore";
import { fetchWithRetry } from "../lib/fetchRetry";
import { assertCloudAllowed, getAiPolicy, isLocalOrigin } from "./policy";

export type EmbeddingKind = "query" | "passage";

export interface EmbeddingProvider {
  /** Stable id: provider + model, stored with the index. */
  id: string;
  dims: number | null;
  embed(texts: string[], kind: EmbeddingKind): Promise<Float32Array[]>;
}

const OLLAMA_EMBED_MODELS = /^(nomic-embed-text|embeddinggemma|mxbai-embed-large|all-minilm|bge-m3|snowflake-arctic-embed)/i;

async function ollamaEmbeddingModel(): Promise<string | null> {
  const { getBaseUrl, listOllamaModels, isOllamaAvailable } = await import("./ollamaProvider");
  if (!isLocalOrigin(getBaseUrl()) || !(await isOllamaAvailable())) return null;
  const models = await listOllamaModels();
  return models.find((m) => OLLAMA_EMBED_MODELS.test(m.name))?.name ?? null;
}

function ollamaProvider(model: string): EmbeddingProvider {
  return {
    id: `ollama:${model}`,
    dims: null,
    async embed(texts) {
      const { getBaseUrl } = await import("./ollamaProvider");
      const res = await fetch(`${getBaseUrl()}/api/embed`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ model, input: texts }),
      });
      if (!res.ok) throw new Error(`Ollama embed error ${res.status}`);
      const data = (await res.json()) as { embeddings?: number[][] };
      return (data.embeddings ?? []).map((v) => Float32Array.from(v));
    },
  };
}

const transformersProvider: EmbeddingProvider = {
  id: "transformers:Xenova/multilingual-e5-small",
  dims: 384,
  async embed(texts, kind) {
    const { embedTextsLocal } = await import("./transformersEngine");
    const prefixed = texts.map((t) => `${kind}: ${t}`);
    const out = await embedTextsLocal(prefixed);
    return out.vectors.map((v) => Float32Array.from(v));
  },
};

const openAiProvider: EmbeddingProvider = {
  id: "openai:text-embedding-3-small",
  dims: 1536,
  async embed(texts) {
    assertCloudAllowed("OpenAI embeddings (smart search)");
    const key = useAppStore.getState().aiKey;
    if (!key) throw new Error("Configure your AI Key (⌘K → AI Settings) to use cloud embeddings.");
    const res = await fetchWithRetry(
      "https://api.openai.com/v1/embeddings",
      {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
        body: JSON.stringify({ model: "text-embedding-3-small", input: texts }),
      },
      { label: "semantic.embed", maxRetries: 2, baseDelayMs: 500, maxDelayMs: 2000 },
    );
    if (!res.ok) {
      const body = await res.text().catch(() => "");
      throw new Error(`Embedding API ${res.status}: ${body.slice(0, 200)}`);
    }
    const json = (await res.json()) as { data: { embedding: number[] }[] };
    return json.data.map((d) => Float32Array.from(d.embedding));
  },
};

/** The provider for this device and policy. */
export async function pickEmbeddingProvider(): Promise<EmbeddingProvider> {
  if (getAiPolicy() === "cloud" && useAppStore.getState().aiKey) return openAiProvider;
  const ollama = await ollamaEmbeddingModel().catch(() => null);
  if (ollama) return ollamaProvider(ollama);
  return transformersProvider;
}

/** Tests. */
export const __providers = { transformersProvider, openAiProvider, ollamaProvider };
