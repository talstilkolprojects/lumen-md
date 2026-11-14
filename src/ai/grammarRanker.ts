/**
 * The model seam of the Hebrew grammar checker (plan W5.3). The rules
 * (./hebrewGrammar.ts) find and fix; a local model may then judge each
 * grammar finding — is the corrected sentence better Hebrew than the
 * original? — and drop the ones it rejects. Off by default: with no ranker
 * the rules' findings are shown as they are and nothing leaves the page.
 *
 * `ollamaGrammarRanker` asks a local Ollama model (DictaLM 3.0 1.7B, Apache
 * 2.0, in the catalog from W2.4) to choose between the two sentences. It
 * only talks to this computer (localhost / 127.0.0.1 / [::1]); any other
 * address is refused.
 */
import type { GrammarMatch } from "./grammar";

/** Probability (0–1) that `corrected` is the better sentence. */
export type GrammarRanker = (original: string, corrected: string, signal?: AbortSignal) => Promise<number>;

let ranker: GrammarRanker | null = null;
/** Findings the ranker judges below this are dropped. */
export const KEEP_ABOVE = 0.3;

export function registerGrammarRanker(r: GrammarRanker | null): void {
  ranker = r;
}

function sentenceAround(text: string, m: GrammarMatch): { start: number; end: number } {
  const before = text.slice(0, m.offset);
  const start = Math.max(before.lastIndexOf("."), before.lastIndexOf("!"), before.lastIndexOf("?"), before.lastIndexOf("\n")) + 1;
  const rest = text.slice(m.offset + m.length).search(/[.!?\n]/);
  return { start, end: rest < 0 ? text.length : m.offset + m.length + rest + 1 };
}

/** Whether a ranker is registered (the shipped path registers one only when the user turned the model on). */
export function hasGrammarRanker(): boolean {
  return ranker !== null;
}

/**
 * The ranker's time budget per check (plan W10.B9). When the model has not
 * judged every finding within it, the rules' findings are shown as they are:
 * a slow model never holds up the squiggles.
 */
export const RANK_BUDGET_MS = 300;

/**
 * Keep the findings the ranker accepts (all of them without a ranker, when
 * it fails, or when it runs past `budgetMs`). Only grammar findings are judged.
 */
export async function rankFindings(text: string, matches: GrammarMatch[], r: GrammarRanker | null = ranker, budgetMs: number = RANK_BUDGET_MS): Promise<GrammarMatch[]> {
  if (!r) return matches;
  const ac = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const late = new Promise<GrammarMatch[]>((resolve) => {
    timer = setTimeout(() => {
      ac.abort();
      resolve(matches);
    }, budgetMs);
  });
  try {
    return await Promise.race([judge(text, matches, r, ac.signal), late]);
  } finally {
    clearTimeout(timer);
  }
}

async function judge(text: string, matches: GrammarMatch[], r: GrammarRanker, signal: AbortSignal): Promise<GrammarMatch[]> {
  const out: GrammarMatch[] = [];
  for (const m of matches) {
    if (!m.rule.id.startsWith("HE_") || m.rule.category !== "GRAMMAR" || !m.replacements.length) {
      out.push(m);
      continue;
    }
    const { start, end } = sentenceAround(text, m);
    const original = text.slice(start, end).trim();
    const corrected = (text.slice(start, m.offset) + m.replacements[0] + text.slice(m.offset + m.length, end)).trim();
    if (signal.aborted) return matches;
    try {
      if ((await r(original, corrected, signal)) >= KEEP_ABOVE) out.push(m);
    } catch {
      out.push(m);
    }
  }
  return out;
}

const LOOPBACK = new Set(["localhost", "127.0.0.1", "[::1]"]);

/** A ranker backed by a local Ollama model. Refuses any non-loopback address. */
export function ollamaGrammarRanker(baseUrl: string, model: string, fetchImpl: typeof fetch = fetch): GrammarRanker {
  const u = new URL(baseUrl);
  if (!LOOPBACK.has(u.hostname)) throw new Error("the grammar model runs on this computer only (localhost)");
  return async (original, corrected, signal) => {
    const prompt = `איזה משפט כתוב בעברית תקינה יותר? ענה באות אחת בלבד.\nA: ${original}\nB: ${corrected}\nתשובה:`;
    // privacy-ledger: local-ai — Ollama on this computer (loopback checked above), "Ollama (this machine / LAN)".
    const res = await fetchImpl(new URL("/api/generate", u).href, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ model, prompt, stream: false, options: { temperature: 0, num_predict: 2 } }), signal });
    if (!res.ok) throw new Error(`Ollama ${res.status}`);
    const answer = String(((await res.json()) as { response?: string }).response ?? "").trim().toUpperCase();
    return answer.startsWith("B") ? 0.9 : answer.startsWith("A") ? 0.1 : 0.5;
  };
}
