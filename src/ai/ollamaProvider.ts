/**
 * Ollama local model provider.
 *
 * Connects to a locally-running Ollama instance (default http://localhost:11434)
 * and routes chat/stream calls through its OpenAI-compatible API.
 *
 * Zero external dependencies — uses native fetch + SSE parsing.
 */

import type { ChatMessage, ChatOptions } from "./llm";
import { log } from "../lib/logger";
import { connectAllowedByCsp } from "../lib/cspConnect";

const DEFAULT_OLLAMA_URL = "http://localhost:11434";

export interface OllamaConfig {
  baseUrl: string;
  model: string;
  contextLength?: number;
  keepAlive?: string;
}

export interface OllamaModel {
  name: string;
  size: number;
  digest: string;
  modifiedAt: string;
  details?: {
    family: string;
    parameterSize: string;
    quantizationLevel: string;
  };
}

/** Configured Ollama base URL (`lumen.ollama.baseUrl`), default localhost:11434. */
export function getBaseUrl(): string {
  try {
    const stored = localStorage.getItem("lumen.ollama.baseUrl");
    if (stored && !connectAllowedByCsp(stored)) {
      // The browser would block it under this deployment's CSP.
      log.warn(
        `Ollama URL ${stored} isn't in this deployment's CSP connect-src; using ${DEFAULT_OLLAMA_URL}. ` +
          "Add its origin with VITE_CSP_CONNECT_EXTRA at build time.",
      );
      return DEFAULT_OLLAMA_URL;
    }
    return stored || DEFAULT_OLLAMA_URL;
  } catch {
    return DEFAULT_OLLAMA_URL;
  }
}

/**
 * Model used when the user has not picked one. Open licence (Apache-2.0), so a
 * fresh install never runs a custom-licence model without an opt-in (plan 1.7).
 */
export const DEFAULT_OLLAMA_MODEL = "qwen2.5:7b";

function getModel(): string {
  try {
    return localStorage.getItem("lumen.ollama.model") || DEFAULT_OLLAMA_MODEL;
  } catch {
    return DEFAULT_OLLAMA_MODEL;
  }
}

/** The configured Ollama chat model (`lumen.ollama.model`, default {@link DEFAULT_OLLAMA_MODEL}). */
export function getOllamaConfigModel(): string {
  return getModel();
}

export function setOllamaConfig(config: Partial<OllamaConfig>): void {
  if (config.baseUrl) localStorage.setItem("lumen.ollama.baseUrl", config.baseUrl);
  if (config.model) localStorage.setItem("lumen.ollama.model", config.model);
}

/**
 * Check if Ollama is running and reachable.
 */
let lastProbe: { at: number; ok: boolean } | null = null;

export async function isOllamaAvailable(): Promise<boolean> {
  let ok = false;
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`, {
      method: "GET",
      signal: AbortSignal.timeout(2000),
    });
    ok = res.ok;
  } catch {
    ok = false;
  }
  lastProbe = { at: Date.now(), ok };
  return ok;
}

/**
 * Did the last probe find the server? For synchronous checks (the quota
 * gate) that cannot wait for a request: a selected cloud provider only
 * reroutes to Ollama once a probe has actually seen it.
 */
export function ollamaKnownAvailable(): boolean {
  return lastProbe?.ok === true;
}

/** Tests. */
export function __resetOllamaProbe(): void {
  lastProbe = null;
}

/**
 * List all locally available Ollama models.
 */
export async function listOllamaModels(): Promise<OllamaModel[]> {
  try {
    const res = await fetch(`${getBaseUrl()}/api/tags`);
    if (!res.ok) return [];
    const data = await res.json();
    return (data.models ?? []).map((m: Record<string, unknown>) => ({
      name: m.name as string,
      size: m.size as number,
      digest: (m.digest as string)?.slice(0, 12),
      modifiedAt: m.modified_at as string,
      details: m.details as OllamaModel["details"],
    }));
  } catch (e) {
    log.error("ollama", "Failed to list models", e);
    return [];
  }
}

/**
 * Pull a model (download). Returns an async generator of progress events.
 */
export async function* pullOllamaModel(
  modelName: string,
): AsyncGenerator<{ status: string; completed?: number; total?: number }, void, undefined> {
  const res = await fetch(`${getBaseUrl()}/api/pull`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name: modelName, stream: true }),
  });

  if (!res.ok || !res.body) {
    throw new Error(`Failed to pull model: ${res.status}`);
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        yield JSON.parse(line);
      } catch { /* skip */ }
    }
  }
}

/**
 * Chat with an Ollama model. Returns full text response.
 */
export async function chatOllama(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  const baseUrl = getBaseUrl();
  const model = opts.model || getModel();

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: false,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama API error ${res.status}: ${body.slice(0, 200)}`);
  }

  const data = await res.json();
  return data.choices?.[0]?.message?.content?.trim() ?? "";
}

/**
 * Stream chat with an Ollama model. Yields text chunks.
 */
export async function* chatOllamaStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, void, undefined> {
  const baseUrl = getBaseUrl();
  const model = opts.model || getModel();

  const res = await fetch(`${baseUrl}/v1/chat/completions`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model,
      messages,
      stream: true,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    }),
    signal: opts.signal,
  });

  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new Error(`Ollama stream error ${res.status}: ${body.slice(0, 200)}`);
  }

  const reader = res.body?.getReader();
  if (!reader) throw new Error("No response body from Ollama");

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() ?? "";

    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed === "data: [DONE]") continue;
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        const delta = json.choices?.[0]?.delta?.content;
        if (delta) yield delta;
      } catch { /* skip */ }
    }
  }
}

/**
 * Generate embeddings via Ollama (for semantic search with local models).
 */
export async function embedOllama(
  text: string,
  model = "nomic-embed-text",
): Promise<number[]> {
  const res = await fetch(`${getBaseUrl()}/api/embed`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ model, input: text }),
  });
  if (!res.ok) throw new Error(`Ollama embed error: ${res.status}`);
  const data = await res.json();
  return data.embeddings?.[0] ?? [];
}
