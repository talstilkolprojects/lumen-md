/**
 * transformers.js worker — speech recognition (Whisper) and text
 * embeddings on this device, through ONNX Runtime on WebGPU or wasm.
 * The library (~1 MB) and the models live here; `src/ai/transformersEngine.ts`
 * is the client side of this protocol:
 *
 *   → { id, type: "transcribe", model, device, audio: Float32Array (16 kHz mono), language?, task? }
 *   → { id, type: "embed",      model, device, texts: string[] }
 *   → { id, type: "rerank",     model, device, query, passages: string[] }  → scores 0..1 (T29)
 *   → { id, type: "caption",    model, device, family: "florence2" | "smolvlm", image: Blob }  → one English sentence (plan 6.6)
 *   → { id, type: "ner",        model, device, texts: string[] }      → token labels per text (plan 2.6)
 *   → { id, type: "imageEmbed", model, device, dtype?, host?, images: Blob[] }  → unit vectors (SigLIP vision tower, plan 6.7)
 *   → { id, type: "textEmbedForImages", model, device, dtype?, host?, texts }  → unit vectors in the same space
 *   → { id, type: "load",       task, model, device }
 *   → { id, type: "cancel",     target }         (skip a queued job, discard a running one's result)
 *   → { id, type: "unload" }
 *   ← { id, type: "progress", file, progress, loaded, total }   (model download)
 *   ← { id, type: "result",   value }
 *   ← { id, type: "error",    message }
 *
 * ONNX Runtime's wasm comes from this origin (public/ort/, staged by
 * scripts/copy-ort.mjs): the app's CSP allows no CDN. Model files come from
 * huggingface.co and are cached in the browser by the library.
 */

import "./workerLedgerInstall"; // first: libraries below must see the ledger's fetch (plan 2.4)
import {
  AutoModelForSequenceClassification,
  AutoModelForVision2Seq,
  AutoProcessor,
  SiglipTextModel,
  SiglipVisionModel,
  AutoTokenizer,
  Florence2ForConditionalGeneration,
  RawImage,
  env,
  pipeline,
  type AutomaticSpeechRecognitionPipeline,
  type FeatureExtractionPipeline,
  type TranslationPipeline,
  type TokenClassificationPipeline,
  type PreTrainedModel,
  type PreTrainedTokenizer,
} from "@huggingface/transformers";

export type Device = "webgpu" | "wasm";
/** Florence-2 (task prompt `<CAPTION>`) or SmolVLM (chat template). */
export type CaptionFamily = "florence2" | "smolvlm";

export type WorkerIn =
  | { id: number; type: "transcribe"; model: string; device: Device; audio: Float32Array; language?: string; task?: "transcribe" | "translate" }
  | { id: number; type: "embed"; model: string; device: Device; texts: string[] }
  | { id: number; type: "rerank"; model: string; device: Device; query: string; passages: string[] }
  /**
   * Translation (plan 6.4). `host`: the model is one Lumen converted and
   * hosts itself (src/ai/convertedModels.ts): its files come from
   * `${host}${model}/` and go into the verified OPFS cache (./modelCache.ts).
   * Without it the model is fetched from Hugging Face like the others.
   * `srcLang` / `tgtLang`: for multilingual models (M2M100); Opus-MT ignores them.
   */
  | { id: number; type: "translate"; model: string; device: Device; dtype?: string; texts: string[]; srcLang?: string; tgtLang?: string; host?: string }
  | { id: number; type: "caption"; model: string; device: Device; family: CaptionFamily; image: Blob }
  | { id: number; type: "ner"; model: string; device: Device; texts: string[] }
  /** SigLIP (plan 6.7): images and texts into one space, for image search. `host`: Lumen's converted-model host. */
  | { id: number; type: "imageEmbed"; model: string; device: Device; dtype?: string; host?: string; images: Blob[] }
  | { id: number; type: "textEmbedForImages"; model: string; device: Device; dtype?: string; host?: string; texts: string[] }
  | { id: number; type: "load"; task: "automatic-speech-recognition" | "feature-extraction" | "translation"; model: string; device: Device; dtype?: string; host?: string }
  | { id: number; type: "cancel"; target: number }
  | { id: number; type: "unload" };

