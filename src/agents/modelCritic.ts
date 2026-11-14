/**
 * Stage 2 of the improvement agent: a small local model reads what went
 * wrong (the task, the failure, what was already tried) and proposes up
 * to three concrete suggestions in plain language, which the suggestions
 * panel shows next to the deterministic ones. It runs only after the
 * retries are exhausted, on the tiny tier, and never on itself.
 */

import { setModelCritic, type Failure, type Verdict } from "./critic";
import { pickExecutor } from "./executors";
import { checkJson } from "./tools/validate";
import type { RetryPatch, Suggestion } from "./types";

const SYSTEM =
  "You help a user whose AI command failed in a local-first markdown editor. Given the failure, propose at most 3 " +
  "short, concrete things THE USER can do (rephrase or shorten the input, select a smaller part, pick a larger local " +
  'model, check that Ollama is running…). Output ONLY JSON: {"diagnosis": "one sentence", "suggestions": ' +
  '[{"title": "imperative, ≤ 8 words", "detail": "one sentence"}], "retry": {"instruction": "one sentence the ' +
  'model should follow on a new attempt", "temperature": 0}}. Give "retry" only when a new attempt with that ' +
  "instruction is likely to work (the answer had the wrong format, language or length); omit it otherwise. " +
  "No suggestion may send data to the cloud.";

export async function modelReview(f: Failure, stage1: Verdict): Promise<Verdict | null> {
  if (f.agentId === "critic") return null;
  const { executor } = await pickExecutor();
  if (!executor) return null;
  const facts = {
    agent: f.agentId,
    failure: f.kind,
    reason: (f.reason ?? "").slice(0, 400),
    validator: f.label,
    attempts: f.attempt,
    tier: f.tier,
    inputChars: f.inputChars,
    alreadySuggested: stage1.suggestions.map((s) => s.id),
  };
  const res = await executor.chat({
    messages: [
      { role: "system", content: SYSTEM },
      { role: "user", content: JSON.stringify(facts) },
    ],
    tier: "tiny",
    temperature: 0,
    maxTokens: 300,
    signal: f.signal,
    schema: executor.supportsSchema()
      ? { type: "object", properties: { diagnosis: { type: "string" }, suggestions: { type: "array" }, retry: { type: "object", properties: { instruction: { type: "string" }, temperature: { type: "number" } } } }, required: ["suggestions"] }
      : undefined,
  });
  if (f.signal?.aborted) return null;
  const j = checkJson(res.content);
  if (!j.ok) return null;
  const v = j.value as { diagnosis?: unknown; suggestions?: unknown; retry?: unknown };
  const list = Array.isArray(v.suggestions) ? v.suggestions : [];
  const suggestions: Suggestion[] = list
    .filter((x): x is { title: string; detail?: string } => !!x && typeof (x as { title?: unknown }).title === "string")
    .slice(0, 3)
    .map((x, i) => ({ id: `model-${i}`, title: x.title.slice(0, 80), detail: typeof x.detail === "string" ? x.detail.slice(0, 240) : undefined, raw: true }));
  const retry = retryFrom(v.retry, f);
  if (!suggestions.length && !retry) return null;
  return { diagnosis: stage1.diagnosis, suggestions: [...stage1.suggestions, ...suggestions], ...(retry ? { retry } : {}) };
}

/**
 * The model's retry (5.6.1): its instruction, appended to the prompt with
 * what the validator said, at a temperature in [0, 1]. Only for a failure
 * a new attempt can fix (not a missing executor or a network error).
 */
function retryFrom(raw: unknown, f: Failure): RetryPatch | undefined {
  if (!raw || typeof raw !== "object" || !["validation", "parse", "empty", "tool"].includes(f.kind)) return undefined;
  const r = raw as { instruction?: unknown; temperature?: unknown };
  const instruction = typeof r.instruction === "string" ? r.instruction.trim().slice(0, 300) : "";
  if (!instruction) return undefined;
  const temperature = typeof r.temperature === "number" && Number.isFinite(r.temperature) ? Math.min(1, Math.max(0, r.temperature)) : 0;
  const reason = f.reason ? `Previous answer was rejected: ${f.reason}. ` : "";
  return { promptSuffix: `${reason}${instruction}`, temperature };
}

/** Install the model critic (called once at app start; tests leave it off). */
export function installModelCritic(): void {
  setModelCritic(async (f, v) => {
    try {
      return await modelReview(f, v);
    } catch {
      return null;
    }
  });
}
