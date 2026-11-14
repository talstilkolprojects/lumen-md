/**
 * The user's AI mode — economy / balanced / quality (`lumen.ai.mode`).
 *
 * One small module (type imports only), so both the context packer (how
 * much of the notes goes in) and the agent runtime (which local model
 * tier runs, plan 5.7) read the same key without pulling each other in.
 */

import type { ModelTier } from "../agents/types";

export type AiMode = "economy" | "balanced" | "quality";

const KEY = "lumen.ai.mode";

/** The user's AI mode; balanced by default. */
export function getAiMode(): AiMode {
  try {
    const v = localStorage.getItem(KEY);
    return v === "economy" || v === "quality" ? v : "balanced";
  } catch {
    return "balanced";
  }
}

export function setAiMode(mode: AiMode): void {
  try {
    if (mode === "balanced") localStorage.removeItem(KEY);
    else localStorage.setItem(KEY, mode);
  } catch {
    /* storage denied */
  }
}

const TIERS: readonly ModelTier[] = ["tiny", "small", "medium", "large"];

/**
 * The tier a local executor (Ollama, web-llm) runs for an agent, by the
 * AI mode (plan 5.7): economy one tier down, quality one tier up,
 * balanced as the agent declares. The cloud chat executor keeps its own
 * routing (llm.ts `routeOptions`), so the runtime does not shift it. The
 * device budget still applies afterwards: "quality" on a small GPU gets
 * the largest model that fits.
 */
export function tierForMode(tier: ModelTier, mode: AiMode): ModelTier {
  const i = TIERS.indexOf(tier);
  if (mode === "economy") return TIERS[Math.max(0, i - 1)];
  if (mode === "quality") return TIERS[Math.min(TIERS.length - 1, i + 1)];
  return tier;
}
