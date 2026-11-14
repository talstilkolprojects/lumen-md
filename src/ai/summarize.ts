/**
 * Plan 6.11 — layered local summaries. Lazy.
 *
 *   English  Chrome's built-in Summarizer API when the browser has its model
 *            ready (it doesn't do Hebrew), kept only if its sentences are
 *            grounded in the text;
 *   any      the `summarizer` agent on a local model — for Hebrew DictaLM
 *            3.0 1.7B in Ollama when installed, else the runtime's local
 *            pick (Ollama, or Qwen3 in web-llm) — section by section, then
 *            once more over the section summaries ("layers");
 *   fallback the extractive layer (no model): the sentences with the
 *            text's most frequent content words.
 *
 * Every sentence shown is checked against the source with `quoteContained`;
 * one that isn't there is dropped. No layer talks to a cloud service.
 */
import { extractiveSummary, ground, sections, summarySentences, type Grounding } from "./summarizeCore";
import { quoteContained } from "../research/citations";
import { hebrewRatio } from "../text/hebrew";
import { log } from "../lib/logger";

export type SummaryEngine = "chrome" | "ollama" | "webllm" | "extractive";

export interface SummaryResult {
  /** Grounded sentences, in the order given. */
  sentences: string[];
  engine: SummaryEngine;
  model?: string;
  /** Share of the engine's sentences that were in the source, before any was dropped. */
  grounded: number;
  /** Sentences dropped because they were not in the source. */
  dropped: number;
  /** Sections summarised on the way (1 = the text in one go). */
  layers: number;
}

export interface SummarizeOptions {
  signal?: AbortSignal;
  /** About how many sentences. */
  sentences?: number;
  /** Skip Chrome's Summarizer (tests, or to compare engines). */
  noChrome?: boolean;
}

/** The share of grounded sentences an engine needs for its summary to be used. */
export const MIN_GROUNDED = 0.95;

/* ─── Chrome's Summarizer API (English) ──────────────────────────────── */

interface ChromeSummarizer {
  summarize(text: string, o?: { signal?: AbortSignal }): Promise<string>;
  destroy?(): void;
}
interface ChromeSummarizerApi {
  availability(o?: Record<string, unknown>): Promise<string>;
  create(o: Record<string, unknown>): Promise<ChromeSummarizer>;
}

function chromeApi(): ChromeSummarizerApi | null {
  const api = (globalThis as { Summarizer?: ChromeSummarizerApi }).Summarizer;
  return api && typeof api.availability === "function" && typeof api.create === "function" ? api : null;
}

const CHROME_OPTS = { type: "key-points", format: "plain-text", length: "short", expectedInputLanguages: ["en"], outputLanguage: "en" };

async function viaChrome(text: string, signal?: AbortSignal): Promise<string[] | null> {
  const api = chromeApi();
  if (!api) return null;
  try {
    // Only a model the browser already has: no download starts from here.
    if ((await api.availability(CHROME_OPTS)) !== "available") return null;
    const s = await api.create({ ...CHROME_OPTS, signal });
    try {
      return summarySentences(await s.summarize(text, { signal }));
    } finally {
      s.destroy?.();
    }
  } catch (e) {
    if (!signal?.aborted) log.debug("chrome summarizer", e);
    return null;
  }
}

/* ─── the local model ────────────────────────────────────────────────── */

/** DictaLM 3.0 (Hebrew) in a local Ollama, when installed. */
async function hebrewOllamaModel(): Promise<string | null> {
  try {
    const { getBaseUrl, listOllamaModels } = await import("./ollamaProvider");
    const { isLocalOrigin } = await import("./policy");
    if (!isLocalOrigin(getBaseUrl())) return null;
    return (await listOllamaModels()).map((m) => m.name).find((n) => /dictalm/i.test(n)) ?? null;
  } catch {
    return null;
  }
}

