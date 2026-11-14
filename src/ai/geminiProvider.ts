/**
 * Google Gemini provider.
 *
 * Routes chat/stream calls through the Generative Language API
 * (generativelanguage.googleapis.com). Gemini uses `contents` with a `model`
 * role (not `assistant`) and a separate `systemInstruction`, so the body shape
 * differs from OpenAI — `buildGeminiBody` handles the mapping and is exported
 * for unit testing.
 *
 * Zero external dependencies — native fetch + SSE parsing.
 */

import type { ChatMessage, ChatOptions } from "./llm";
import { assertCloudAllowed } from "./policy";
import { getProviderKey, AiError, PROVIDER_DEFAULT_MODELS, isRetiredGeminiModel } from "./llm";

const BASE = "https://generativelanguage.googleapis.com/v1beta/models";
const DEFAULT_MODEL = PROVIDER_DEFAULT_MODELS.gemini;

export function getGeminiModel(opts: ChatOptions): string {
  if (opts.model) return opts.model;
  try {
    const saved = localStorage.getItem("lumen.ai.model.gemini");
    return saved && !isRetiredGeminiModel(saved) ? saved : DEFAULT_MODEL;
  } catch {
    return DEFAULT_MODEL;
  }
}

interface GeminiBody {
  contents: { role: "user" | "model"; parts: { text: string }[] }[];
  systemInstruction?: { parts: { text: string }[] };
  generationConfig?: { maxOutputTokens?: number; temperature?: number };
}

/** Pure mapping from our ChatMessage[] to the Gemini generateContent body. */
export function buildGeminiBody(messages: ChatMessage[], opts: ChatOptions = {}): GeminiBody {
  const system = messages
    .filter((m) => m.role === "system")
    .map((m) => m.content)
    .join("\n\n");
  const contents = messages
    .filter((m) => m.role !== "system")
    .map((m) => ({
      role: (m.role === "assistant" ? "model" : "user") as "user" | "model",
      parts: [{ text: m.content }],
    }));
  const generationConfig: GeminiBody["generationConfig"] = {};
  if (opts.maxTokens) generationConfig.maxOutputTokens = opts.maxTokens;
  if (opts.temperature !== undefined) generationConfig.temperature = opts.temperature;
  return {
    contents,
    ...(system ? { systemInstruction: { parts: [{ text: system }] } } : {}),
    ...(Object.keys(generationConfig).length ? { generationConfig } : {}),
  };
}

/** `usageMetadata` → the usage meter. */
function reportGeminiUsage(data: unknown, opts: ChatOptions): void {
  const u = (
    data as {
      usageMetadata?: { promptTokenCount?: number; candidatesTokenCount?: number; cachedContentTokenCount?: number; thoughtsTokenCount?: number };
    }
  )?.usageMetadata;
  if (!u || typeof u.promptTokenCount !== "number") return;
  const cached = u.cachedContentTokenCount ?? 0;
  opts.onUsage?.({
    model: getGeminiModel(opts),
    inputTokens: u.promptTokenCount - cached,
    // Thinking tokens are billed as output.
    outputTokens: (u.candidatesTokenCount ?? 0) + (u.thoughtsTokenCount ?? 0),
    ...(cached ? { cacheReadTokens: cached } : {}),
  });
}

function extractText(data: unknown): string {
  const parts =
    (data as { candidates?: { content?: { parts?: { text?: string }[] } }[] })
      ?.candidates?.[0]?.content?.parts ?? [];
  return parts.map((p) => p.text ?? "").join("");
}

export async function chatGemini(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): Promise<string> {
  assertCloudAllowed("Google Gemini");
  const key = getProviderKey("gemini");
  const url = `${BASE}/${getGeminiModel(opts)}:generateContent?key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(messages, opts)),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiError("API_ERROR", `Gemini ${res.status}: ${body.slice(0, 200)}`);
  }
  const data = await res.json();
  // A blocked prompt can return no candidates but still be billed.
  reportGeminiUsage(data, opts);
  const text = extractText(data).trim();
  if (!text) throw new AiError("PARSE_ERROR", "Empty Gemini response.");
  return text;
}

export async function* chatGeminiStream(
  messages: ChatMessage[],
  opts: ChatOptions = {},
): AsyncGenerator<string, void, undefined> {
  assertCloudAllowed("Google Gemini");
  const key = getProviderKey("gemini");
  const url = `${BASE}/${getGeminiModel(opts)}:streamGenerateContent?alt=sse&key=${encodeURIComponent(key)}`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(buildGeminiBody(messages, opts)),
    signal: opts.signal,
  });
  if (!res.ok) {
    const body = await res.text().catch(() => "");
    throw new AiError("API_ERROR", `Gemini stream ${res.status}: ${body.slice(0, 200)}`);
  }
  const reader = res.body?.getReader();
  if (!reader) throw new AiError("API_ERROR", "No response body from Gemini.");
  let lastUsage: unknown = null;
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
      if (!trimmed.startsWith("data: ")) continue;
      try {
        const json = JSON.parse(trimmed.slice(6));
        // Each chunk repeats the running usage; the last one is final.
        if (json?.usageMetadata) lastUsage = json;
        const delta = extractText(json);
        if (delta) yield delta;
      } catch {
        /* why: a keep-alive or partial line that is not JSON carries no text */
      }
    }
  }
  if (lastUsage) reportGeminiUsage(lastUsage, opts);
}
