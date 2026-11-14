/**
 * Plan 6.9 — local fill-in-the-middle completion: the pure parts (no
 * imports), shared by the editor, the tests and `npm run bench:fim`.
 *
 *   - which installed Ollama model completes: qwen2.5-coder 1.5B, else 7B
 *     (both Apache-2.0). The 3B is never picked: its licence is the Qwen
 *     Research licence, not an open one.
 *   - the `/api/generate` body with `suffix` (Ollama applies the model's
 *     own FIM template);
 *   - the cache, and the scheduler: debounce, and every new keystroke
 *     cancels the request in flight.
 */

/** Models that complete in the middle, in order of preference (fastest first). */
export const FIM_MODELS = ["qwen2.5-coder:1.5b", "qwen2.5-coder:7b"] as const;

/** Never picked automatically: not an open licence (Qwen Research). */
const NON_OPEN = /^qwen2\.5-coder:3b\b/i;

/**
 * The FIM model among the installed ones: the user's choice when it is
 * installed (and not the 3B), else the first of FIM_MODELS that is.
 */
export function pickFimModel(installed: readonly string[], preferred?: string | null): string | null {
  const names = installed.map((n) => n.toLowerCase());
  const has = (m: string) => names.some((n) => n === m || n === `${m}-instruct` || n.startsWith(`${m}-`));
  const exact = (m: string) => installed.find((n) => n.toLowerCase() === m || n.toLowerCase().startsWith(`${m}-`)) ?? m;
  if (preferred && !NON_OPEN.test(preferred) && names.includes(preferred.toLowerCase())) return preferred;
  for (const m of FIM_MODELS) if (has(m)) return exact(m);
  return null;
}

/** How much text goes to the model around the cursor. */
export const FIM_PREFIX_CHARS = 1500;
export const FIM_SUFFIX_CHARS = 500;

export interface FimRequestBody {
  model: string;
  prompt: string;
  suffix: string;
  stream: false;
  keep_alive: string;
  options: { num_predict: number; temperature: number; top_p: number; stop: string[] };
}

/** The `/api/generate` body: the text before the cursor as the prompt, the text after it as `suffix`. */
export function fimRequestBody(model: string, prefix: string, suffix: string, maxTokens = 48): FimRequestBody {
  return {
    model,
    prompt: prefix.slice(-FIM_PREFIX_CHARS),
    suffix: suffix.slice(0, FIM_SUFFIX_CHARS),
    stream: false,
    // Keep the model loaded between keystrokes: a cold load is seconds.
    keep_alive: "30m",
    // A completion is the rest of the line or two, not an essay.
    options: { num_predict: maxTokens, temperature: 0.2, top_p: 0.9, stop: ["\n\n", "<|endoftext|>", "<|fim_pad|>", "<|file_sep|>"] },
  };
}

/**
 * Clean a raw completion: no special tokens, nothing that repeats the text
 * right after the cursor, at most two lines. Empty when nothing is left.
 */
export function cleanFim(raw: string, suffix: string): string {
  let text = raw.replace(/<\|[a-z_]+\|>/g, "");
  const lines = text.split("\n");
  text = lines.slice(0, 2).join("\n");
  const next = suffix.replace(/^\s+/, "").slice(0, 40);
  if (next) {
    const at = text.indexOf(next);
    if (at >= 0) text = text.slice(0, at);
    // The completion runs into the text after the cursor ("…jumps over" + "over the dog"): drop the overlap.
    for (let k = Math.min(text.length, next.length); k >= 3; k--) {
      if (text.endsWith(next.slice(0, k))) {
        text = text.slice(0, text.length - k);
        break;
      }
    }
  }
  return text.replace(/\s+$/, (m) => (m.includes("\n") ? "" : m.slice(0, 1)));
}

/** A small LRU of completions: the same context (and model) twice → the same answer, no request. */
export class FimCache {
  private map = new Map<string, string>();
  private readonly limit: number;
  constructor(limit = 64) {
    this.limit = limit;
  }

  static key(model: string, prefix: string, suffix: string): string {
    return JSON.stringify([model, prefix.slice(-200), suffix.slice(0, 100)]);
  }

  get(key: string): string | undefined {
    const v = this.map.get(key);
    if (v === undefined) return undefined;
    this.map.delete(key);
    this.map.set(key, v);
    return v;
  }

  set(key: string, value: string): void {
    this.map.delete(key);
    while (this.map.size >= this.limit) {
      const oldest = this.map.keys().next().value;
      if (oldest === undefined) break;
      this.map.delete(oldest);
    }
    this.map.set(key, value);
  }

  get size(): number {
    return this.map.size;
  }

  clear(): void {
    this.map.clear();
  }
}

export interface Timers {
  set: (fn: () => void, ms: number) => unknown;
  clear: (id: unknown) => void;
}

const realTimers: Timers = {
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (id) => clearTimeout(id as ReturnType<typeof setTimeout>),
};

/**
 * Debounce + cancel: `request()` waits `delayMs` of quiet, then runs `run`
 * with a fresh AbortSignal. A newer request (the next keystroke) or
 * `cancel()` aborts the one before — whether it is still waiting or already
 * in flight — and that one resolves to null.
 */
export class FimScheduler<T> {
  private timer: unknown = null;
  private ctrl: AbortController | null = null;
  private settle: ((v: T | null) => void) | null = null;

  private readonly run: (signal: AbortSignal) => Promise<T>;
  private readonly delayMs: number;
  private readonly timers: Timers;

  constructor(run: (signal: AbortSignal) => Promise<T>, delayMs = 150, timers: Timers = realTimers) {
    this.run = run;
    this.delayMs = delayMs;
    this.timers = timers;
  }

  request(): Promise<T | null> {
    this.cancel();
    return new Promise<T | null>((resolve) => {
      this.settle = resolve;
      const ctrl = (this.ctrl = new AbortController());
      this.timer = this.timers.set(() => {
        this.timer = null;
        this.run(ctrl.signal).then(
          (v) => {
            if (ctrl.signal.aborted) return;
            this.finish(ctrl, v);
          },
          () => this.finish(ctrl, null),
        );
      }, this.delayMs);
    });
  }

  private finish(ctrl: AbortController, v: T | null): void {
    if (this.ctrl !== ctrl) return;
    this.ctrl = null;
    const s = this.settle;
    this.settle = null;
    s?.(ctrl.signal.aborted ? null : v);
  }

  cancel(): void {
    if (this.timer !== null) {
      this.timers.clear(this.timer);
      this.timer = null;
    }
    this.ctrl?.abort();
    this.ctrl = null;
    const s = this.settle;
    this.settle = null;
    s?.(null);
  }
}

/** p-th percentile (nearest rank) of `values`, for the trace summary and the bench. */
export function percentile(values: readonly number[], p: number): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.min(sorted.length, Math.max(1, Math.ceil((p / 100) * sorted.length)));
  return sorted[rank - 1];
}
