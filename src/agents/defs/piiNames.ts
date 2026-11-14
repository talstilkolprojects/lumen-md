/**
 * pii-names (plan 2.6, audit W10.C23): the PII redactor's fallback name
 * finder on Ollama on this machine, when no converted name model is cached.
 * The text is the one about to be sent to a cloud provider, so it goes
 * only to the local executor. The answer is held to the text: every name
 * must appear in it word for word.
 */
import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok } from "./shared";

export const piiNamesAgent: AgentDefinition<AgentInput & { text: string }, { names: string[] }> = registerAgent<AgentInput & { text: string }, { names: string[] }>({
  id: "pii-names",
  description: "List the people's names in a text, for redaction before a cloud request (Ollama on this machine only)",
  system: () =>
    'List every person\'s name in the text, exactly as written (in any language). Answer JSON {"names": [...]}; an empty list when there are none. ' +
    "Only people: no places, organisations or products.",
  user: (input) => clip(input.text, 6000),
  outputSchema: { type: "object", properties: { names: { type: "array", items: { type: "string" }, maxItems: 200 } }, required: ["names"], additionalProperties: false },
  validators: [
    {
      name: "in-text",
      check: (out, input) => {
        const missing = (out?.names ?? []).filter((n) => n.trim() && !(input.text ?? "").includes(n.trim()));
        return missing.length ? fail(`${missing.length} names are not in the text`, "Copy each name exactly as it is written in the text.") : ok;
      },
    },
  ],
  executorPreference: ["ollama"],
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 400,
});
