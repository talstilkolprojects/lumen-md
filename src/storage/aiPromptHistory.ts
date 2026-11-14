/**
 * localStorage-backed history for the AI inline prompt (AiInlinePrompt).
 * Keeps the last 20 submitted prompts, most recent first, deduped
 * (re-submitting a prompt bumps it to the top). Same pattern as
 * ./searchHistory: every storage access is wrapped in try/catch with an
 * in-memory fallback for private mode / blocked storage.
 */

const STORAGE_KEY = "lumen.ai.promptHistory";
export const AI_PROMPT_HISTORY_MAX = 20;

let memoryFallback: string[] = [];

function load(): string[] {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return memoryFallback.slice();
    const arr: unknown = JSON.parse(raw);
    return Array.isArray(arr)
      ? arr.filter((s): s is string => typeof s === "string").slice(0, AI_PROMPT_HISTORY_MAX)
      : [];
  } catch {
    return memoryFallback.slice();
  }
}

function save(history: string[]): void {
  memoryFallback = history.slice();
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(history));
  } catch {
    /* why: quota / private mode — memory fallback already updated */
  }
}

/** Record a submitted prompt (trimmed; empty strings ignored). */
export function rememberAiPrompt(prompt: string): void {
  const p = prompt.trim();
  if (!p) return;
  const next = [p, ...load().filter((s) => s !== p)].slice(0, AI_PROMPT_HISTORY_MAX);
  save(next);
}

/** Recent prompts, most recent first. */
export function getAiPromptHistory(): string[] {
  return load();
}

/** Forget all prompts. */
export function clearAiPromptHistory(): void {
  memoryFallback = [];
  try {
    localStorage.removeItem(STORAGE_KEY);
  } catch {
    /* why: storage denied: the in-memory history is cleared, nothing was persisted */
  }
}
