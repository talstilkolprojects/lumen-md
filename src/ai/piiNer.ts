/**
 * Hebrew names for the PII redactor (plan 2.6): DictaBERT-NER (CC BY 4.0,
 * appendix 19), converted to ONNX by the model-convert workflow (plan 6.0).
 *
 * Only a model that is already on this device is used: a cloud request
 * never starts a download. Until the host of the converted models is
 * chosen (15.9, CONVERTED_MODELS_BASE is null) there is nothing to load.
 *
 * The fallback (audit W10.C23): Ollama on this machine, asked for the names
 * in the text as JSON and held to them (every name must be in the text).
 * Without either, `namesEngine` says "none", and the redactor's preview
 * says that names are not hidden — it never lets the user think they are.
 * English text uses bert-base-NER when that model is cached.
 */
import { alignNer, type NerFn } from "./pii";
import { CONVERTED_MODELS_BASE, loadConvertedRegistry } from "./convertedModels";

export const NER_MODEL_ID = "dictabert-ner";
export const NER_MODEL_ID_EN = "bert-base-ner";

/** The name finder when DictaBERT-NER is cached, else null. */
export async function nerIfCached(base: string | null = CONVERTED_MODELS_BASE, id: string = NER_MODEL_ID): Promise<NerFn | null> {
  if (!base) return null;
  const entry = (await loadConvertedRegistry()).get(id);
  if (!entry || typeof navigator === "undefined" || !navigator.storage?.getDirectory) return null;
  const { isModelCached } = await import("./modelCache");
  const root = (await navigator.storage.getDirectory()) as unknown as Parameters<typeof isModelCached>[0];
  if (!(await isModelCached(root, entry, "q8"))) return null;
  const model = `${base.endsWith("/") ? base : `${base}/`}${id}`;
  return async (text) => {
    const { nerLocal } = await import("./transformersEngine");
    const [tokens] = await nerLocal([text], model);
    return alignNer(text, tokens ?? []);
  };
}

/* ── The fallback: Ollama on this machine ───────────────────────────── */

/** Asks a local model for the person names in a text (JSON `{"names": [...]}`); rejects when none runs. */
export type NamesAsk = (text: string) => Promise<string[]>;

const ollamaAsk: NamesAsk = async (text) => {
  const [{ runAgentOrThrow }, { piiNamesAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs/piiNames")]);
  return (await runAgentOrThrow(piiNamesAgent, { text })).names;
};

/** Every occurrence of every name the model gave, as PERSON spans (a name not in the text is ignored). */
export function spansOf(text: string, names: readonly string[]): Array<{ start: number; end: number; type: "PERSON" }> {
  const out: Array<{ start: number; end: number; type: "PERSON" }> = [];
  for (const n of [...new Set(names.map((x) => x.trim()).filter((x) => x.length > 1))].sort((a, b) => b.length - a.length)) {
    for (let at = text.indexOf(n); at >= 0; at = text.indexOf(n, at + n.length)) {
      if (!out.some((o) => at < o.end && at + n.length > o.start)) out.push({ start: at, end: at + n.length, type: "PERSON" });
    }
  }
  return out.sort((a, b) => a.start - b.start);
}

/** The name finder over a local model's answer. */
export function ollamaNamesFinder(ask: NamesAsk = ollamaAsk): NerFn {
  return async (text) => spansOf(text, await ask(text));
}

export type NamesEngine = "dictabert" | "bert-base-ner" | "ollama" | "none";

/**
 * The best name finder this device has: a cached converted model, else
 * Ollama on this machine, else none (and the caller says so).
 */
export async function namesEngine(deps: { cached?: (id: string) => Promise<NerFn | null>; ollamaUp?: () => Promise<boolean>; ask?: NamesAsk } = {}): Promise<{ engine: NamesEngine; ner: NerFn | null }> {
  const cached = deps.cached ?? ((id: string) => nerIfCached(CONVERTED_MODELS_BASE, id));
  const he = await cached(NER_MODEL_ID).catch(() => null);
  if (he) return { engine: "dictabert", ner: he };
  const en = await cached(NER_MODEL_ID_EN).catch(() => null);
  if (en) return { engine: "bert-base-ner", ner: en };
  const up = deps.ollamaUp ?? (async () => !!(await (await import("../agents/executors")).pickExecutor(["ollama"])).executor);
  if (await up().catch(() => false)) return { engine: "ollama", ner: ollamaNamesFinder(deps.ask) };
  return { engine: "none", ner: null };
}
