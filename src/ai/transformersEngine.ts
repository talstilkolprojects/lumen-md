/**
 * Client of the transformers.js worker (./transformers.worker.ts): speech
 * recognition and text embeddings on this device. The library, ONNX
 * Runtime and the models live in the worker; this module is message
 * passing plus the model choice by hardware.
 *
 *   transcribeAudio(samples, { language })  → { text, language? }
 *   embedTextsLocal(texts)                  → { vectors, dims }
 *
 * Models (Hugging Face `onnx-community`, cached in the browser):
 *   Whisper   WebGPU: whisper-small (~250 MB), whisper-large-v3-turbo on a
 *             strong GPU (~800 MB); wasm: whisper-tiny (~40 MB). All three
 *             are multilingual (Hebrew included).
 *   Embeddings multilingual-e5-small (384 dims, ~100 languages).
 */

import type { CaptionFamily, Device, EmbedResult, TranscribeResult, WorkerIn, WorkerOut } from "./transformers.worker";
import { detectHardware, vramBudgetMB, type Hardware } from "./modelManager";

export type { TranscribeResult, EmbedResult };

export const WHISPER_MODELS = {
  tiny: "onnx-community/whisper-tiny",
  base: "onnx-community/whisper-base",
  small: "onnx-community/whisper-small",
  turbo: "onnx-community/whisper-large-v3-turbo",
  /** ivrit.ai's Hebrew fine-tune of turbo, ONNX (q4f16 ≈ 563 MB, WebGPU). */
  turboHe: "ivrit-ai/whisper-large-v3-turbo-onnx",
} as const;

/** VRAM the Hebrew turbo needs (563 MB of q4f16 weights + activations), MB. */
export const TURBO_HE_VRAM_MB = 1_200;

export const EMBEDDING_MODEL = "Xenova/multilingual-e5-small";
export const EMBEDDING_DIMS = 384;
/** Multilingual cross-encoder (Hebrew included) for reranking search hits (T29). */
export const RERANK_MODEL = "onnx-community/bge-reranker-v2-m3-ONNX";
/**
 * Layer 3 of local translation (plan 6.4): M2M100-418M (MIT) for the pairs
 * the converted Opus-MT models do not cover. ≈ 630 MB (q8) from Hugging
 * Face, downloaded only after the consent dialog. The non-commercial
 * alternative is on the registry's deny-list.
 */
export const M2M100_MODEL = "Xenova/m2m100_418M";
export const M2M100_BYTES = 630_000_000;

export interface DownloadProgress {
  file: string;
  /** 0–100 for the current file. */
  progress: number;
  loaded: number;
  total: number;
}

interface Pending {
  resolve: (v: unknown) => void;
  reject: (e: Error) => void;
}

/** Safari / WebKit (not Chrome or Edge on iOS, which are WebKit too but report themselves). */
export function isWebKit(ua: string = typeof navigator !== "undefined" ? navigator.userAgent : ""): boolean {
  return /AppleWebKit/i.test(ua) && /Version\/[\d.]+.*Safari/i.test(ua) && !/Chrome|Chromium|CriOS|Edg|OPR|Firefox|FxiOS/i.test(ua);
}

/**
 * ONNX Runtime build: the `.asyncify` build carries the WebGPU runtime;
 * on WebKit it is known to balloon memory and kill the tab, so Safari
 * gets the plain wasm build (and the wasm device).
 */
export function ortSuffixFor(webkit: boolean = isWebKit()): ".asyncify" | "" {
  return webkit ? "" : ".asyncify";
}

/** Where the staged ONNX Runtime files are served from (public/ort/ under the Vite base). */
export function ortBaseUrl(base: string = import.meta.env?.BASE_URL ?? "/"): string {
  const origin = typeof location !== "undefined" ? location.origin : "http://localhost";
  return new URL(`${base.endsWith("/") ? base : base + "/"}ort/`, origin).href;
}

let worker: Worker | null = null;
let seq = 0;
const pending = new Map<number, Pending>();
let listeners: Array<(p: DownloadProgress) => void> = [];

export function onTransformersProgress(cb: (p: DownloadProgress) => void): () => void {
  listeners.push(cb);
  return () => {
    listeners = listeners.filter((l) => l !== cb);
  };
}

function failAll(message: string): void {
  for (const p of pending.values()) p.reject(new Error(message));
  pending.clear();
}

