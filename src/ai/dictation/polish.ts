/**
 * Optional punctuation pass through the LOCAL model (plan 6.1): only when
 * the active provider runs on this device (WebGPU, or Ollama on this
 * machine / LAN), never a cloud model — dictated text stays local. The
 * model may add punctuation and nothing else: an answer that changes the
 * words (beyond a few) is discarded and the rule-based text kept.
 */
import { normalizeWords, wordEditDistance } from "./textMetrics";

export const POLISH_PROMPT =
  "Add punctuation (. , ? ! : and paragraph breaks) to the dictated text below. Do not add, remove, reorder or correct any word. Keep the language. Reply with the text only.";

/** Words changed beyond this share of the input = the model rewrote the text: rejected. */
export const MAX_WORD_CHANGE = 0.1;

export interface PolishDeps {
  /** The active provider is on this device (checked by the caller). */
  localModelReady: () => boolean;
  /** The signal is the caller's cancel (Esc / "AI: Cancel", T55). */
  chat: (system: string, user: string, opts?: { signal?: AbortSignal }) => Promise<string>;
}

export async function polishDictation(text: string, deps: PolishDeps, signal?: AbortSignal): Promise<{ text: string; polished: boolean }> {
  if (!text.trim() || !deps.localModelReady()) return { text, polished: false };
  let answer: string;
  try {
    answer = (await deps.chat(POLISH_PROMPT, text, { signal })).trim();
  } catch {
    return { text, polished: false };
  }
  const a = normalizeWords(text);
  const b = normalizeWords(answer);
  if (!answer || wordEditDistance(a, b) > Math.max(1, Math.floor(a.length * MAX_WORD_CHANGE))) return { text, polished: false };
  return { text: answer, polished: true };
}
