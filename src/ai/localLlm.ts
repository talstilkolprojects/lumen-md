/**
 * Local LLM bridge — runs a model entirely in the browser via WebGPU
 * (web-llm), in a Web Worker (see ./webllmEngine.ts). Lets users with a
 * capable GPU keep prompts private and work offline (no network call
 * after the first model download).
 *
 *   - The library and the worker are created on first use, so the regular
 *     bundle stays slim.
 *   - The model comes from the model manager (./modelManager.ts): the
 *     user's choice, or the largest model of the tier that fits this GPU.
 *   - `onLocalLlmProgress(cb)` reports the first download / compile so the
 *     UI can show "Loading Qwen3 4B (35%)…" instead of looking frozen.
 *
 * If WebGPU isn't available, `localLlmAvailable()` returns false; what
 * happens next is the AI policy's decision (./policy.ts).
 */

import type { ChatMessage } from "./llm";
import { detectHardware, webLlmModelFor } from "./modelManager";
import { onWebLlmProgress, unloadWebLlm, webLlmChat } from "./webllmEngine";

export interface LocalLlmStatus {
  available: boolean;
  /** Why local LLM is unavailable, if it is. */
  reason?: string;
}

export function localLlmAvailable(): LocalLlmStatus {
  if (typeof window === "undefined") return { available: false, reason: "Not in browser" };
  if (!("gpu" in navigator)) {
    return { available: false, reason: "WebGPU not supported by this browser" };
  }
  return { available: true };
}

export function onLocalLlmProgress(cb: (p: { progress: number; text: string }) => void): () => void {
  return onWebLlmProgress(cb);
}

/** The model `chatLocal` will use when the caller pins none. */
export async function defaultLocalModel(): Promise<string> {
  return webLlmModelFor("small", await detectHardware());
}

export interface LocalChatOptions {
  model?: string;
  maxTokens?: number;
  temperature?: number;
  signal?: AbortSignal;
}

/**
 * Run a chat completion locally via WebGPU. Mirrors the `chat()` signature
 * from `./llm` so callers can swap providers without touching their code.
 */
export async function chatLocal(messages: ChatMessage[], opts: LocalChatOptions = {}): Promise<string> {
  const status = localLlmAvailable();
  if (!status.available) {
    throw new Error(`Local LLM unavailable: ${status.reason}`);
  }
  const res = await webLlmChat(
    opts.model ?? (await defaultLocalModel()),
    {
      messages,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
    { signal: opts.signal },
  );
  const text = res.content.trim();
  if (!text) throw new Error("Local LLM returned an empty response.");
  return text;
}

/** Stream a local chat completion. Yields text chunks. */
export async function* chatLocalStream(messages: ChatMessage[], opts: LocalChatOptions = {}): AsyncGenerator<string, void, undefined> {
  const status = localLlmAvailable();
  if (!status.available) {
    throw new Error(`Local LLM unavailable: ${status.reason}`);
  }
  // The worker streams deltas through a callback; bridge them into the
  // generator. Closing the generator early (the consumer stops reading)
  // aborts the worker call, so the GPU does not finish an unread answer.
  const buffer: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let failure: Error | null = null;
  const ctrl = new AbortController();
  const onOuterAbort = () => ctrl.abort();
  opts.signal?.addEventListener("abort", onOuterAbort, { once: true });
  if (opts.signal?.aborted) ctrl.abort();
  const run = webLlmChat(
    opts.model ?? (await defaultLocalModel()),
    {
      messages,
      ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
      ...(opts.temperature !== undefined ? { temperature: opts.temperature } : {}),
    },
    {
      signal: ctrl.signal,
      onDelta: (text) => {
        buffer.push(text);
        wake?.();
      },
    },
  );
  run.then(
    () => {
      done = true;
      wake?.();
    },
    (e) => {
      failure = e instanceof Error ? e : new Error(String(e));
      done = true;
      wake?.();
    },
  );
  try {
    for (;;) {
      if (buffer.length) {
        yield buffer.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = null;
    }
    if (failure) throw failure;
  } finally {
    opts.signal?.removeEventListener("abort", onOuterAbort);
    if (!done) ctrl.abort();
  }
}

/** Drop the cached engine — useful when switching models or freeing the GPU. */
export function unloadLocalLlm(): void {
  void unloadWebLlm();
}
