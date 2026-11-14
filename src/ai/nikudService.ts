/**
 * Hebrew niqqud on this device (plan 6.3), the main-thread side: the model
 * download (consent through requestConvertedModel, sha256-verified into
 * OPFS by modelCache), the worker, and the three editor actions — add
 * niqqud, add partial niqqud, remove niqqud.
 *
 * Stage 1 is Nakdimon (MIT): ≈ 21 MB, wasm, any device. It is mirrored by
 * .github/workflows/model-convert.yml and served from CONVERTED_MODELS_BASE;
 * until Tal picks that host (15.9) adding niqqud reports "unavailable".
 * Removing niqqud needs no model.
 *
 * Plan W2.5: DictaBERT-char-menaked (CC BY 4.0, int8 ONNX, exported by
 * scripts/models/export-menaked.py) is the "high quality" layer. When the
 * registry lists its files, adding niqqud offers it first (with its own
 * consent); declined once, it is not offered again on this device and
 * Nakdimon is used. Either way every result passes the consonant
 * validator, and comes with alternatives per word.
 */
import "./nikudStrings";
import { CONVERTED_MODELS_BASE, fileUrl, loadConvertedRegistry, requestConvertedModel, type ConsentDeps } from "./convertedModels";
import { removeNikud } from "../text/nikud";
import type { DetailedNikud } from "../text/nikudRun";

export const NAKDIMON_ID = "nakdimon";
export const NAKDIMON_FILE = "Nakdimon.onnx";
export const MENAKED_ID = "dictabert-char-menaked";
export const MENAKED_FILE = "model_quantized.onnx";
export const MENAKED_SPEC_FILE = "menaked.json";
/** "fast": the user declined the high-quality model once; Nakdimon from then on. */
export const NIKUD_QUALITY_KEY = "lumen.nikud.quality";

export type NikudEngineId = "nakdimon" | "menaked";

export class NikudUnavailableError extends Error {
  constructor(readonly reason: "noHost" | "declined") {
    super(`niqqud model ${reason}`);
    this.name = "NikudUnavailableError";
  }
}

export interface NikudDeps {
  consent: Omit<ConsentDeps, "isCached" | "base" | "registry">;
  signal?: AbortSignal;
  /** Tests. */
  base?: string | null;
  loadModel?: (url: string) => Promise<ArrayBuffer>;
  createWorker?: () => Worker;
}

let worker: Worker | null = null;
let loaded: Promise<void> | null = null;
let loadedEngine: NikudEngineId | null = null;
let seq = 0;
const pending = new Map<number, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();

function opfsRoot(): Promise<FileSystemDirectoryHandle> {
  return navigator.storage.getDirectory();
}

/** The model file, from the verified OPFS cache or the host (checked against the registry's sha256 on the way in). */
async function defaultLoadModel(url: string, base: string): Promise<ArrayBuffer> {
  const [{ createModelCache }, registry] = await Promise.all([import("./modelCache"), loadConvertedRegistry()]);
  const cache = createModelCache({ base, registry, root: opfsRoot, fallback: async () => caches.open("transformers-cache") });
  const hit = await cache.match(url);
  if (hit) return hit.arrayBuffer();
  const res = await fetch(url);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  await cache.put(url, res.clone()); // throws on a size or checksum mismatch
  return res.arrayBuffer();
}

function call<T>(w: Worker, msg: Record<string, unknown>, transfer: Transferable[] = [], signal?: AbortSignal): Promise<T> {
  const id = ++seq;
  return new Promise<T>((resolve, reject) => {
    pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
    signal?.addEventListener("abort", () => w.postMessage({ type: "cancel", target: id }), { once: true });
    w.postMessage({ ...msg, id }, transfer);
  });
}

function startWorker(deps: NikudDeps): Worker {
  if (worker) return worker;
  const w = deps.createWorker?.() ?? new Worker(new URL("./nikud.worker.ts", import.meta.url), { type: "module" });
  w.onmessage = (e: MessageEvent<{ type: string; id: number; value?: unknown; message?: string; name?: string }>) => {
    const p = pending.get(e.data.id);
    if (!p) return;
    pending.delete(e.data.id);
    if (e.data.type === "result") p.resolve(e.data.value);
    else p.reject(Object.assign(new Error(e.data.message ?? "niqqud failed"), { name: e.data.name ?? "Error" }));
  };
  worker = w;
  return w;
}

