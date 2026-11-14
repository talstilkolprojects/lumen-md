/**
 * JSON-ReAct — tool calling for executors without native function calling.
 *
 * The tools are described in the system prompt; the model answers with
 * exactly one JSON object per turn: `{"tool": name, "args": {…}}` to call a
 * tool, or `{"final": answer}` when done. Every executor can run this
 * protocol, so an agent works the same on a model without `tools` support
 * (web-llm models other than Llama 3.1 / Hermes, older Ollama builds).
 */

import type { AgentTool, JsonSchema, ToolCall } from "./types";
import { lenientJson, unwrapTurn } from "./toolRepair";

export interface ToolSpec {
  name: string;
  description: string;
  parameters: JsonSchema;
}

export function toolSpecs(tools: AgentTool[]): ToolSpec[] {
  return tools.map((t) => ({ name: t.name, description: t.description, parameters: t.parameters }));
}

/**
 * The JSON Schema of one JSON-ReAct turn, for executors that constrain
 * output (Ollama `format`, web-llm's XGrammar `response_format`): a call to
 * one of the agent's tools with that tool's arguments, or the final answer
 * (matching the agent's output schema when it has one). A small model then
 * cannot answer with prose, a tool it does not have, or malformed args.
 */
export function protocolSchema(tools: AgentTool[], output?: JsonSchema): JsonSchema {
  const calls = tools.map((t) => ({
    type: "object",
    properties: { tool: { type: "string", enum: [t.name] }, args: t.parameters },
    required: ["tool", "args"],
    additionalProperties: false,
  }));
  const final = { type: "object", properties: { final: output ?? { type: "string" } }, required: ["final"], additionalProperties: false };
  return { anyOf: [...calls, final] } as JsonSchema;
}

/** System-prompt addendum that teaches the protocol. */
export function toolProtocolPrompt(tools: AgentTool[], schema?: JsonSchema): string {
  const lines = [
    "You can use tools. Available tools (JSON):",
    JSON.stringify(toolSpecs(tools)),
    "",
    "Rules:",
    '- To call a tool, reply with ONLY this JSON object and nothing else: {"tool": "<name>", "args": {<arguments>}}',
    "- You will receive the tool's result in the next message. Call as many tools as needed, one per reply.",
    schema
      ? '- When you have the final answer, reply with ONLY: {"final": <answer>} where <answer> is a JSON value matching this schema: ' +
        JSON.stringify(schema)
      : '- When you have the final answer, reply with ONLY: {"final": "<answer text>"}',
    "- Never explain the JSON. Never wrap it in code fences.",
  ];
  return lines.join("\n");
}

export type ProtocolTurn =
  | { kind: "tool"; call: ToolCall }
  | { kind: "final"; content: string }
  | { kind: "text"; content: string };

let callSeq = 0;

/** Strip ```json fences and surrounding prose; returns the first balanced JSON object, or null. */
export function extractJsonObject(text: string): string | null {
  const cleaned = text.replace(/^\s*```(?:json)?\s*/i, "").replace(/\s*```\s*$/, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < cleaned.length; i++) {
    const c = cleaned[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") depth++;
    else if (c === "}") {
      depth--;
      if (depth === 0) return cleaned.slice(start, i + 1);
    }
  }
  return null;
}

/**
 * Interpret one assistant reply under the protocol. Plain text (a model
 * that ignored the format) is returned as `text`, so a text agent still
 * gets its answer and a JSON agent fails validation with a clear reason.
 * With the agent's `tools`, the slips small models make are accepted too
 * (plan W4.31): JSON with trailing commas or Python literals, and a call in
 * another common shape (`{"name", "arguments"}`, `{"function": …}`,
 * `{"action", "action_input"}`) that names one of those tools.
 */
export function parseProtocolTurn(text: string, tools: AgentTool[] = []): ProtocolTurn {
  const json = extractJsonObject(text);
  if (json) {
    const obj = lenientJson(json);
    const turn = unwrapTurn(obj, tools);
    if (turn && "tool" in turn) return { kind: "tool", call: { id: `call_${++callSeq}`, name: turn.tool, args: turn.args } };
    if (turn) return { kind: "final", content: typeof turn.final === "string" ? turn.final : JSON.stringify(turn.final) };
  }
  return { kind: "text", content: text.trim() };
}

/** The tool-result turn the model reads next. */
export function toolResultMessage(call: ToolCall, result: unknown, error?: string): string {
  const body = error !== undefined ? { tool: call.name, error } : { tool: call.name, result };
  return JSON.stringify(body);
}
