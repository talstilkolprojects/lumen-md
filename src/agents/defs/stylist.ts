/**
 * stylist — builds a style profile from the user's own writing, the local
 * replacement for fine-tuning: a short list of concrete rules, a tone and
 * a few verbatim example sentences that the writing agents then follow.
 * Examples must be quoted verbatim from the samples (checked).
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { fail, ok } from "./shared";

export interface StylistInput extends AgentInput {
  /** Excerpts of the user's notes, separated by "\n---\n". */
  text: string;
}

export interface StyleProfileOut {
  tone: string;
  rules: string[];
  examples: string[];
}

export const stylistAgent: AgentDefinition<StylistInput, StyleProfileOut> = registerAgent<StylistInput, StyleProfileOut>({
  id: "stylist",
  commandId: "ai.styleProfile",
  description: "Describe the user's writing style from their notes",
  system:
    "You analyse a writer's style from excerpts of their own notes. Output ONLY a JSON object: " +
    '{"tone": "one sentence", "rules": ["5 to 10 concrete, checkable rules about vocabulary, sentence length, ' +
    'structure, formatting habits, language mix"], "examples": ["3 to 5 short sentences copied VERBATIM from the ' +
    'excerpts that show the style"]}. Describe how they write, not what they write about. Write the tone and ' +
    "rules in the language the excerpts are mostly written in.",
  user: (input) => `Excerpts:\n${input.text}`,
  // The excerpts are sampled with list_files + read_file (ai/styleProfiles); the model may read more (5.3.3).
  tools: pickTools("list_files", "read_file"),
  maxSteps: 4,
  outputSchema: {
    type: "object",
    properties: {
      tone: { type: "string", minLength: 3 },
      rules: { type: "array", items: { type: "string", minLength: 3 }, minItems: 3, maxItems: 12 },
      examples: { type: "array", items: { type: "string", minLength: 3 }, minItems: 1, maxItems: 6 },
    },
    required: ["tone", "rules", "examples"],
  },
  validators: [
    {
      name: "verbatim-examples",
      check: (out, input) => {
        const text = (input.text ?? "").replace(/\s+/g, " ");
        const kept = out.examples.filter((e) => text.includes(e.replace(/\s+/g, " ").trim()));
        return kept.length ? ok : fail("no example is quoted verbatim from the excerpts", "Copy example sentences exactly.");
      },
    },
  ],
  tier: "medium",
  temperature: 0.2,
  maxTokens: 900,
});