export type WorkerOut =
  | { id: number; type: "progress"; file: string; progress: number; loaded: number; total: number }
  | { id: number; type: "result"; value: unknown }
  | { id: number; type: "error"; message: string };

export interface TranscribeResult {
  text: string;
  /** Detected (or requested) language code when the model reports one. */
  language?: string;
}

export interface EmbedResult {
  vectors: number[][];
  dims: number;
}

const post = (m: WorkerOut): void => (self as unknown as { postMessage(m: WorkerOut): void }).postMessage(m);

/** Same-origin ONNX Runtime files (see scripts/copy-ort.mjs). */
export function configureOrt(baseUrl: string, suffix: ".asyncify" | "" = ".asyncify"): void {
  env.allowLocalModels = false;
  env.useBrowserCache = true;
  env.useWasmCache = true;
  const onnx = env.backends.onnx as { wasm?: { wasmPaths?: unknown; numThreads?: number } } | undefined;
  if (onnx?.wasm) {
    onnx.wasm.wasmPaths = {
      mjs: `${baseUrl}ort-wasm-simd-threaded${suffix}.mjs`,
      wasm: `${baseUrl}ort-wasm-simd-threaded${suffix}.wasm`,
    };
  }
}

let asr: { key: string; pipe: AutomaticSpeechRecognitionPipeline } | null = null;
let embedder: { key: string; pipe: FeatureExtractionPipeline } | null = null;
let reranker: { key: string; tokenizer: PreTrainedTokenizer; model: PreTrainedModel } | null = null;
let translator: { key: string; pipe: TranslationPipeline } | null = null;
type Captioner = { key: string; processor: CaptionProcessor; model: PreTrainedModel };
let captioner: Captioner | null = null;
let ner: { key: string; pipe: TokenClassificationPipeline } | null = null;
let queue: Promise<unknown> = Promise.resolve();
/** Jobs cancelled by the client: skipped when queued, their result discarded when running. */
const cancelled = new Set<number>();

/** Whisper's window. Longer audio is cut into windows and transcribed one call at a time. */
export const WINDOW_SECONDS = 30;
const SAMPLE_RATE = 16_000;

function progressFor(id: number) {
  return (info: { status?: string; file?: string; progress?: number; loaded?: number; total?: number }) => {
    if (info.status === "progress" && typeof info.progress === "number") {
      post({ id, type: "progress", file: info.file ?? "", progress: info.progress, loaded: info.loaded ?? 0, total: info.total ?? 0 });
    }
  };
}

/**
 * Before transformers.js loads a model whose files models/registry.json pins
 * (plan W4.14), put them into its cache from the first source that serves
 * the right bytes: Hugging Face, Lumen's mirror, the user's own URL. Each
 * file is checked against its sha256; the library then reads them from the
 * cache and makes no request of its own. Nothing pinned: nothing happens.
 */
async function verifiedPrefill(id: number, model: string, dtype: string | Record<string, string> | undefined): Promise<void> {
  const { prefillFor, loadHostedModels, findHosted, hostedBytes, wantsFile } = await import("./modelHosting");
  const models = await loadHostedModels();
  const filter = (f: { path: string }) => wantsFile(f.path, dtype);
  const entry = findHosted(models, model);
  const total = entry ? hostedBytes(entry, filter) : 0;
  let loaded = 0;
  await prefillFor(model, {
    models,
    filter,
    onBytes: (n) => {
      loaded += n;
      if (total > 0) post({ id, type: "progress", file: "", progress: Math.min(100, Math.round((loaded / total) * 100)), loaded, total });
    },
  });
}

/**
 * Whisper on WebGPU: fp32 encoder + q4 decoder is the library's recommended
 * split; ivrit.ai's Hebrew turbo ships q4f16 for both (≈ 563 MB); wasm: q8.
 */
