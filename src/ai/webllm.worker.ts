/**
 * web-llm inference worker. The whole library (and the model) lives here,
 * on WebGPU, so the main bundle never loads it and a generation never
 * blocks the editor. `src/ai/webllmEngine.ts` is the client side of this
 * small protocol:
 *
 *   → { id, type: "load",        modelId }
 *   → { id, type: "chat",        modelId, request, stream }
 *   → { id, type: "interrupt", target }        (cancel one chat: skip it if queued, stop it if running)
 *   → { id, type: "unload" }
 *   → { id, type: "hasModel",    modelId }
 *   → { id, type: "deleteModel", modelId }
 *   ← { id, type: "progress", progress, text }   (during a load)
 *   ← { id, type: "delta",    text }             (during a streamed chat)
 *   ← { id, type: "result",   value }
 *   ← { id, type: "error",    message }
 *
 * Loads and chats are serialised; interrupt/unload run immediately.
 */

import "./workerLedgerInstall"; // first: libraries below must see the ledger's fetch (plan 2.4)
import { reportWorkerDownload } from "./workerLedger";
import type { ChatCompletionMessageParam, ChatCompletionTool, MLCEngineInterface, ResponseFormat } from "@mlc-ai/web-llm";

export interface WorkerChatRequest {
  messages: ChatCompletionMessageParam[];
  temperature?: number;
  max_tokens?: number;
  response_format?: ResponseFormat;
  tools?: ChatCompletionTool[];
}

export interface WorkerChatResult {
  content: string;
  tool_calls: unknown[];
  model: string;
  usage?: { prompt_tokens: number; completion_tokens: number };
}

export type WorkerIn =
  | { id: number; type: "load"; modelId: string }
  | { id: number; type: "chat"; modelId: string; request: WorkerChatRequest; stream: boolean }
  | { id: number; type: "interrupt"; target?: number }
  | { id: number; type: "unload" }
  | { id: number; type: "hasModel"; modelId: string }
  | { id: number; type: "deleteModel"; modelId: string };

export type WorkerOut =
  | { id: number; type: "progress"; progress: number; text: string }
  | { id: number; type: "delta"; text: string }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; message: string };

const post = (m: WorkerOut): void => (self as unknown as { postMessage(m: WorkerOut): void }).postMessage(m);

let engine: MLCEngineInterface | null = null;
let loadedModel: string | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** The chat currently running (loading or generating), whether it is past the load, and chats cancelled before they generate. */
let running: number | null = null;
let generating = false;
const cancelled = new Set<number>();

async function ensureLoaded(id: number, modelId: string): Promise<MLCEngineInterface> {
  if (engine && loadedModel === modelId) return engine;
  const mod = await import("@mlc-ai/web-llm");
  // web-llm stores weights with Cache.add(), which the ledger's fetch never
  // sees: report the download here when the model is not cached yet. Prebuilt
  // weights live under huggingface.co/mlc-ai/<id> (plan 2.4).
  // why: a failed probe counts as "not cached" — better an extra ledger line than a missing one
  const cached = await Promise.resolve()
    .then(() => mod.hasModelInCache(modelId))
    .catch(() => false);
  const settle = cached ? null : reportWorkerDownload(`https://huggingface.co/mlc-ai/${encodeURIComponent(modelId)}/resolve/main/`);
  const initProgressCallback = (r: { progress: number; text: string }) => post({ id, type: "progress", progress: r.progress, text: r.text });
  try {
    if (!engine) {
      engine = await mod.CreateMLCEngine(modelId, { initProgressCallback });
    } else {
      engine.setInitProgressCallback(initProgressCallback);
      await engine.reload(modelId);
    }
    settle?.(200);
  } catch (err) {
    settle?.(0); // the download (or the load after it) failed: not a success in the ledger
    throw err;
  }
  loadedModel = modelId;
  return engine;
}

async function chat(id: number, modelId: string, request: WorkerChatRequest, stream: boolean): Promise<WorkerChatResult> {
  const e = await ensureLoaded(id, modelId);
  // An interrupt that arrived during the (possibly long) load could not
  // stop a generation: it was recorded instead, and ends the chat here.
  if (cancelled.delete(id)) throw new DOMException("aborted", "AbortError");
  generating = true;
  if (stream) {
    const it = await e.chat.completions.create({ ...request, stream: true, stream_options: { include_usage: true } });
    let content = "";
    let usage: WorkerChatResult["usage"];
    let model = modelId;
    for await (const chunk of it) {
      const delta = chunk.choices?.[0]?.delta?.content;
      if (delta) {
        content += delta;
        post({ id, type: "delta", text: delta });
      }
      if (chunk.model) model = chunk.model;
      if (chunk.usage) usage = { prompt_tokens: chunk.usage.prompt_tokens, completion_tokens: chunk.usage.completion_tokens };
    }
    return { content, tool_calls: [], model, usage };
  }
  const res = await e.chat.completions.create({ ...request, stream: false });
  const msg = res.choices?.[0]?.message;
  return {
    content: msg?.content ?? "",
    tool_calls: (msg?.tool_calls as unknown[] | undefined) ?? [],
    model: res.model ?? modelId,
    usage: res.usage ? { prompt_tokens: res.usage.prompt_tokens, completion_tokens: res.usage.completion_tokens } : undefined,
  };
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => undefined);
  return p;
}

export async function handle(msg: WorkerIn): Promise<void> {
  const { id } = msg;
  try {
    switch (msg.type) {
      case "load":
        await serial(() => ensureLoaded(id, msg.modelId));
        post({ id, type: "result", value: msg.modelId });
        return;
      case "chat": {
        const value = await serial(async () => {
          if (cancelled.delete(id)) throw new DOMException("aborted", "AbortError");
          running = id;
          try {
            return await chat(id, msg.modelId, msg.request, msg.stream);
          } finally {
            running = null;
            generating = false;
          }
        });
        post({ id, type: "result", value });
        return;
      }
      case "interrupt":
        // Only the targeted chat is affected: stop it when it is the one
        // generating, skip it when it is still queued. Without a target
        // (legacy), stop whatever runs.
        if (msg.target === undefined) engine?.interruptGenerate();
        else if (msg.target === running && generating) engine?.interruptGenerate();
        else cancelled.add(msg.target);
        post({ id, type: "result", value: true });
        return;
      case "unload": {
        const e = engine;
        engine = null;
        loadedModel = null;
        await e?.unload();
        post({ id, type: "result", value: true });
        return;
      }
      case "hasModel": {
        const mod = await import("@mlc-ai/web-llm");
        post({ id, type: "result", value: await mod.hasModelInCache(msg.modelId) });
        return;
      }
      case "deleteModel": {
        const mod = await import("@mlc-ai/web-llm");
        if (loadedModel === msg.modelId) {
          const e = engine;
          engine = null;
          loadedModel = null;
          await e?.unload();
        }
        await mod.deleteModelAllInfoInCache(msg.modelId);
        post({ id, type: "result", value: true });
        return;
      }
    }
  } catch (e) {
    post({ id, type: "error", message: (e as Error)?.message ?? String(e) });
  }
}

self.onmessage = (ev: MessageEvent<WorkerIn>) => {
  void handle(ev.data);
};