function getWorker(): Worker {
  if (worker) return worker;
  const w = new Worker(new URL("./transformers.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (ev: MessageEvent<WorkerOut>) => {
    const m = ev.data;
    const p = pending.get(m.id);
    if (!p) return;
    if (m.type === "progress") {
      for (const l of listeners) l({ file: m.file, progress: m.progress, loaded: m.loaded, total: m.total });
      return;
    }
    pending.delete(m.id);
    if (m.type === "result") p.resolve(m.value);
    else p.reject(new Error(m.message));
  };
  w.onerror = (ev) => {
    // A failed startup (module, ONNX runtime) leaves nothing to talk to:
    // reject everything and let the next call create a fresh worker.
    failAll(`transformers worker error: ${ev.message || "unknown"}`);
    if (worker === w) worker = null;
    w.terminate();
  };
  worker = w;
  return w;
}

type WorkerCall = WorkerIn extends infer M ? (M extends { id: number } ? Omit<M, "id"> : never) : never;

function call<T>(msg: WorkerCall, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
  // Aborted while the caller was still preparing (e.g. awaiting the
  // hardware probe): nothing is posted, so no download or inference starts.
  if (signal?.aborted) return Promise.reject(new DOMException("aborted", "AbortError"));
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    const entry: Pending = { resolve: resolve as (v: unknown) => void, reject };
    pending.set(id, entry);
    getWorker().postMessage({ ...msg, id, ortBase: ortBaseUrl(), ortSuffix: ortSuffixFor() }, transfer);
    if (signal) {
      const onAbort = () => {
        // Reject now and tell the worker to skip (queued) or discard (running) this job.
        if (pending.delete(id)) {
          reject(new DOMException("aborted", "AbortError"));
          getWorker().postMessage({ type: "cancel", id: ++seq, target: id, ortBase: ortBaseUrl(), ortSuffix: ortSuffixFor() });
        }
      };
      signal.addEventListener("abort", onAbort, { once: true });
      const done = () => signal.removeEventListener("abort", onAbort);
      entry.resolve = (v) => {
        done();
        resolve(v as T);
      };
      entry.reject = (e) => {
        done();
        reject(e);
      };
    }
  });
}

/** WebGPU when the adapter is usable (never on WebKit, see ortSuffixFor), else wasm (always available). */
export async function transformersDevice(hw?: Hardware): Promise<Device> {
  const h = hw ?? (await detectHardware());
  return h.webgpu && !isWebKit() ? "webgpu" : "wasm";
}

/**
 * The Whisper model for this device: turbo needs a real GPU budget and f16
 * (its encoder loads as fp16: the fp32 one is over the mirror's 2 GiB per
 * file, plan W6.33), small fits most laptops, tiny for wasm.
 */
export function whisperModelFor(hw: Hardware, device: Device = hw.webgpu ? "webgpu" : "wasm"): string {
  if (device !== "webgpu") return WHISPER_MODELS.tiny;
  return vramBudgetMB(hw) >= 6_000 && !hw.mobile && hw.f16 ? WHISPER_MODELS.turbo : WHISPER_MODELS.small;
}

/**
 * The Whisper model for files and recordings in a known language (plan 6.1):
 * Hebrew gets ivrit.ai's turbo on a GPU with f16 and the VRAM for it, else
 * whisper-base (77 MB, q8 on wasm) — tiny is too weak for Hebrew. Other
 * languages keep whisperModelFor.
 */
export function whisperModelForLanguage(hw: Hardware, device: Device, language: string | undefined): string {
  if (language !== "he") return whisperModelFor(hw, device);
  if (device === "webgpu" && hw.f16 && !hw.mobile && vramBudgetMB(hw) >= TURBO_HE_VRAM_MB) return WHISPER_MODELS.turboHe;
  return WHISPER_MODELS.base;
}

/** Transcribe 16 kHz mono PCM. `language` is an ISO-639-1 code ("he", "en"); omitted = auto-detect. */
export async function transcribeAudio(samples: Float32Array, opts: { language?: string; model?: string; signal?: AbortSignal } = {}): Promise<TranscribeResult> {
  if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
  const hw = await detectHardware();
  const device = await transformersDevice(hw);
  const model = opts.model ?? whisperModelForLanguage(hw, device, opts.language);
  // The buffer is transferred, not copied; callers must not reuse it.
  return call<TranscribeResult>({ type: "transcribe", model, device, audio: samples, language: opts.language, task: "transcribe" }, [samples.buffer], opts.signal);
}

/** Normalised embeddings (mean pooled) for `texts`. */
export async function embedTextsLocal(texts: string[], opts: { model?: string } = {}): Promise<EmbedResult> {
  if (!texts.length) return { vectors: [], dims: EMBEDDING_DIMS };
  const device = await transformersDevice();
  return call<EmbedResult>({ type: "embed", model: opts.model ?? EMBEDDING_MODEL, device, texts });
}

/** Relevance of each passage to `query`, 0..1, from the local cross-encoder. */
export async function rerankLocal(query: string, passages: string[], opts: { model?: string; signal?: AbortSignal } = {}): Promise<number[]> {
  if (!passages.length) return [];
  const device = await transformersDevice();
  return call<number[]>({ type: "rerank", model: opts.model ?? RERANK_MODEL, device, query, passages }, [], opts.signal);
}