export function asrOptions(device: Device, model = "") {
  if (device !== "webgpu") return { device, dtype: "q8" };
  if (model === "ivrit-ai/whisper-large-v3-turbo-onnx") return { device, dtype: { encoder_model: "q4f16", decoder_model_merged: "q4f16" } };
  return { device, dtype: { encoder_model: "fp32", decoder_model_merged: "q4" } };
}

async function getAsr(id: number, model: string, device: Device): Promise<AutomaticSpeechRecognitionPipeline> {
  const key = `${model}@${device}`;
  if (asr?.key === key) return asr.pipe;
  if (asr) await asr.pipe.dispose();
  asr = null;
  await verifiedPrefill(id, model, asrOptions(device, model).dtype);
  const pipe = (await pipeline("automatic-speech-recognition", model, { ...asrOptions(device, model), progress_callback: progressFor(id) } as never)) as AutomaticSpeechRecognitionPipeline;
  asr = { key, pipe };
  return pipe;
}

async function getEmbedder(id: number, model: string, device: Device): Promise<FeatureExtractionPipeline> {
  const key = `${model}@${device}`;
  if (embedder?.key === key) return embedder.pipe;
  if (embedder) await embedder.pipe.dispose();
  embedder = null;
  const dtype = device === "webgpu" ? "fp32" : "q8";
  await verifiedPrefill(id, model, dtype);
  const pipe = (await pipeline("feature-extraction", model, { device, dtype, progress_callback: progressFor(id) } as never)) as FeatureExtractionPipeline;
  embedder = { key, pipe };
  return pipe;
}

/**
 * Cut audio into Whisper-sized windows at the quietest sample near each
 * boundary (within ±2 s), so a cut rarely lands mid-word. The library's
 * own `chunk_length_s` path is avoided: with the WebGPU backend it leaks
 * GPU memory per chunk (transformers.js #1739), and one call per window
 * does not.
 */
export function windowsOf(audio: Float32Array, windowSeconds = WINDOW_SECONDS, sampleRate = SAMPLE_RATE): Float32Array[] {
  const size = windowSeconds * sampleRate;
  if (audio.length <= size) return [audio];
  const out: Float32Array[] = [];
  const slack = 2 * sampleRate;
  let start = 0;
  while (audio.length - start > size) {
    const target = start + size;
    let cut = target;
    let quietest = Infinity;
    for (let i = Math.max(start + size - slack, start + 1); i < Math.min(target + slack, audio.length); i += 160) {
      let energy = 0;
      for (let j = i; j < Math.min(i + 160, audio.length); j++) energy += audio[j] * audio[j];
      if (energy < quietest) {
        quietest = energy;
        cut = i;
      }
    }
    out.push(audio.subarray(start, cut));
    start = cut;
  }
  out.push(audio.subarray(start));
  return out;
}

async function transcribe(id: number, msg: Extract<WorkerIn, { type: "transcribe" }>): Promise<TranscribeResult> {
  const pipe = await getAsr(id, msg.model, msg.device);
  const kwargs = { ...(msg.language ? { language: msg.language } : {}), task: msg.task ?? "transcribe" };
  const parts: string[] = [];
  let language: string | undefined;
  for (const window of windowsOf(msg.audio)) {
    if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
    const out = (await pipe(window, kwargs)) as { text?: string; language?: string } | Array<{ text?: string }>;
    parts.push(Array.isArray(out) ? out.map((o) => o.text ?? "").join(" ") : (out.text ?? ""));
    if (!Array.isArray(out) && out.language && !language) language = out.language;
  }
  const text = parts.map((p) => p.trim()).filter(Boolean).join(" ");
  return { text, ...(language ? { language } : {}) };
}

