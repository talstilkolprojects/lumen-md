/**
 * Client of the in-browser LLM worker (./webllm.worker.ts). web-llm and
 * the model live in the worker, on WebGPU: this module is a few KB of
 * message passing, so the main bundle never loads the 6 MB library and a
 * generation never blocks the editor. One worker per tab, created on
 * first use and reused across models.
 *
 * Model weights come from Hugging Face and the wasm from GitHub (both in
 * the CSP connect-src) and are cached by web-llm in Cache Storage.
 */

import type { WorkerChatRequest, WorkerChatResult, WorkerIn, WorkerOut } from "./webllm.worker";
// The window id on the airplane channel (review 2): only this window answers this worker.
import { airplaneWorkerName } from "../privacy/airplaneBoot";

export type { WorkerChatRequest as WebLlmChatRequest, WorkerChatResult as WebLlmChatResult };

export interface LoadProgress {
  progress: number;
  text: string;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
  onDelta?: (text: string) => void;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let loadedModel: string | null = null;
let listeners: Array<(p: LoadProgress) => void> = [];

/** Progress of the current model download / compile, from any caller. */
export function onWebLlmProgress(cb: (p: LoadProgress) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

/** Which model the worker currently holds (null before the first load). */
export function loadedWebLlmModel(): string | null {
  return loadedModel;
}

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./webllm.worker.ts", import.meta.url), { type: "module", name: airplaneWorkerName("webllm") });
  w.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    switch (m.type) {
      case "progress":
        for (const l of listeners) l({ progress: m.progress, text: m.text });
        return;
      case "delta":
        p.onDelta?.(m.text);
        return;
      case "result":
        pending.delete(m.id);
        p.resolve(m.value);
        return;
      case "error":
        pending.delete(m.id);
        p.reject(new Error(m.message));
        return;
    }
  };
  w.onerror = (ev) => {
    // A top-level worker failure (module load, GPU loss) leaves nothing to
    // talk to: reject everything and let the next call start a fresh one.
    failAll(`web-llm worker error: ${ev.message || "unknown"}`);
    if (worker === w) {
      worker = null;
      loadedModel = null;
    }
    w.terminate();
  };
  worker = w;
  return w;
}

type WorkerCall = WorkerIn extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;

function call<T>(msg: WorkerCall, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject, onDelta });
    getWorker().postMessage({ ...msg, id } as WorkerIn);
    if (signal) {
      const onAbort = () => {
        // Reject this call now — its late result (often partial text) is
        // dropped — and tell the worker to stop or skip exactly this chat.
        if (pending.delete(id)) {
          reject(new DOMException("aborted", "AbortError"));
          void call<boolean>({ type: "interrupt", target: id }).catch(() => { /* why: the call is already rejected; a worker that cannot take the interrupt has stopped anyway */ });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = () => signal.removeEventListener("abort", onAbort);
      pending.get(id)!.resolve = (v) => {
        done();
        resolve(v as T);
      };
      pending.get(id)!.reject = (e) => {
        done();
        reject(e);
      };
    }
  });
}

/** Load (download, compile) `modelId`; progress goes to `onWebLlmProgress` listeners. */
export async function loadWebLlmModel(modelId: string): Promise<void> {
  await call<string>({ type: "load", modelId });
  loadedModel = modelId;
}

/** One chat completion on `modelId` (loaded first if needed). Streams deltas when `onDelta` is given. */
export async function webLlmChat(
  modelId: string,
  request: WorkerChatRequest,
  opts: { onDelta?: (text: string) => void; signal?: AbortSignal } = {},
): Promise<WorkerChatResult> {
  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const res = await call<WorkerChatResult>({ type: "chat", modelId, request, stream: !!opts.onDelta }, opts.onDelta, opts.signal);
  loadedModel = modelId;
  return res;
}

/** Is `modelId` already in Cache Storage (no download needed)? */
export async function webLlmModelCached(modelId: string): Promise<boolean> {
  try {
    return await call<boolean>({ type: "hasModel", modelId });
  } catch {
    return false;
  }
}

/** Remove a model's weights, wasm and config from Cache Storage. */
export async function deleteWebLlmModel(modelId: string): Promise<void> {
  await call<boolean>({ type: "deleteModel", modelId });
  if (loadedModel === modelId) loadedModel = null;
}

/** Stop the current generation (no-op when idle). */
export function interruptWebLlm(): void {
  if (worker) void call<boolean>({ type: "interrupt" }).catch(() => { /* why: idle or gone worker: there is nothing to interrupt */ });
}

/** Drop the model and terminate the worker (frees GPU memory). */
export async function unloadWebLlm(): Promise<void> {
  const w = worker;
  if (!w) return;
  try {
    await call<boolean>({ type: "unload" });
  } catch {
    /* why: worker may already be gone */
  }
  worker = null;
  loadedModel = null;
  failAll("web-llm worker unloaded");
  w.terminate();
}

/** Tests. */
export function __resetWebLlmEngine(): void {
  worker = null;
  loadedModel = null;
  pending.clear();
  listeners = [];
}
