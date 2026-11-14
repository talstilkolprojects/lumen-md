/**
 * proofreader — grammar and spelling on a local model, for when no
 * LanguageTool is reachable on this machine and the policy keeps the
 * public API off limits. The model quotes each problem; offsets are found
 * deterministically in the text (a model's own offsets are unreliable),
 * and issues whose quote is not in the text are dropped.
 */

import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { pickTools } from "../tools";
import { clip, fail, ok } from "./shared";

export interface ProofreaderInput extends AgentInput {
  text: string;
  extra: { language: string };
}

export interface ProofIssue {
  quote: string;
  message: string;
  replacement?: string;
}

export interface ProofreaderOutput {
  issues: ProofIssue[];
}

export const PROOF_MAX_CHARS = 6000;

export interface LocatedIssue {
  offset: number;
  length: number;
  message: string;
  replacements: string[];
}

/** Map quoted issues to offsets in `text`, in order, skipping quotes that are absent or no-op replacements. */
export function locateIssues(issues: ProofIssue[], text: string): LocatedIssue[] {
  const out: LocatedIssue[] = [];
  const used = new Set<number>();
  for (const i of issues) {
    if (!i || typeof i.quote !== "string" || !i.quote.trim()) continue;
    if (typeof i.replacement === "string" && i.replacement === i.quote) continue;
    let from = 0;
    let at = text.indexOf(i.quote, from);
    while (at >= 0 && used.has(at)) {
      from = at + 1;
      at = text.indexOf(i.quote, from);
    }
    if (at < 0) continue;
    used.add(at);
    out.push({ offset: at, length: i.quote.length, message: String(i.message ?? ""), replacements: typeof i.replacement === "string" && i.replacement ? [i.replacement] : [] });
  }
  return out.sort((a, b) => a.offset - b.offset);
}

export const proofreaderAgent: AgentDefinition<ProofreaderInput, ProofreaderOutput> = registerAgent<ProofreaderInput, ProofreaderOutput>({
  id: "proofreader",
  splittable: true,
  commandId: "tools.checkGrammar",
  description: "Find grammar and spelling problems with a local model",
  system: (input) =>
    `You are a careful proofreader for ${input.extra.language}. Find real grammar, spelling and punctuation errors ` +
    "in the user's text — not style preferences. Ignore Markdown syntax, code blocks, inline code and URLs. " +
    'Output ONLY a JSON object: {"issues": [{"quote": "exact text copied from the input that is wrong", ' +
    '"message": "short explanation", "replacement": "corrected text"}]}. Copy each quote verbatim (a few words, ' +
    'enough to be unique). If there are no errors, return {"issues": []}.',
  user: (input) => clip(input.text, PROOF_MAX_CHARS),
  outputSchema: {
    type: "object",
    properties: {
      issues: {
        type: "array",
        maxItems: 40,
        items: { type: "object", properties: { quote: { type: "string", minLength: 1 }, message: { type: "string" }, replacement: { type: "string" } }, required: ["quote", "message"] },
      },
    },
    required: ["issues"],
  },
  validators: [
    {
      name: "quotes",
      check: (out, input) => {
        if (!out.issues.length) return ok;
        return locateIssues(out.issues, input.text ?? "").length ? ok : fail("no quote appears verbatim in the text", "Copy each quote exactly from the input.");
      },
    },
  ],
  // The whole note, when the text given is only part of it (5.3.1, 5.3.3).
  tools: pickTools("get_document"),
  maxSteps: 3,
  tier: "small",
  temperature: 0,
  maxTokens: 1200,
  cache: true,
});
