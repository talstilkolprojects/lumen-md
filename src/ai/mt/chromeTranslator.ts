/**
 * Layer 1 (plan 6.4): Chrome's built-in Translator API. On-device language
 * packs managed by the browser, Hebrew among them; nothing for Lumen to
 * host. The API lives on the main thread only (no workers), and a pack's
 * first download needs a user gesture: `prepare()` is called from the
 * command the user ran.
 *
 * Shape (Chrome 138+): `Translator.availability({ sourceLanguage,
 * targetLanguage })` → "available" | "downloadable" | "downloading" |
 * "unavailable"; `Translator.create({ …, monitor })` → { translate(text) }.
 */
import type { Availability, LayerDeps, MtLayer, Pair } from "./layers";

interface ChromeTranslator {
  translate(text: string): Promise<string>;
  destroy?: () => void;
}
interface ChromeTranslatorStatic {
  availability(o: { sourceLanguage: string; targetLanguage: string }): Promise<string>;
  create(o: { sourceLanguage: string; targetLanguage: string; monitor?: (m: EventTarget) => void; signal?: AbortSignal }): Promise<ChromeTranslator>;
}

export function chromeTranslatorApi(g: unknown = globalThis): ChromeTranslatorStatic | null {
  const api = (g as { Translator?: ChromeTranslatorStatic }).Translator;
  return api && typeof api.availability === "function" && typeof api.create === "function" ? api : null;
}

const instances = new Map<string, Promise<ChromeTranslator>>();

async function instance(api: ChromeTranslatorStatic, pair: Pair, deps: LayerDeps): Promise<ChromeTranslator> {
  const key = `${pair.source}-${pair.target}`;
  let p = instances.get(key);
  if (!p) {
    p = api.create({
      sourceLanguage: pair.source,
      targetLanguage: pair.target,
      signal: deps.signal,
      monitor: (m) => {
        m.addEventListener("downloadprogress", (e) => {
          const loaded = (e as { loaded?: number }).loaded ?? 0;
          deps.onProgress?.({ layer: "chrome", progress: Math.round(loaded * 100) });
        });
      },
    });
    instances.set(key, p);
    p.catch(() => instances.delete(key));
  }
  return p;
}

export function createChromeLayer(getApi: () => ChromeTranslatorStatic | null = () => chromeTranslatorApi()): MtLayer {
  return {
    id: "chrome",
    supports: () => getApi() !== null,
    async availability(pair): Promise<Availability> {
      const api = getApi();
      if (!api) return { state: "unavailable", reason: "mt.layer.chrome.absent" };
      try {
        const a = await api.availability({ sourceLanguage: pair.source, targetLanguage: pair.target });
        if (a === "available") return { state: "ready" };
        if (a === "downloadable" || a === "downloading") return { state: "downloadable" };
      } catch {
        /* why: an unknown pair or a disabled API */
      }
      return { state: "unavailable", reason: "mt.layer.chrome.pair" };
    },
    async prepare(pair, deps) {
      const api = getApi();
      if (!api) return false;
      try {
        await instance(api, pair, deps);
        return true;
      } catch {
        return false;
      }
    },
    async translate(texts, pair, deps) {
      const api = getApi();
      if (!api) throw new Error("Chrome's Translator API is not available");
      const tr = await instance(api, pair, deps);
      const out: string[] = [];
      for (const [i, text] of texts.entries()) {
        if (deps.signal?.aborted) throw new DOMException("aborted", "AbortError");
        out.push(await tr.translate(text));
        deps.onProgress?.({ layer: "chrome", progress: Math.round(((i + 1) / texts.length) * 100) });
      }
      return out;
    },
  };
}

/** Tests. */
export function __resetChromeTranslator(): void {
  instances.clear();
}