function qualityPref(): string | null {
  try {
    return localStorage.getItem(NIKUD_QUALITY_KEY);
  } catch {
    return null;
  }
}

function setQualityPref(v: string): void {
  try {
    localStorage.setItem(NIKUD_QUALITY_KEY, v);
  } catch {
    /* storage blocked: asked again next time */
  }
}

/** Ask for one model (consent unless already cached). */
async function ask(id: string, dtype: "fp32" | "q8", deps: NikudDeps, base: string) {
  const { isModelCached } = await import("./modelCache");
  return requestConvertedModel(id, dtype, {
    ...deps.consent,
    base,
    isCached: async (entry, d) => isModelCached(await opfsRoot(), entry, d).catch(() => false),
  });
}

/**
 * Make sure a model is downloaded (asking first) and loaded in the worker:
 * DictaBERT-char-menaked when it is published and not declined before,
 * else Nakdimon.
 */
async function ready(deps: NikudDeps): Promise<Worker> {
  const base = deps.base === undefined ? CONVERTED_MODELS_BASE : deps.base;
  if (!base) throw new NikudUnavailableError("noHost");
  if (!loaded) {
    let engine: NikudEngineId = "nakdimon";
    if (qualityPref() !== "fast") {
      const high = await ask(MENAKED_ID, "q8", deps, base);
      if (high === "ready") engine = "menaked";
      else if (high === "declined") setQualityPref("fast");
    }
    if (engine === "nakdimon") {
      const answer = await ask(NAKDIMON_ID, "fp32", deps, base);
      if (answer === "unavailable") throw new NikudUnavailableError("noHost");
      if (answer === "declined") throw new NikudUnavailableError("declined");
    }
    const load = deps.loadModel ?? ((u: string) => defaultLoadModel(u, base));
    loaded = (async () => {
      if (engine === "menaked") {
        const [bytes, specBytes] = await Promise.all([load(fileUrl(MENAKED_ID, MENAKED_FILE, base)!), load(fileUrl(MENAKED_ID, MENAKED_SPEC_FILE, base)!)]);
        const { parseMenakedSpec } = await import("../text/menaked");
        const spec = parseMenakedSpec(JSON.parse(new TextDecoder().decode(specBytes)));
        const w = startWorker(deps);
        await call(w, { type: "load", kind: "menaked", spec, model: bytes, ortBase: `${location.origin}/ort/` }, [bytes]);
      } else {
        const bytes = await load(fileUrl(NAKDIMON_ID, NAKDIMON_FILE, base)!);
        const w = startWorker(deps);
        await call(w, { type: "load", kind: "nakdimon", model: bytes, ortBase: `${location.origin}/ort/` }, [bytes]);
      }
      loadedEngine = engine;
    })();
    loaded.catch(() => {
      loaded = null;
    });
  }
  await loaded;
  return worker!;
}

/** `text` with niqqud (all words, or with `partial` only the ones the model finds ambiguous). */
export async function pointHebrew(text: string, deps: NikudDeps, opts: { partial?: boolean } = {}): Promise<string> {
  return (await pointHebrewDetailed(text, deps, opts)).text;
}

/** Niqqud and, per pointed word, its alternatives (plan W2.5); `engine` says which model pointed it. */
export async function pointHebrewDetailed(text: string, deps: NikudDeps, opts: { partial?: boolean } = {}): Promise<DetailedNikud & { engine: NikudEngineId }> {
  const w = await ready(deps);
  const r = await call<DetailedNikud>(w, { type: "point", text, partial: opts.partial }, [], deps.signal);
  return { ...r, engine: loadedEngine ?? "nakdimon" };
}

/** Niqqud off — no model needed. */
export function unpointHebrew(text: string): string {
  return removeNikud(text);
}

/** Tests. */
export function __resetNikud(): void {
  worker?.terminate();
  worker = null;
  loaded = null;
  loadedEngine = null;
  pending.clear();
}
