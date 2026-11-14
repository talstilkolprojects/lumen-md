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
 */
import "./nikudStrings";
import { CONVERTED_MODELS_BASE, fileUrl, loadConvertedRegistry, requestConvertedModel, type ConsentDeps } from "./convertedModels";
import { removeNikud } from "../text/nikud";

export const NAKDIMON_ID = "nakdimon";
export const NAKDIMON_FILE = "Nakdimon.onnx";

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

/** Make sure the model is downloaded (asking first) and loaded in the worker. */
async function ready(deps: NikudDeps): Promise<Worker> {
  const base = deps.base === undefined ? CONVERTED_MODELS_BASE : deps.base;
  if (!base) throw new NikudUnavailableError("noHost");
  if (!loaded) {
    const { isModelCached } = await import("./modelCache");
    const answer = await requestConvertedModel(NAKDIMON_ID, "fp32", {
      ...deps.consent,
      base,
      isCached: async (entry, dtype) => isModelCached(await opfsRoot(), entry, dtype).catch(() => false),
    });
    if (answer === "unavailable") throw new NikudUnavailableError("noHost");
    if (answer === "declined") throw new NikudUnavailableError("declined");
    const url = fileUrl(NAKDIMON_ID, NAKDIMON_FILE, base)!;
    loaded = (async () => {
      const bytes = await (deps.loadModel ?? ((u) => defaultLoadModel(u, base)))(url);
      const w = startWorker(deps);
      await call(w, { type: "load", model: bytes, ortBase: `${location.origin}/ort/` }, [bytes]);
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
  const w = await ready(deps);
  return call<string>(w, { type: "point", text, partial: opts.partial }, [], deps.signal);
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
  pending.clear();
}