async function embed(id: number, msg: Extract<WorkerIn, { type: "embed" }>): Promise<EmbedResult> {
  const pipe = await getEmbedder(id, msg.model, msg.device);
  const tensor = await pipe(msg.texts, { pooling: "mean", normalize: true });
  const vectors = tensor.tolist() as number[][];
  return { vectors, dims: vectors[0]?.length ?? 0 };
}

/** Cross-encoder reranking (bge-reranker-v2-m3): one relevance score per passage. */
async function rerank(id: number, msg: Extract<WorkerIn, { type: "rerank" }>): Promise<number[]> {
  const key = `${msg.model}@${msg.device}`;
  if (reranker?.key !== key) {
    if (reranker) await reranker.model.dispose();
    reranker = null;
    const dtype = msg.device === "webgpu" ? "fp16" : "q8";
    await verifiedPrefill(id, msg.model, dtype);
    const opts = { device: msg.device, dtype, progress_callback: progressFor(id) } as never;
    const [tokenizer, model] = await Promise.all([
      AutoTokenizer.from_pretrained(msg.model, { progress_callback: progressFor(id) } as never),
      AutoModelForSequenceClassification.from_pretrained(msg.model, opts),
    ]);
    reranker = { key, tokenizer, model };
  }
  const scores: number[] = [];
  // Small batches keep memory flat on long result lists.
  for (let i = 0; i < msg.passages.length; i += 8) {
    if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
    const batch = msg.passages.slice(i, i + 8);
    const inputs = reranker.tokenizer(new Array(batch.length).fill(msg.query), { text_pair: batch, padding: true, truncation: true, max_length: 512 } as never);
    const { logits } = (await reranker.model(inputs)) as { logits: { sigmoid(): { tolist(): number[][] } } };
    for (const row of logits.sigmoid().tolist()) scores.push(row[0] ?? 0);
  }
  return scores;
}

/**
 * Load a model Lumen hosts itself: transformers.js reads `remoteHost` and
 * `remotePathTemplate` from its global env, so they are set for the load and
 * put back after it. Jobs run one at a time (serial), so nothing else loads
 * meanwhile. The verified OPFS cache is installed once, for the host's URLs
 * only; every other URL still goes to the Cache API.
 */
let cacheInstalledFor: string | null = null;
async function withHost<T>(host: string | undefined, fn: () => Promise<T>): Promise<T> {
  if (!host) return fn();
  const e = env as unknown as { remoteHost: string; remotePathTemplate: string; customCache?: unknown; useCustomCache?: boolean };
  if (cacheInstalledFor !== host) {
    const [{ createModelCache }, { loadConvertedRegistry }] = await Promise.all([import("./modelCache"), import("./convertedModels")]);
    const registry = await loadConvertedRegistry();
    e.customCache = createModelCache({
      base: host,
      registry,
      root: () => navigator.storage.getDirectory(),
      fallback: () => caches.open("transformers-cache"),
    });
    e.useCustomCache = true;
    cacheInstalledFor = host;
  }
  const saved = { remoteHost: e.remoteHost, remotePathTemplate: e.remotePathTemplate };
  e.remoteHost = host;
  e.remotePathTemplate = "{model}/";
  try {
    return await fn();
  } finally {
    e.remoteHost = saved.remoteHost;
    e.remotePathTemplate = saved.remotePathTemplate;
  }
}

async function getTranslator(id: number, msg: { model: string; device: Device; dtype?: string; host?: string }): Promise<TranslationPipeline> {
  const dtype = msg.dtype ?? (msg.device === "webgpu" ? "q4f16" : "q8");
  const key = `${msg.model}@${msg.device}@${dtype}`;
  if (translator?.key === key) return translator.pipe;
  if (translator) await translator.pipe.dispose();
  translator = null;
  const pipe = (await withHost(msg.host, () => pipeline("translation", msg.model, { device: msg.device, dtype, progress_callback: progressFor(id) } as never))) as TranslationPipeline;
  translator = { key, pipe };
  return pipe;
}

