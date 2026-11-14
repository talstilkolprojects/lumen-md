/**
 * Layers 2 and 3 (plan 6.4): translation models in the transformers.js
 * worker.
 *
 *   opus     Opus-MT en→he and opus-mt-tc-big-he-en, converted by plan 6.0
 *            and hosted by Lumen. Download only through
 *            requestConvertedModel(): size first, licence, attribution,
 *            consent; verified against the registry's checksums into OPFS.
 *            Unavailable while CONVERTED_MODELS_BASE is null (15.9).
 *   m2m100   M2M100-418M (MIT) from Hugging Face for every other pair, with
 *            the same consent dialog (size, licence, attribution) before its
 *            first download. The non-commercial alternative is on the registry's deny-list.
 */
import { CONVERTED_MODELS_BASE, downloadBytes, loadConvertedRegistry, requestConvertedModel, type ConvertedDtype, type RegistryModel } from "../convertedModels";
import { isModelCached } from "../modelCache";
import { M2M100_MODEL, M2M100_BYTES, translateLocal, translationDtypeFor, transformersDevice } from "../transformersEngine";
import type { Availability, MtLayer, Pair } from "./layers";

/** Pair → the converted model that translates it. */
export const OPUS_MODELS: Record<string, string> = {
  "en-he": "opus-mt-en-he",
  "he-en": "opus-mt-tc-big-he-en",
};

/** The languages M2M100 covers (its 100 ISO codes). */
export const M2M100_LANGUAGES = new Set(
  "af am ar ast az ba be bg bn br bs ca ceb cs cy da de el en es et fa ff fi fr fy ga gd gl gu ha he hi hr ht hu hy id ig ilo is it ja jv ka kk km kn ko lb lg ln lo lt lv mg mk ml mn mr ms my ne nl no ns oc or pa pl ps pt ro ru sd si sk sl so sq sr ss su sv sw ta th tl tn tr uk ur uz vi wo xh yi yo zh zu".split(" "),
);

export interface ConsentDeps {
  confirm: (o: { title: string; message: string; okLabel: string }) => Promise<boolean>;
  t: (key: string, vars?: Record<string, string | number>) => string;
  locale?: string;
}

interface Env {
  base: () => string | null;
  registry: () => Promise<Map<string, RegistryModel>>;
  opfsRoot: () => Promise<FileSystemDirectoryHandle>;
  device: () => Promise<"webgpu" | "wasm">;
  translate: typeof translateLocal;
  consent: ConsentDeps;
  /** Where "M2M100 was consented and loaded once" is remembered. */
  storage?: Pick<Storage, "getItem" | "setItem">;
}

const defaultEnv = (consent: ConsentDeps): Env => ({
  base: () => CONVERTED_MODELS_BASE,
  registry: loadConvertedRegistry,
  opfsRoot: () => navigator.storage.getDirectory(),
  device: transformersDevice,
  translate: translateLocal,
  consent,
  storage: typeof localStorage === "undefined" ? undefined : localStorage,
});

async function dtypeOf(env: Env): Promise<Extract<ConvertedDtype, "q8" | "q4f16">> {
  return translationDtypeFor(await env.device());
}

export function createOpusLayer(consent: ConsentDeps, env: Env = defaultEnv(consent)): MtLayer {
  const modelOf = (p: Pair) => OPUS_MODELS[`${p.source}-${p.target}`];
  return {
    id: "opus",
    supports: (pair) => modelOf(pair) !== undefined,
    async availability(pair): Promise<Availability> {
      const id = modelOf(pair);
      if (!id) return { state: "unavailable", reason: "mt.layer.opus.pair" };
      if (!env.base()) return { state: "unavailable", reason: "mt.layer.opus.noHost" };
      const entry = (await env.registry()).get(id);
      const dtype = await dtypeOf(env);
      if (!entry || !(entry.files ?? []).some((f) => f.dtype === dtype)) return { state: "unavailable", reason: "mt.layer.opus.noFiles" };
      try {
        if (await isModelCached(await env.opfsRoot(), entry, dtype)) return { state: "ready" };
      } catch {
        /* why: no OPFS here: it will download into the Cache API fallback */
      }
      return { state: "downloadable", bytes: downloadBytes(entry, dtype) };
    },
    async prepare(pair) {
      const id = modelOf(pair);
      if (!id || !env.base()) return false;
      const dtype = await dtypeOf(env);
      const r = await requestConvertedModel(id, dtype, {
        confirm: env.consent.confirm,
        t: env.consent.t,
        locale: env.consent.locale,
        registry: await env.registry(),
        base: env.base(),
        isCached: async (entry, d) => {
          try {
            return await isModelCached(await env.opfsRoot(), entry, d);
          } catch {
            return false;
          }
        },
      });
      return r === "ready";
    },
    async translate(texts, pair, deps) {
      const id = modelOf(pair);
      const base = env.base();
      if (!id || !base) throw new Error("Opus-MT is not available for this pair");
      return env.translate(id, texts, { host: base, dtype: await dtypeOf(env), signal: deps.signal });
    },
  };
}

const M2M100_FLAG = "lumen.mt.m2m100.ready";

export function createM2m100Layer(consent: ConsentDeps, env: Env = defaultEnv(consent)): MtLayer {
  const ready = () => env.storage?.getItem(M2M100_FLAG) === "1";
  return {
    id: "m2m100",
    supports: (pair) => pair.source !== pair.target && M2M100_LANGUAGES.has(pair.source) && M2M100_LANGUAGES.has(pair.target),
    async availability(pair): Promise<Availability> {
      if (!this.supports(pair)) return { state: "unavailable", reason: "mt.layer.m2m100.pair" };
      return ready() ? { state: "ready" } : { state: "downloadable", bytes: M2M100_BYTES };
    },
    async prepare(pair) {
      if (!this.supports(pair)) return false;
      if (ready()) return true;
      const size = env.consent.t("mt.size.approx", { size: `${Math.round(M2M100_BYTES / 1e6)} MB` });
      const ok = await env.consent.confirm({
        title: env.consent.t("models.consent.title"),
        message: env.consent.t("models.consent.body", {
          purpose: env.consent.t("mt.layer.m2m100.purpose"),
          name: M2M100_MODEL,
          size,
          license: "MIT",
          attribution: env.consent.t("mt.layer.m2m100.attribution"),
        }),
        okLabel: env.consent.t("models.consent.ok", { size }),
      });
      return ok;
    },
    async translate(texts, pair, deps) {
      const out = await env.translate(M2M100_MODEL, texts, { srcLang: pair.source, tgtLang: pair.target, signal: deps.signal });
      // The first successful run means the model is in the browser's cache: no second dialog.
      try {
        env.storage?.setItem(M2M100_FLAG, "1");
      } catch {
        /* why: private mode */
      }
      return out;
    },
  };
}
