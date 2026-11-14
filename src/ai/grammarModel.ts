/**
 * Wires the local grammar model into the shipped checker (plan W10.B9,
 * audit W5.3). `registerGrammarRanker` used to be called only by tests, so
 * the model step of W5.3 never ran in the app.
 *
 * Off by default. When the user turns it on (`lumen.grammar.he.model` =
 * "on"), this asks Ollama on this computer which models are installed and,
 * when one handles Hebrew, registers `ollamaGrammarRanker` for it. With the
 * setting off, nothing is requested and no ranker is registered, so
 * checking costs nothing extra while typing. `rankFindings` caps the model
 * at RANK_BUDGET_MS (300 ms) per check.
 */
import { getBaseUrl } from "./ollamaProvider";
import { hebrewSupportOf } from "./modelCatalog";
import { ollamaGrammarRanker, registerGrammarRanker } from "./grammarRanker";

export const GRAMMAR_MODEL_KEY = "lumen.grammar.he.model";

export function grammarModelEnabled(): boolean {
  try {
    return localStorage.getItem(GRAMMAR_MODEL_KEY) === "on";
  } catch {
    return false;
  }
}

export function setGrammarModelEnabled(on: boolean): void {
  try {
    if (on) localStorage.setItem(GRAMMAR_MODEL_KEY, "on");
    else localStorage.removeItem(GRAMMAR_MODEL_KEY);
  } catch {
    // why: private mode / blocked storage — the setting then lasts for this session only (setupGrammarRanker still runs).
  }
}

/** The installed model to judge Hebrew suggestions with: DictaLM first, then any model with strong Hebrew. */
export function pickGrammarModel(names: string[]): string | null {
  const dicta = names.find((n) => /dictalm/i.test(n));
  if (dicta) return dicta;
  return names.find((n) => hebrewSupportOf(n) === "strong") ?? null;
}

export type GrammarModelSetup =
  | { registered: true; model: string }
  | { registered: false; reason: "off" | "not-local" | "no-ollama" | "no-hebrew-model" };

/**
 * Register (or clear) the grammar ranker from the setting and what Ollama has.
 * `fetchImpl` and `baseUrl` are for tests; the app passes nothing.
 */
export async function setupGrammarRanker(opts: { enabled?: boolean; baseUrl?: string; fetchImpl?: typeof fetch } = {}): Promise<GrammarModelSetup> {
  const enabled = opts.enabled ?? grammarModelEnabled();
  registerGrammarRanker(null);
  if (!enabled) return { registered: false, reason: "off" };
  const baseUrl = opts.baseUrl ?? getBaseUrl();
  const fetchImpl = opts.fetchImpl ?? fetch;
  let host: string;
  try {
    host = new URL(baseUrl).hostname;
  } catch {
    return { registered: false, reason: "not-local" };
  }
  if (!["localhost", "127.0.0.1", "[::1]"].includes(host)) return { registered: false, reason: "not-local" };
  let names: string[];
  try {
    // privacy-ledger: local-ai — Ollama on this computer (loopback checked above), "Ollama (this machine / LAN)"; only when the user turned the grammar model on.
    const res = await fetchImpl(new URL("/api/tags", baseUrl).href, { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return { registered: false, reason: "no-ollama" };
    names = (((await res.json()) as { models?: Array<{ name?: string }> }).models ?? []).map((m) => String(m.name ?? "")).filter(Boolean);
  } catch {
    return { registered: false, reason: "no-ollama" };
  }
  const model = pickGrammarModel(names);
  if (!model) return { registered: false, reason: "no-hebrew-model" };
  registerGrammarRanker(ollamaGrammarRanker(baseUrl, model, fetchImpl));
  return { registered: true, model };
}
