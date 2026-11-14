/**
 * tagger — `tools.autoTag`. Proposes 3–7 tags for a document, preferring
 * the vocabulary already used in the workspace. One shot, JSON output
 * checked against the schema; tags are normalised afterwards (Unicode
 * letters allowed, so Hebrew tags survive).
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { clip, fail, ok, scriptOf } from "./shared";

export interface TaggerInput extends AgentInput {
  text: string;
  /** Tags to show besides the workspace's (the runtime fetches those with list_tags). */
  extra?: { existing?: string[] };
}

export interface TaggerOutput {
  tags: string[];
}

/** lowercase, kebab-case, Unicode letters/digits only, deduped, at most 7. */
export function normalizeTags(raw: unknown[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const r of raw) {
    const t = String(r)
      .trim()
      .toLowerCase()
      .replace(/^#+/, "")
      .replace(/[\s_/]+/g, "-")
      .replace(/[^\p{L}\p{N}-]/gu, "")
      .replace(/-{2,}/g, "-")
      .replace(/^-|-$/g, "");
    if (t.length > 1 && t.length < 40 && !seen.has(t)) {
      seen.add(t);
      out.push(t);
    }
    if (out.length >= 7) break;
  }
  return out;
}

export const taggerAgent: AgentDefinition<TaggerInput, TaggerOutput> = registerAgent({
  id: "tagger",
  splittable: true,
  commandId: "tools.autoTag",
  description: "Suggest tags for the open document from the workspace vocabulary",
  system: (input) =>
    "You are a tag-suggestion assistant. The user shares a markdown document and the tags they already use " +
    "across their notes. Suggest 3 to 7 concise lowercase kebab-case tags that capture the document's topics. " +
    "Prefer tags from the existing pool (the list_tags result: the workspace's tags, most used first) when they fit. " +
    "Write tags in the document's own language" +
    (scriptOf(input.text) === "hebrew" ? " (Hebrew)" : "") +
    '. Output ONLY a JSON object of the form {"tags": ["tag-one", "tag-two"]}.',
  user: (input) =>
    (input.extra?.existing?.length ? `Also consider these tags: ${input.extra.existing.slice(0, 80).join(", ")}\n\n` : "") + `Document:\n${clip(input.text, 6000)}`,
  tools: pickTools("list_tags"),
  // The workspace's vocabulary, fetched through the runtime (5.3.1).
  context: () => [{ tool: "list_tags", args: { limit: 80 } }],
  maxSteps: 3,
  outputSchema: {
    type: "object",
    properties: { tags: { type: "array", items: { type: "string", minLength: 1, maxLength: 60 }, minItems: 1, maxItems: 10 } },
    required: ["tags"],
  },
  validators: [
    {
      name: "tags",
      check: (out) => (normalizeTags(out.tags).length ? ok : fail("no usable tags", "Return at least one short tag.")),
    },
  ],
  tier: "small",
  temperature: 0.2,
  maxTokens: 200,
  cache: true,
});