/** Translate `texts` in small batches (memory stays flat; a cancel lands between batches). */
async function translate(id: number, msg: Extract<WorkerIn, { type: "translate" }>): Promise<string[]> {
  const pipe = await getTranslator(id, msg);
  const out: string[] = [];
  const kwargs = { ...(msg.srcLang ? { src_lang: msg.srcLang } : {}), ...(msg.tgtLang ? { tgt_lang: msg.tgtLang } : {}), max_new_tokens: 512 };
  for (let i = 0; i < msg.texts.length; i += 4) {
    if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
    const batch = msg.texts.slice(i, i + 4);
    const res = (await pipe(batch, kwargs as never)) as Array<{ translation_text?: string }> | { translation_text?: string };
    const rows = Array.isArray(res) ? res : [res];
    for (const r of rows) out.push(r.translation_text ?? "");
    post({ id, type: "progress", file: "", progress: Math.round(((i + batch.length) / msg.texts.length) * 100), loaded: i + batch.length, total: msg.texts.length });
  }
  return out;
}

/** The processor calls the two caption families use (typed loosely: they differ per model). */
interface CaptionProcessor {
  (...args: unknown[]): Promise<Record<string, unknown> & { input_ids?: { dims: number[] } }>;
  construct_prompts?: (task: string) => string[];
  post_process_generation?: (text: string, task: string, size: unknown) => Record<string, string>;
  apply_chat_template?: (messages: unknown, opts: unknown) => string;
  batch_decode: (ids: unknown, opts: unknown) => string[];
}

/**
 * Per-part precision: the vision encoder and embeddings stay fp16 (q4 there
 * costs most of the quality), the language parts are 4-bit. On wasm, q8.
 */
function captionDtype(family: CaptionFamily, device: Device): Record<string, string> | string {
  if (device !== "webgpu") return "q8";
  return family === "florence2"
    ? { embed_tokens: "fp16", vision_encoder: "fp16", encoder_model: "q4", decoder_model_merged: "q4" }
    : { embed_tokens: "fp16", vision_encoder: "fp16", decoder_model_merged: "q4" };
}

async function getCaptioner(id: number, msg: { model: string; device: Device; family: CaptionFamily }): Promise<Captioner> {
  const key = `${msg.family}:${msg.model}@${msg.device}`;
  if (captioner?.key === key) return captioner;
  if (captioner) await captioner.model.dispose();
  captioner = null;
  await verifiedPrefill(id, msg.model, captionDtype(msg.family, msg.device));
  const opts = { device: msg.device, dtype: captionDtype(msg.family, msg.device), progress_callback: progressFor(id) } as never;
  const Model = msg.family === "florence2" ? Florence2ForConditionalGeneration : AutoModelForVision2Seq;
  const [processor, model] = await Promise.all([
    AutoProcessor.from_pretrained(msg.model, { progress_callback: progressFor(id) } as never) as unknown as Promise<CaptionProcessor>,
    Model.from_pretrained(msg.model, opts) as Promise<PreTrainedModel>,
  ]);
  captioner = { key, processor, model };
  return captioner;
}

/** One short English caption for an image (plan 6.6). */
async function caption(id: number, msg: Extract<WorkerIn, { type: "caption" }>): Promise<string> {
  const { processor, model } = await getCaptioner(id, msg);
  const image = await RawImage.fromBlob(msg.image);
  if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
  const generate = (inputs: Record<string, unknown>) => (model as unknown as { generate(o: unknown): Promise<{ slice(...a: unknown[]): unknown }> }).generate({ ...inputs, max_new_tokens: 64, do_sample: false });
  if (msg.family === "florence2") {
    const task = "<CAPTION>";
    const inputs = await processor(image, processor.construct_prompts!(task));
    const ids = await generate(inputs);
    const text = processor.batch_decode(ids, { skip_special_tokens: false })[0] ?? "";
    return processor.post_process_generation!(text, task, image.size)[task] ?? "";
  }
  const messages = [{ role: "user", content: [{ type: "image" }, { type: "text", text: "Describe this image in one short sentence." }] }];
  const prompt = processor.apply_chat_template!(messages, { add_generation_prompt: true });
  const inputs = await processor(prompt, [image], { do_image_splitting: false });
  const ids = await generate(inputs);
  const promptLength = inputs.input_ids?.dims.at(-1) ?? 0;
  return processor.batch_decode(ids.slice(null, [promptLength, null]), { skip_special_tokens: true })[0] ?? "";
}

