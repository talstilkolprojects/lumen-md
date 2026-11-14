/**
 * The commands that used to call `chat()` directly (plan 5.5): every one
 * now runs as an agent, so it goes through the executors (local first), the
 * AI policy, the quota, the injection guard and the trace like the rest.
 *
 *   completer        ghost text (Ctrl-Space) and the automatic inline suggestion
 *   rewriter         WYSIWYG "AI Rewrite" — follows the style profile (5.5.2)
 *   answerer         Ask Workspace: an answer from the notes, with [n] citations
 *   memo-summarizer  the two-bullet summary of a voice memo
 *   builder-arch / builder-test / builder-docs   the builder's three text stages
 *   batch            a batch job's step (`ai/batch.ts`), on a local executor
 */

import type { AgentDefinition, AgentInput, ValidationResult } from "../types";
import { registerAgent } from "../registry";
import { nonEmptyValidator } from "../tools/validate";
import { clip, fail, ok, stripFences } from "./shared";
import { PROMPTS } from "../../ai/prompts";
import { validateBatchAnswer, type BatchValidateOp } from "../../ai/batchValidate";
import { styleInstruction } from "../../ai/styleProfiles";

/* ─── completer ─────────────────────────────────────────────────────────── */

export interface CompleterInput extends AgentInput {
  /** The text before the cursor. */
  text: string;
  /** "ghost": Ctrl-Space, the next few words. "inline": the automatic suggestion that completes the line. */
  extra: { mode: "ghost" | "inline" };
}

const INLINE_PROMPT =
  "You are an inline autocomplete assistant for a markdown editor. Given the current line fragment, output ONLY the completion text " +
  "(no quotes, no explanations, max 60 chars). Always reply in the same language as the fragment.";

