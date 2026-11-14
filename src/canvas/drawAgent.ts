/**
 * "Draw me" on the canvas (plan W2.18): a local model writes Mermaid, which
 * is checked before anything is converted. The agent runs only on this
 * device's executors (Ollama on localhost, then WebLLM in the browser), never
 * the cloud chat, whatever the AI policy says — the canvas promises 0
 * requests off the device. The answer must be one of the five diagram types
 * the canvas makes editable and must pass the real Mermaid parser; a failed
 * check goes back to the model with the error for its retry.
 */

import type { AgentDefinition, AgentInput, ExecutorId, Validator } from "../agents/types";
import { mermaidValidator } from "../agents/tools/validate";
import { clip } from "../agents/defs/shared";
import { extractMermaid, precheck } from "./mermaidPrep";

export interface DrawInput extends AgentInput {
  text: string;
}

export const LOCAL_EXECUTORS: ExecutorId[] = ["ollama", "webllm"];

export const DRAW_SYSTEM =
  "You draw diagrams as Mermaid for an editable canvas. Answer with ONE Mermaid diagram and nothing else: " +
  "no code fences, no explanation. Use only these types: flowchart (flowchart TD / LR), sequenceDiagram, classDiagram, " +
  "stateDiagram-v2, erDiagram. Write every label in the language of the request (Hebrew stays Hebrew). " +
  'Node ids are ASCII letters and digits; put the label in quotes: A["בקשה חדשה"] --> B{"האם מאושר?"}. ' +
  'Edge labels: A -->|"כן"| B. Sequence: participant U as "משתמש", then U->>S: text. ' +
  'State: state "טיוטה" as Draft. ER: entities with ASCII names and a quoted alias in their block, ' +
  'e.g. CUSTOMER["לקוח"] { string name }, then CUSTOMER ||--o{ ORDER : "מבצע". Keep it under 25 nodes.';

/** The answer is a diagram the canvas can make editable. */
export const editableValidator: Validator<string> = {
  name: "editable-diagram",
  check: (output) => {
    const p = precheck(output);
    if (p.ok) return { ok: true };
    return {
      ok: false,
      reason: p.reason === "not-editable" ? `"${p.kind}" diagrams can't be edited on the canvas` : "no Mermaid diagram in the answer",
      hint: "Return one flowchart, sequenceDiagram, classDiagram, stateDiagram-v2 or erDiagram, and only the diagram.",
    };
  },
};

export const drawAgent: AgentDefinition<DrawInput, string> = {
  id: "canvas-draw",
  commandId: "canvas.draw",
  description: "Draw a diagram on the canvas from a description (local model only)",
  system: DRAW_SYSTEM,
  user: (input) => clip(input.text, 4000),
  parse: (text) => extractMermaid(text),
  validators: [editableValidator, mermaidValidator as Validator<string>],
  executorPreference: LOCAL_EXECUTORS,
  tier: "small",
  temperature: 0.2,
  maxTokens: 1500,
  maxRetries: 2,
  cache: true,
  language: "any",
};

/** Run it: the Mermaid, or an error the dialog shows (no local model, or no valid diagram after the retries). */
export async function drawDiagram(text: string, signal?: AbortSignal): Promise<{ ok: true; code: string; executor: string | null } | { ok: false; error: string; code: "no-local-model" | "invalid" }> {
  const { runAgent } = await import("../agents/runtime");
  const run = await runAgent(drawAgent, { text }, { signal, document: text, ownPrompt: true });
  if (run.status === "ok" && typeof run.output === "string") return { ok: true, code: run.output, executor: run.executor };
  return { ok: false, code: run.errorCode === "no-executor" ? "no-local-model" : "invalid", error: run.error ?? "failed" };
}
