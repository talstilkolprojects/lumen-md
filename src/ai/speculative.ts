/**
 * Speculative decoding in Ollama ≥ 0.34 (plan W7.15).
 *
 * Ollama 0.34 turns on multi-token prediction (`draft_num_predict 3`) by
 * default for the models that ship an MTP head (Qwen 3.6 / 3.8, Gemma 4):
 * 1.3–2.4× tokens per second, but output that is not always identical at
 * temperature 0, and on one model (qwen3.8) a 4× slowdown. So:
 *
 *   • Reproducible runs (the eval, `npm run models:day`) pin
 *     `draft_num_predict: 0` and record the Ollama version.
 *   • Each model is measured once per Ollama version, with and without
 *     (`measureSpeculative`); it keeps Ollama's default only when that is
 *     at least 10 % faster, else Lumen sends `draft_num_predict: 0` for it.
 *   • No external draft model is ever proposed (a mismatched one cost 73 %
 *     in the reports).
 *
 * The measurements are kept per browser (`lumen.ollama.speculative`) and
 * shown in the AI doctor. This module is what every request needs (small:
 * the Ollama executor imports it); measuring is in speculativeMeasure.ts.
 */

export const SPECULATIVE_MIN_VERSION = "0.34.0";
export const DRAFT_OPTION = "draft_num_predict";
/** Keep Ollama's default only when it is at least this much faster. */
export const MIN_SPEEDUP = 1.1;
export const STORE_KEY = "lumen.ollama.speculative";
/** Set by the eval and models:day: every request pins `draft_num_predict: 0`. */
export const REPRODUCIBLE_KEY = "lumen.ollama.reproducible";

export interface SpeculativeMeasurement {
  model: string;
  ollama: string;
  /** Tokens per second with Ollama's default (speculation on where the model has it). */
  withDraft: number;
  /** Tokens per second with `draft_num_predict: 0`. */
  withoutDraft: number;
  /** withDraft / withoutDraft. */
  speedup: number;
  decision: "default" | "off";
  at: string;
}

type Store = Pick<Storage, "getItem" | "setItem">;
const ls = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

export function versionAtLeast(v: string | null | undefined, min: string): boolean {
  const a = String(v ?? "").split(/[.-]/).map((x) => parseInt(x, 10) || 0);
  const b = min.split(".").map((x) => parseInt(x, 10) || 0);
  for (let i = 0; i < 3; i++) if ((a[i] ?? 0) !== (b[i] ?? 0)) return (a[i] ?? 0) > (b[i] ?? 0);
  return true;
}

export function reproducibleMode(store: Store | null = ls(), env: Record<string, string | undefined> | undefined = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env): boolean {
  if (env?.LUMEN_OLLAMA_REPRODUCIBLE === "1") return true;
  try {
    return store?.getItem(REPRODUCIBLE_KEY) === "1";
  } catch {
    return false;
  }
}

export function readMeasurements(store: Pick<Storage, "getItem"> | null = ls()): Record<string, SpeculativeMeasurement> {
  try {
    const v = JSON.parse(store?.getItem(STORE_KEY) ?? "{}") as Record<string, SpeculativeMeasurement>;
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch {
    return {};
  }
}

export function saveMeasurement(m: SpeculativeMeasurement, store: Store | null = ls()): void {
  try {
    store?.setItem(STORE_KEY, JSON.stringify({ ...readMeasurements(store), [m.model]: m }));
  } catch {
    /* blocked storage: measured again next time */
  }
}

/** The measurement for this model on this Ollama version, if any. */
export function measurementFor(model: string, ollama: string | null, store: Store | null = ls()): SpeculativeMeasurement | null {
  const m = readMeasurements(store)[model];
  return m && (!ollama || m.ollama === ollama) ? m : null;
}

export function decide(withDraft: number, withoutDraft: number): SpeculativeMeasurement["decision"] {
  return withoutDraft > 0 && Math.round((withDraft / withoutDraft) * 1000) >= Math.round(MIN_SPEEDUP * 1000) ? "default" : "off";
}

/**
 * The options Lumen adds to an Ollama request for `model`: `draft_num_predict: 0`
 * in reproducible mode, or when the measurement said speculation does not
 * pay on this model; nothing otherwise (Ollama's default). Older Ollama
 * versions get nothing (the option is unknown there).
 */
export function draftOptions(model: string, ollama: string | null, store: Store | null = ls()): Record<string, number> {
  if (ollama && !versionAtLeast(ollama, SPECULATIVE_MIN_VERSION)) return {};
  if (reproducibleMode(store)) return { [DRAFT_OPTION]: 0 };
  return measurementFor(model, ollama, store)?.decision === "off" ? { [DRAFT_OPTION]: 0 } : {};
}