/** Token classification (DictaBERT-NER, plan 2.6): the raw B-/I- labels per text; the client aligns them. */
async function runNer(id: number, msg: Extract<WorkerIn, { type: "ner" }>): Promise<Array<Array<{ entity: string; word: string; score: number; index?: number }>>> {
  const key = `${msg.model}@${msg.device}`;
  if (ner?.key !== key) {
    await ner?.pipe.dispose();
    ner = null;
    const pipe = (await pipeline("token-classification", msg.model, { device: msg.device, dtype: "q8", progress_callback: progressFor(id) } as never)) as TokenClassificationPipeline;
    ner = { key, pipe };
  }
  const out = [];
  for (const text of msg.texts) {
    if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
    out.push((await ner.pipe(text)) as unknown as Array<{ entity: string; word: string; score: number; index?: number }>);
  }
  return out;
}

type Siglip = { key: string; processor: (image: unknown) => Promise<Record<string, unknown>>; tokenizer: PreTrainedTokenizer; vision: PreTrainedModel; text: PreTrainedModel };
let siglip: Siglip | null = null;

async function getSiglip(id: number, msg: { model: string; device: Device; dtype?: string; host?: string }): Promise<Siglip> {
  const dtype = msg.dtype ?? (msg.device === "webgpu" ? "q4f16" : "q8");
  const key = `${msg.model}@${msg.device}@${dtype}@${msg.host ?? ""}`;
  if (siglip?.key === key) return siglip;
  if (siglip) await Promise.all([siglip.vision.dispose(), siglip.text.dispose()]);
  siglip = null;
  const opts = { device: msg.device, dtype, progress_callback: progressFor(id) } as never;
  const loaded = await withHost(msg.host, () =>
    Promise.all([
      AutoProcessor.from_pretrained(msg.model, { progress_callback: progressFor(id) } as never),
      AutoTokenizer.from_pretrained(msg.model, { progress_callback: progressFor(id) } as never),
      SiglipVisionModel.from_pretrained(msg.model, opts) as Promise<PreTrainedModel>,
      SiglipTextModel.from_pretrained(msg.model, opts) as Promise<PreTrainedModel>,
    ]),
  );
  const [processor, tokenizer, vision, text] = loaded;
  siglip = { key, processor: processor as unknown as Siglip["processor"], tokenizer, vision, text };
  return siglip;
}

/** Row-wise L2 normalisation: cosine similarity becomes a dot product. */
export function normalizeRows(data: ArrayLike<number>, dims: number): number[][] {
  const out: number[][] = [];
  for (let r = 0; r * dims < data.length; r++) {
    const row = Array.from({ length: dims }, (_, i) => Number(data[r * dims + i]));
    const n = Math.hypot(...row) || 1;
    out.push(row.map((v) => v / n));
  }
  return out;
}

type Pooled = { pooler_output: { data: ArrayLike<number>; dims: number[] } };

async function imageEmbed(id: number, msg: Extract<WorkerIn, { type: "imageEmbed" }>): Promise<number[][]> {
  const m = await getSiglip(id, msg);
  const out: number[][] = [];
  for (const blob of msg.images) {
    if (cancelled.has(id)) throw new DOMException("aborted", "AbortError");
    const inputs = await m.processor(await RawImage.fromBlob(blob));
    const { pooler_output } = (await (m.vision as unknown as (i: unknown) => Promise<Pooled>)(inputs));
    out.push(...normalizeRows(pooler_output.data, pooler_output.dims.at(-1) ?? 0));
  }
  return out;
}

