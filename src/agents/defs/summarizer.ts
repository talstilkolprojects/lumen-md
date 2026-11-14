/**
 * summarizer (plan 6.11) — a grounded summary on a local model: every
 * sentence copied from the text (shortened with "…" where words are left
 * out), so each one can be checked word for word against the source. Only
 * local executors: a summary of a note never goes to a cloud provider.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok } from "./shared";
import { ground, summarySentences } from "../../ai/summarizeCore";
import { quoteContained } from "../../research/citations";

export interface SummarizerInput extends AgentInput {
  text: string;
  extra: { language: string; sentences: number };
}

export const SUMMARY_MAX_CHARS = 8000;

/** Share of a summary's sentences that must be in the text before it is accepted (the rest are dropped later). */
export const SUMMARY_MIN_GROUNDED = 0.8;

export const summarizerAgent: AgentDefinition<SummarizerInput, string> = registerAgent<SummarizerInput, string>({
  id: "summarizer",
  commandId: "ai.summarize",
  description: "Summarise a text with sentences copied from it (grounded, on this device)",
  system: (input) =>
    `You summarise a text written in ${input.extra.language}. Write about ${input.extra.sentences} sentences that together give its main points, in the text's own language. ` +
    "Every sentence MUST be copied from the text word for word. You may shorten a sentence by leaving words out; mark each place where words were left out with …. " +
    "Do not write any sentence of your own, no introduction, no headings, no bullets. One sentence per line.",
  user: (input) => clip(input.text, SUMMARY_MAX_CHARS),
  validators: [
    {
      name: "grounded",
      check: (out, input) => {
        const sents = summarySentences(out);
        if (!sents.length) return fail("no sentences", "Copy the main sentences from the text, one per line.");
        const g = ground(sents, input.text ?? "", quoteContained);
        return g.rate >= SUMMARY_MIN_GROUNDED
          ? ok
          : fail(`${g.dropped.length} of ${sents.length} sentences are not in the text`, "Copy every sentence word for word from the text; only leave words out, marked with ….");
      },
    },
  ],
  // Local models only (plan 6.11): Ollama, then the in-browser model.
  executorPreference: ["ollama", "webllm"],
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 700,
});