/** Token labels of a NER model for each text (plan 2.6). The model must already be cached (consent, plan 6.0). */
export async function nerLocal(texts: string[], model: string, opts: { signal?: AbortSignal } = {}): Promise<Array<Array<{ entity: string; word: string; score: number; index?: number }>>> {
  if (!texts.length) return [];
  const device = await transformersDevice();
  return call({ type: "ner", model, device, texts }, [], opts.signal);
}

/** Download / compile a model ahead of time. */
export async function preloadTransformersModel(task: "automatic-speech-recognition" | "feature-extraction", model?: string): Promise<string> {
  const hw = await detectHardware();
  const device = await transformersDevice(hw);
  const id = model ?? (task === "automatic-speech-recognition" ? whisperModelFor(hw, device) : EMBEDDING_MODEL);
  return call<string>({ type: "load", task, model: id, device });
}

export interface TranslateLocalOptions {
  /** A model Lumen hosts itself: its files come from `${host}${model}/` (src/ai/convertedModels.ts). */
  host?: string;
  dtype?: "q8" | "q4f16";
  /** For multilingual models (M2M100); Opus-MT models ignore them. */
  srcLang?: string;
  tgtLang?: string;
  device?: Device;
  signal?: AbortSignal;
}

/** Plain-text segments → translations by a local model in the worker (plan 6.4). */
export async function translateLocal(model: string, texts: string[], opts: TranslateLocalOptions = {}): Promise<string[]> {
  if (!texts.length) return [];
  const device = opts.device ?? (await transformersDevice());
  return call<string[]>({ type: "translate", model, device, dtype: opts.dtype, texts, srcLang: opts.srcLang, tgtLang: opts.tgtLang, host: opts.host }, [], opts.signal);
}

/** The dtype a translation model runs in on this device (what the consent dialog sizes). */
export function translationDtypeFor(device: Device): "q8" | "q4f16" {
  return device === "webgpu" ? "q4f16" : "q8";
}

/** Free the models and terminate the worker. */
export async function unloadTransformers(): Promise<void> {
  const w = worker;
  if (!w) return;
  try {
    await call<boolean>({ type: "unload" });
  } catch {
    /* why: worker may already be gone */
  }
  worker = null;
  failAll("transformers worker unloaded");
  w.terminate();
}

/**
 * Decode any audio blob the browser can play into 16 kHz mono PCM, the
 * input Whisper expects. Runs on the main thread: workers have no
 * AudioContext.
 */
export async function decodeAudioTo16k(blob: Blob): Promise<Float32Array> {
  const Ctx = (globalThis as { OfflineAudioContext?: typeof OfflineAudioContext; AudioContext?: typeof AudioContext }).AudioContext;
  if (!Ctx) throw new Error("Web Audio is not available in this browser");
  const ctx = new Ctx({ sampleRate: 16_000 });
  try {
    const decoded = await ctx.decodeAudioData(await blob.arrayBuffer());
    if (decoded.numberOfChannels === 1 && decoded.sampleRate === 16_000) return decoded.getChannelData(0).slice();
    const length = Math.ceil(decoded.duration * 16_000);
    const offline = new OfflineAudioContext(1, length, 16_000);
    const src = offline.createBufferSource();
    src.buffer = decoded;
    src.connect(offline.destination);
    src.start();
    const rendered = await offline.startRendering();
    return rendered.getChannelData(0).slice();
  } finally {
    await ctx.close().catch(() => { /* why: the samples are already rendered; a context that fails to close is collected with the page */ });
  }
}

/** Tests. */
export function __resetTransformersEngine(): void {
  worker = null;
  pending.clear();
  listeners = [];
}

/** One English caption for an image by a local vision model in the worker (plan 6.6). */
export async function captionLocal(model: string, family: CaptionFamily, image: Blob, opts: { device?: Device; signal?: AbortSignal } = {}): Promise<string> {
  const device = opts.device ?? (await transformersDevice());
  return call<string>({ type: "caption", model, family, device, image }, [], opts.signal);
}
/** SigLIP image vectors (plan 6.7), unit length, from Lumen's converted-model host. */
export async function embedImagesLocal(model: string, images: Blob[], opts: { host: string; dtype?: string; signal?: AbortSignal }): Promise<number[][]> {
  const device = await transformersDevice();
  return call<number[][]>({ type: "imageEmbed", model, device, images, host: opts.host, dtype: opts.dtype ?? translationDtypeFor(device) }, [], opts.signal);
}

/** SigLIP text vectors in the same space as embedImagesLocal(). */
export async function embedTextsForImagesLocal(model: string, texts: string[], opts: { host: string; dtype?: string; signal?: AbortSignal }): Promise<number[][]> {
  const device = await transformersDevice();
  return call<number[][]>({ type: "textEmbedForImages", model, device, texts, host: opts.host, dtype: opts.dtype ?? translationDtypeFor(device) }, [], opts.signal);
}