/** A completion is one short line: no preamble, no quotes, no repeat of the text. */
export function cleanCompletion(raw: string, before: string): string {
  let s = stripFences(raw).split("\n")[0] ?? "";
  s = s.replace(/^\s*(?:completion|answer)\s*:\s*/i, "").replace(/^["'“”]+|["'“”]+$/g, "");
  // A model that repeats the line first: keep only what comes after it.
  const tail = before.trim().split("\n").pop() ?? "";
  if (tail && s.startsWith(tail)) s = s.slice(tail.length);
  return s.trimEnd();
}

export const completerAgent: AgentDefinition<CompleterInput, string> = registerAgent<CompleterInput, string>({
  id: "completer",
  commandId: "editor.ghostText",
  description: "Complete the text at the cursor (ghost text, inline suggestion)",
  system: (input) => (input.extra.mode === "ghost" ? PROMPTS.autocomplete : INLINE_PROMPT),
  user: (input) => (input.extra.mode === "ghost" ? input.text.slice(-500) : `Complete: "${input.text}"`),
  parse: (text, input) => cleanCompletion(text, input.text),
  validators: [{ name: "short", check: (out) => (out.length <= 200 ? ok : fail("too long for a completion")) }],
  // One keystroke pause, one request: no retries, no critic.
  maxRetries: 0,
  language: "any",
  tier: "tiny",
  temperature: 0.3,
  maxTokens: 40,
});

/* ─── rewriter ──────────────────────────────────────────────────────────── */

export interface RewriterInput extends AgentInput {
  /** The selected text. */
  text: string;
  extra: { instruction: string };
}

export const rewriterAgent: AgentDefinition<RewriterInput, string> = registerAgent<RewriterInput, string>({
  id: "rewriter",
  commandId: "wysiwyg.aiRewrite",
  description: "Rewrite the selection as instructed (AI Rewrite)",
  // The user's style profile applies to rewriting too (plan 5.5.2, T17).
  system: () => [PROMPTS.rewrite, styleInstruction()].filter(Boolean).join("\n\n"),
  user: (input) => `Instruction: ${clip(input.extra.instruction, 500)}\n\nText: ${clip(input.text, 8000)}`,
  parse: (text) => stripFences(text),
  validators: [nonEmptyValidator()],
  // "Translate to Spanish" is a rewrite: the instruction decides the language.
  language: "any",
  maxRetries: 1,
  tier: "small",
  temperature: 0.5,
  maxTokens: 2000,
});

/* ─── answerer ──────────────────────────────────────────────────────────── */

export interface AnswererInput extends AgentInput {
  /** The question. */
  text: string;
  extra: {
    /** The context files, already packed (and guarded where they are outside content). */
    context: string;
    /** Earlier turns of this conversation. */
    history?: Array<{ role: "user" | "assistant"; content: string }>;
    /** How to cite (ai/vaultCitations CITE_INSTRUCTIONS). */
    citeInstructions?: string;
  };
}

export const answererAgent: AgentDefinition<AnswererInput, string> = registerAgent<AnswererInput, string>({
  id: "answerer",
  commandId: "search.askWorkspace",
  description: "Answer a question from the workspace notes, with citations (Ask Workspace)",
  system: (input) => [PROMPTS.ragAssistant, input.extra.citeInstructions ?? ""].filter(Boolean).join("\n\n"),
  user: (input) => {
    const history = (input.extra.history ?? []).slice(-6);
    const earlier = history.length ? `Earlier in this conversation:\n${history.map((m) => `${m.role === "user" ? "Q" : "A"}: ${clip(m.content, 1500)}`).join("\n")}\n\n` : "";
    return `${earlier}Context Files:\n${input.extra.context}\n\nQuestion: ${clip(input.text, 2000)}`;
  },
  validators: [nonEmptyValidator()],
  maxRetries: 1,
  tier: "small",
  temperature: 0.3,
  maxTokens: 1500,
});

/* ─── memo summarizer ───────────────────────────────────────────────────── */

export interface MemoInput extends AgentInput {
  /** The transcript. */
  text: string;
}

/** Two short bullets. */
export function checkBullets(out: string): ValidationResult {
  const bullets = out.split("\n").filter((l) => /^\s*[-*•]\s+\S/.test(l));
  return bullets.length >= 1 && bullets.length <= 4 ? ok : fail(`expected two bullets, got ${bullets.length}`, "Return exactly two short bullets (`- …`), nothing else.");
}

export const memoSummarizerAgent: AgentDefinition<MemoInput, string> = registerAgent<MemoInput, string>({
  id: "memo-summarizer",
  commandId: "voice.memo",
  description: "Summarise a voice memo in two bullets",
  system: PROMPTS.summarize,
  user: (input) => clip(input.text, 8000),
  parse: (text) => stripFences(text),
  validators: [{ name: "bullets", check: (out) => checkBullets(out) }],
  maxRetries: 1,
  tier: "tiny",
  temperature: 0.2,
  maxTokens: 160,
});

/* ─── builder stages ────────────────────────────────────────────────────── */

export interface BuilderStageInput extends AgentInput {
  /** The stage's request (spec, source file, file list). */
  text: string;
  /** The stage's system prompt (ai/productAgent.ts). */
  extra: { system: string };
}

function builderStage(id: string, description: string, temperature: number): AgentDefinition<BuilderStageInput, string> {
  return registerAgent<BuilderStageInput, string>({
    id,
    commandId: "product.build",
    description,
    system: (input) => input.extra.system,
    user: (input) => input.text,
    validators: [nonEmptyValidator()],
    language: "any",
    maxRetries: 1,
    tier: "medium",
    temperature,
    maxTokens: 4000,
  });
}

export const builderArchAgent = builderStage("builder-arch", "Design the architecture of a generated product", 0.5);
export const builderTestAgent = builderStage("builder-test", "Write tests for a generated file", 0.3);
export const builderDocsAgent = builderStage("builder-docs", "Write the README of a generated product", 0.5);

/* ─── batch step ────────────────────────────────────────────────────────── */

export interface BatchStepInput extends AgentInput {
  /** The note text (or the step's input). */
  text: string;
  /** `op` + `source` (the note as sent): the job's validator checks the answer against them (plan 5.8). */
  extra: { system: string; maxTokens: number; op?: BatchValidateOp; source?: string };
}

/** Plan 5.8: each job's answers pass its operation's validator; a rejection goes to the critic. */
const batchOpValidator = {
  name: "batch-op",
  check: (output: string, input: AgentInput): ValidationResult => {
    const extra = (input as BatchStepInput).extra;
    if (!extra?.op) return { ok: true };
    return validateBatchAnswer(extra.op, output, extra.source ?? "");
  },
};

export const batchAgent: AgentDefinition<BatchStepInput, string> = registerAgent<BatchStepInput, string>({
  id: "batch",
  commandId: "ai.batch",
  description: "One step of a batch job (summarise, translate, tag… a note)",
  system: (input) => input.extra.system,
  user: (input) => input.text,
  validators: [nonEmptyValidator(), batchOpValidator],
  // The job's operation decides the language (a batch translation).
  language: "any",
  // One retry with the critic's hint after a rejected answer; a note that
  // still fails is counted as failed with its reason, never written.
  maxRetries: 1,
  tier: "small",
  temperature: 0.2,
  maxTokens: (input) => input.extra.maxTokens,
});
