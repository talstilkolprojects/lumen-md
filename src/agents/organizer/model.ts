/**
 * The organizer's model judge (plan W2.1 step 1, audit W10.C16): a local
 * model re-scores each suggestion before it reaches the review screen.
 *
 * Only local executors (Ollama, then the in-browser model): the notes
 * never leave the device. And only with the user's consent: the panel's
 * "re-score with the local model" switch (`ORGANIZER_MODEL_KEY`). Without
 * consent or without a local model nothing is registered and the
 * analysis stays deterministic (analyze.ts). Whatever the model says, the
 * suggestion is still only staged: the user approves it in the review
 * screen.
 */
import type { AgentDefinition, AgentInput } from "../types";
import { registerAgent } from "../registry";
import { clip, fail, ok } from "../defs/shared";
import { setOrganizerModel, type OrganizerModel } from "./job";
import type { OrganizerSuggestion } from "./analyze";

export const ORGANIZER_MODEL_KEY = "lumen.organizer.model";

export function organizerModelConsent(): boolean {
  try {
    return localStorage.getItem(ORGANIZER_MODEL_KEY) === "on";
  } catch {
    return false;
  }
}

export function setOrganizerModelConsent(on: boolean): void {
  try {
    if (on) localStorage.setItem(ORGANIZER_MODEL_KEY, "on");
    else localStorage.removeItem(ORGANIZER_MODEL_KEY);
  } catch {
    /* why: storage denied: the switch stays off */
  }
}

interface JudgeInput extends AgentInput {
  text: string;
}

export const organizerJudgeAgent: AgentDefinition<JudgeInput, { confidence: number }> = registerAgent<JudgeInput, { confidence: number }>({
  id: "organizer-judge",
  description: "Rate how right one vault-organizer suggestion is (local model only)",
  system: () =>
    "You check one suggestion for organising a notes vault: a link, a tag, a merge or a map of content. " +
    'Answer with JSON {"confidence": <0..1>}: how likely the user wants this change, judging only from the quoted note text. ' +
    "1 means clearly right, 0 clearly wrong.",
  user: (input) => clip(input.text, 4000),
  outputSchema: { type: "object", properties: { confidence: { type: "number", minimum: 0, maximum: 1 } }, required: ["confidence"], additionalProperties: false },
  validators: [{ name: "range", check: (out) => (typeof out?.confidence === "number" && out.confidence >= 0 && out.confidence <= 1 ? ok : fail("confidence must be between 0 and 1", 'Answer {"confidence": <a number from 0 to 1>}.')) }],
  executorPreference: ["ollama", "webllm"],
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0,
  maxTokens: 40,
});

/** What the judge reads: the suggestion, its reason, and the quoted note. */
export function judgeText(s: OrganizerSuggestion, notes: ReadonlyMap<string, string>, reason: string): string {
  const note = notes.get(s.quote.path) ?? "";
  return [`Suggestion: ${s.kind} (${s.id})`, `Why: ${reason}`, `Quote from ${s.quote.path}: ${s.quote.text}`, `Note (start):\n${note.slice(0, 1500)}`].join("\n");
}

/** The judge as the organizer's model seam, over the agent runtime. */
export function localOrganizerModel(reason: (s: OrganizerSuggestion) => string = (s) => s.reason.key): OrganizerModel {
  return async (s, notes, signal) => {
    const { runAgentOrThrow } = await import("../runtime");
    const out = await runAgentOrThrow(organizerJudgeAgent, { text: judgeText(s, notes, reason(s)) }, { signal });
    return { confidence: Math.round(out.confidence * 100) / 100 };
  };
}

/** Register the judge when the user consented (true), or unregister it. Called before each run. */
export function registerOrganizerModel(consent = organizerModelConsent()): boolean {
  setOrganizerModel(consent ? localOrganizerModel() : null);
  return consent;
}