async function textEmbedForImages(id: number, msg: Extract<WorkerIn, { type: "textEmbedForImages" }>): Promise<number[][]> {
  const m = await getSiglip(id, msg);
  // SigLIP was trained with max_length padding (64 tokens).
  const inputs = m.tokenizer(msg.texts, { padding: "max_length", truncation: true, max_length: 64 } as never);
  const { pooler_output } = (await (m.text as unknown as (i: unknown) => Promise<Pooled>)(inputs));
  return normalizeRows(pooler_output.data, pooler_output.dims.at(-1) ?? 0);
}

function serial<T>(fn: () => Promise<T>): Promise<T> {
  const p = queue.then(fn);
  queue = p.catch(() => undefined);
  return p;
}

/** Run a cancellable job: skipped if cancelled while queued; its result dropped if cancelled while running. */
async function job<T>(id: number, fn: () => Promise<T>): Promise<T> {
  return serial(async () => {
    if (cancelled.delete(id)) throw new DOMException("aborted", "AbortError");
    try {
      const value = await fn();
      if (cancelled.delete(id)) throw new DOMException("aborted", "AbortError");
      return value;
    } finally {
      cancelled.delete(id);
    }
  });
}

export async function handle(msg: WorkerIn): Promise<void> {
  const { id } = msg;
  try {
    switch (msg.type) {
      case "transcribe":
        post({ id, type: "result", value: await job(id, () => transcribe(id, msg)) });
        return;
      case "embed":
        post({ id, type: "result", value: await job(id, () => embed(id, msg)) });
        return;
      case "rerank":
        post({ id, type: "result", value: await job(id, () => rerank(id, msg)) });
        return;
      case "translate":
        post({ id, type: "result", value: await job(id, () => translate(id, msg)) });
        return;
      case "caption":
        post({ id, type: "result", value: await job(id, () => caption(id, msg)) });
        return;
      case "ner":
        post({ id, type: "result", value: await job(id, () => runNer(id, msg)) });
        return;
      case "imageEmbed":
        post({ id, type: "result", value: await job(id, () => imageEmbed(id, msg)) });
        return;
      case "textEmbedForImages":
        post({ id, type: "result", value: await job(id, () => textEmbedForImages(id, msg)) });
        return;
      case "cancel":
        cancelled.add(msg.target);
        post({ id, type: "result", value: true });
        return;
      case "load":
        await serial<unknown>(() =>
          msg.task === "automatic-speech-recognition"
            ? getAsr(id, msg.model, msg.device)
            : msg.task === "translation"
              ? getTranslator(id, msg)
              : getEmbedder(id, msg.model, msg.device),
        );
        post({ id, type: "result", value: msg.model });
        return;
      case "unload": {
        const a = asr;
        const e = embedder;
        const r = reranker;
        const tr = translator;
        const cap = captioner;
        const sg = siglip;
        captioner = null;
        const n = ner;
        siglip = null;
        asr = null;
        embedder = null;
        reranker = null;
        translator = null;
        ner = null;
        await n?.pipe.dispose();
        await a?.pipe.dispose();
        await e?.pipe.dispose();
        await r?.model.dispose();
        await tr?.pipe.dispose();
        await cap?.model.dispose();
        await sg?.vision.dispose();
        await sg?.text.dispose();
        post({ id, type: "result", value: true });
        return;
      }
    }
  } catch (e) {
    post({ id, type: "error", message: (e as Error)?.message ?? String(e) });
  }
}

const ctx = self as unknown as { location?: { origin: string }; onmessage: ((ev: MessageEvent<WorkerIn & { ortBase?: string; ortSuffix?: ".asyncify" | "" }>) => void) | null };
let configured = false;
ctx.onmessage = (ev) => {
  if (!configured) {
    configureOrt(ev.data.ortBase ?? `${ctx.location?.origin ?? ""}/ort/`, ev.data.ortSuffix ?? ".asyncify");
    configured = true;
  }
  void handle(ev.data);
};
