/**
 * Structural checks for the real-model CI run (plan 7.2): with a tiny model
 * (qwen3:0.6b), temperature 0, a fixed seed and at most 64 tokens a turn,
 * the run judges the *shape* of what the model returns, not its wording:
 *
 *   tool turn   the tool is one the agent offers, and its arguments pass
 *               the tool's JSON Schema (after the runtime's coercion);
 *   final turn  starts in the agent's format: a JSON object for an agent
 *               with an output schema, non-empty text otherwise.
 *
 * A final answer cut at 64 tokens may not parse; its start still has to be
 * right ("{" for JSON). Wording and correctness are 7.3's eval on a larger
 * model.
 */

import type { AgentDefinition, AgentInput, ExecutorResponse } from "../types";
import { parseProtocolTurn } from "../protocol";
import { validateSchema, formatSchemaErrors } from "../schema";
import { coerceArgs } from "../tools/define";

export interface TurnVerdict {
  ok: boolean;
  kind: "tool" | "final" | "text";
  detail: string;
}

/** Judge one model turn against the agent's tools and format. */
export function judgeTurn(def: AgentDefinition<AgentInput, unknown>, res: Pick<ExecutorResponse, "content" | "toolCalls">): TurnVerdict {
  const tools = def.tools ?? [];
  const checkCall = (name: string, args: unknown): TurnVerdict => {
    const tool = tools.find((t) => t.name === name);
    if (!tool) return { ok: false, kind: "tool", detail: `unknown tool "${name}" (offered: ${tools.map((t) => t.name).join(", ") || "none"})` };
    const coerced = coerceArgs(args && typeof args === "object" ? (args as Record<string, unknown>) : {}, tool.parameters);
    const errors = validateSchema(coerced, tool.parameters);
    return errors.length ? { ok: false, kind: "tool", detail: `${name}: ${formatSchemaErrors(errors)}` } : { ok: true, kind: "tool", detail: `${name} with valid arguments` };
  };
  if (res.toolCalls.length) {
    for (const c of res.toolCalls) {
      const v = checkCall(c.name, c.args);
      if (!v.ok) return v;
    }
    return { ok: true, kind: "tool", detail: res.toolCalls.map((c) => c.name).join(", ") };
  }
  const raw = res.content.replace(/<think>[\s\S]*?(<\/think>|$)/g, "").trim();
  if (tools.length) {
    const turn = parseProtocolTurn(raw);
    if (turn.kind === "tool") return checkCall(turn.call.name, turn.call.args);
    if (turn.kind === "final") return finalShape(def, turn.content);
    // A cut-off JSON-ReAct turn: judge the start.
    if (/^\{\s*"(tool|final)"/.test(raw)) return { ok: true, kind: raw.includes('"tool"') ? "tool" : "final", detail: "protocol turn (cut at the token limit)" };
  }
  return finalShape(def, raw);
}

function finalShape(def: AgentDefinition<AgentInput, unknown>, text: string): TurnVerdict {
  const t = text.trim().replace(/^```(?:json)?\s*/i, "");
  if (!t) return { ok: false, kind: "final", detail: "empty answer" };
  if (def.outputSchema) return t.startsWith("{") ? { ok: true, kind: "final", detail: "JSON object" } : { ok: false, kind: "final", detail: `expected a JSON object, got: ${t.slice(0, 60)}` };
  return { ok: true, kind: "final", detail: "text" };
}

/** A case passes when the model answered at least once and every turn had the right shape. */
export function judgeRun(def: AgentDefinition<AgentInput, unknown>, turns: ReadonlyArray<Pick<ExecutorResponse, "content" | "toolCalls">>): { ok: boolean; detail: string; verdicts: TurnVerdict[] } {
  const verdicts = turns.map((t) => judgeTurn(def, t));
  if (!verdicts.length) return { ok: false, detail: "the model was never asked", verdicts };
  const bad = verdicts.find((v) => !v.ok);
  return bad ? { ok: false, detail: bad.detail, verdicts } : { ok: true, detail: verdicts.map((v) => v.kind).join(" → "), verdicts };
}
