/**
 * Measuring speculative decoding per model (plan W7.15): with and without
 * `draft_num_predict`, on this machine, once per Ollama version. Loaded
 * on demand (speculative.ts holds what every request needs).
 */
import { decide, DRAFT_OPTION, measurementFor, reproducibleMode, saveMeasurement, SPECULATIVE_MIN_VERSION, versionAtLeast, type SpeculativeMeasurement } from "./speculative";

type Store = Pick<Storage, "getItem" | "setItem">;
const ls = (): Store | null => {
  try {
    return typeof localStorage === "undefined" ? null : localStorage;
  } catch {
    return null;
  }
};

/** Tokens per second from an Ollama response (`eval_count` / `eval_duration` in ns). */
export function tokensPerSecond(r: { eval_count?: number; eval_duration?: number }): number {
  return r.eval_count && r.eval_duration ? r.eval_count / (r.eval_duration / 1e9) : 0;
}

const median = (xs: number[]) => {
  const s = [...xs].sort((a, b) => a - b);
  return s.length ? (s.length % 2 ? s[(s.length - 1) / 2]! : (s[s.length / 2 - 1]! + s[s.length / 2]!) / 2) : 0;
};

export const MEASURE_PROMPT = "Write a short paragraph, in plain prose, about why people keep notes. Do not use lists.";

export interface MeasureOptions {
  base: string;
  fetch?: typeof fetch;
  /** Runs per setting (alternating, after one warm-up). */
  runs?: number;
  numPredict?: number;
  signal?: AbortSignal;
}

/** Measure one model with and without speculation, decide, and keep the result. */
export async function measureSpeculative(model: string, ollama: string, o: MeasureOptions, store: Store | null = ls()): Promise<SpeculativeMeasurement> {
  const f = o.fetch ?? fetch;
  const runs = Math.max(1, o.runs ?? 3);
  const one = async (pin: boolean) => {
    const res = await f(`${o.base}/api/generate`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ model, prompt: MEASURE_PROMPT, stream: false, options: { temperature: 0, seed: 1, num_predict: o.numPredict ?? 128, ...(pin ? { [DRAFT_OPTION]: 0 } : {}) } }),
      signal: o.signal,
    });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    return tokensPerSecond((await res.json()) as { eval_count?: number; eval_duration?: number });
  };
  await one(false); // warm-up: load the model
  const on: number[] = [];
  const off: number[] = [];
  for (let i = 0; i < runs; i++) {
    on.push(await one(false));
    off.push(await one(true));
  }
  const withDraft = median(on);
  const withoutDraft = median(off);
  const m: SpeculativeMeasurement = { model, ollama, withDraft, withoutDraft, speedup: withoutDraft ? withDraft / withoutDraft : 0, decision: decide(withDraft, withoutDraft), at: new Date().toISOString() };
  saveMeasurement(m, store);
  return m;
}

/** "qwen3.6:27b 48 → 115 tok/s (×2.4, kept on)": the doctor's line. */
export function describeMeasurement(m: SpeculativeMeasurement): string {
  const r = (x: number) => Math.round(x * 10) / 10;
  return `${m.model}: ${r(m.withoutDraft)} → ${r(m.withDraft)} tok/s (×${r(m.speedup)}, ${m.decision === "default" ? "on" : "off"})`;
}

let running: Promise<unknown> | null = null;

/**
 * After a model has answered on Ollama ≥ 0.34 and has no measurement for
 * this version yet: measure it once, in the background, one model at a
 * time. Never in reproducible mode (the eval must not be disturbed).
 */
export function scheduleMeasurement(model: string, ollama: string | null, base: string, delayMs = 30_000, store: Store | null = ls()): boolean {
  if (!ollama || !versionAtLeast(ollama, SPECULATIVE_MIN_VERSION) || reproducibleMode(store) || measurementFor(model, ollama, store) || running) return false;
  running = new Promise((r) => setTimeout(r, delayMs))
    .then(() => measureSpeculative(model, ollama, { base, runs: 2, numPredict: 96 }, store))
    .catch(() => undefined)
    .finally(() => (running = null));
  return true;
}
