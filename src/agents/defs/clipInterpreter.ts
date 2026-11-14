/**
 * clipInterpreter — the clip interpreter's model call (plan W2.14): answers
 * the prompt variables of a clip template from the page, as one JSON object.
 * The caller (src/research/clipInterpreter.ts) builds the request — the
 * prompts and the page text, already sanitised and wrapped as untrusted —
 * and always forces a local executor (Ollama on a local address, or the
 * in-browser model). Lazy: imported only when a clip has prompt variables.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";

export interface ClipInterpreterInput extends AgentInput {
  /** The prompts and the guarded page text. */
  text: string;
  extra: { system: string };
}

export const clipInterpreterAgent: AgentDefinition<ClipInterpreterInput, string> = registerAgent<ClipInterpreterInput, string>({
  id: "clipInterpreter",
  commandId: "clip.interpret",
  description: "Answer a clip template's prompt variables from the clipped page (local model only)",
  system: (input) => input.extra.system,
  user: (input) => input.text,
  // Local executors only; the caller forces one of them as well.
  executorPreference: ["ollama", "webllm"],
  tier: "small",
  maxRetries: 0,
  temperature: 0.1,
  maxTokens: 600,
  // Answers are per page: never served from the response cache.
  cache: false,
  // The page decides the language of each answer; a field may ask for another.
  language: "any",
});