async function viaModel(text: string, language: string, n: number, signal?: AbortSignal): Promise<{ sentences: string[]; engine: "ollama" | "webllm"; model?: string } | null> {
  const [{ runAgent }, { summarizerAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
  const dicta = language === "Hebrew" ? await hebrewOllamaModel() : null;
  const run = await runAgent(summarizerAgent, { text, extra: { language, sentences: n } }, { signal, ...(dicta ? { executor: "ollama" as const, patch: { model: dicta } } : {}) });
  if (run.status !== "ok" || typeof run.output !== "string") return null;
  const engine = run.executor === "webllm" ? "webllm" : run.executor === "ollama" ? "ollama" : null;
  if (!engine) return null;
  return { sentences: summarySentences(run.output), engine, model: run.model ?? undefined };
}

function languageOf(text: string): string {
  if (hebrewRatio(text) > 0.3) return "Hebrew";
  if (/[\u0600-\u06FF]/.test(text)) return "Arabic";
  return "the text's language";
}

const isEnglish = (text: string) => hebrewRatio(text) < 0.05 && /[A-Za-z]/.test(text) && !/[\u0400-\u04FF\u0600-\u06FF\u3040-\u30FF\u4E00-\u9FFF]/.test(text);

/* ─── layers ─────────────────────────────────────────────────────────── */

/**
 * Summarise `text` on this device. Every returned sentence is in `text`
 * (word for word, with "…" for words left out).
 */
export async function summarize(text: string, opts: SummarizeOptions = {}): Promise<SummaryResult> {
  const n = opts.sentences ?? 5;
  const source = text.trim();
  const check = (sents: string[]): Grounding => ground(sents, source, quoteContained);
  if (!source) return { sentences: [], engine: "extractive", grounded: 1, dropped: 0, layers: 0 };

  // 1. Chrome's Summarizer, English only, when it stays in the text.
  if (!opts.noChrome && isEnglish(source)) {
    const out = await viaChrome(source, opts.signal);
    if (out?.length) {
      const g = check(out);
      if (g.rate >= MIN_GROUNDED && g.kept.length) return { sentences: g.kept, engine: "chrome", grounded: g.rate, dropped: g.dropped.length, layers: 1 };
      log.debug(`chrome summarizer: ${g.dropped.length}/${out.length} sentences not in the text — using the local model`);
    }
  }
  if (opts.signal?.aborted) throw new DOMException("Aborted", "AbortError");

  // 2. The local model, in layers: each section, then the section summaries.
  const language = languageOf(source);
  try {
    const parts = sections(source);
    let engine: "ollama" | "webllm" | null = null;
    let model: string | undefined;
    let total = 0;
    let keptAll: string[] = [];
    for (const part of parts) {
      const r = await viaModel(part, language, parts.length > 1 ? 3 : n, opts.signal);
      if (!r) {
        keptAll = [];
        engine = null;
        break;
      }
      engine = r.engine;
      model = r.model;
      total += r.sentences.length;
      keptAll.push(...check(r.sentences).kept);
    }
    if (engine && keptAll.length) {
      let sentences = keptAll;
      let rate = total ? keptAll.length / total : 1;
      let dropped = total - keptAll.length;
      if (parts.length > 1 && keptAll.length > n) {
        // The last layer: a summary of the section summaries, checked against the whole text.
        const r = await viaModel(keptAll.join("\n"), language, n, opts.signal);
        if (r?.sentences.length) {
          const g = check(r.sentences);
          if (g.kept.length) {
            sentences = g.kept;
            rate = (keptAll.length + g.kept.length) / (total + r.sentences.length);
            dropped += g.dropped.length;
          }
        }
      }
      if (rate >= MIN_GROUNDED || sentences.length) return { sentences, engine, model, grounded: rate, dropped, layers: parts.length };
    }
  } catch (e) {
    if (opts.signal?.aborted || (e as Error)?.name === "AbortError") throw e;
    log.warn("local summary failed; extractive summary instead", e);
  }

  // 3. No local model (or nothing usable): the extractive layer.
  const sentences = extractiveSummary(source, n);
  return { sentences, engine: "extractive", grounded: 1, dropped: 0, layers: 1 };
}
