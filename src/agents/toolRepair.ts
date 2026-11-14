/**
 * Tool-call repair for small local models (plan W4.31).
 *
 * Even under a JSON-schema constraint (Ollama `format`), a 7–12B model
 * makes predictable slips: the call in another shape (`{"name", "arguments"}`,
 * `{"function": …}`, `{"action", "action_input"}`), the arguments as a JSON
 * string, a tool name in another case, numbers and booleans as strings, a
 * single value where the schema wants a list, an extra property, or JSON
 * with trailing commas, smart quotes or Python literals. This module fixes
 * exactly those — deterministic, without guessing a value the model did
 * not give — and says what it fixed. Anything else is left for the
 * schema check, whose errors go back to the model once (`retryMessage`);
 * a second invalid call ends the run with a request to the user.
 *
 * Repair never widens what a call may do: the repaired call still goes
 * through the runtime's grants, schema check, network gate and staging.
 */

import type { AgentTool, JsonSchema, ToolCall } from "./types";
import { formatSchemaErrors, validateSchema, type SchemaError } from "./schema";

export interface RepairedCall {
  call: ToolCall;
  /** What was changed, for the run's trace (empty = the call was already clean). */
  repairs: string[];
}

/** Keys a model wraps arguments in when it invents its own envelope. */
const ARG_WRAPPERS = ["args", "arguments", "parameters", "params", "input", "action_input", "tool_input"];

/**
 * JSON.parse that also accepts what models emit: smart quotes, trailing
 * commas, Python's True / False / None, and single-quoted strings when the
 * text has no double quotes at all. Returns `undefined` when it is not JSON.
 */
export function lenientJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    /* why: try the repairs below */
  }
  let t = text.replace(/[“”„‟]/g, '"').replace(/[‘’]/g, "'");
  if (!t.includes('"') && t.includes("'")) t = t.replace(/'/g, '"');
  t = outsideStrings(t, (chunk) => chunk.replace(/,\s*([}\]])/g, "$1").replace(/\bTrue\b/g, "true").replace(/\bFalse\b/g, "false").replace(/\bNone\b/g, "null"));
  try {
    return JSON.parse(t);
  } catch {
    return undefined;
  }
}

/** Apply `fix` to the parts of a JSON text that are not inside string literals. */
function outsideStrings(text: string, fix: (chunk: string) => string): string {
  let out = "";
  let chunk = "";
  let inStr = false;
  let esc = false;
  for (const c of text) {
    if (inStr) {
      out += c;
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') {
      out += fix(chunk) + c;
      chunk = "";
      inStr = true;
    } else chunk += c;
  }
  return out + fix(chunk);
}

const isObject = (v: unknown): v is Record<string, unknown> => !!v && typeof v === "object" && !Array.isArray(v);
const squash = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, "");

/**
 * One protocol turn in whatever shape the model used, as `{tool, args}` or
 * `{final}`; null when it is neither. Arguments given as a JSON string are
 * parsed. Only `tool` is the protocol's own key: a call in another shape
 * (`name`, `function`, `action`…) counts only when it names one of the
 * agent's tools, so a final answer that happens to have a `name` field is
 * not mistaken for a call.
 */
export function unwrapTurn(obj: unknown, tools: AgentTool[]): { tool: string; args: Record<string, unknown> } | { final: unknown } | null {
  if (!isObject(obj)) return null;
  if (Array.isArray(obj.tool_calls) && obj.tool_calls.length) return unwrapTurn(obj.tool_calls[0], tools);
  if (isObject(obj.tool_call)) return unwrapTurn(obj.tool_call, tools);
  if (isObject(obj.function) && typeof obj.function.name === "string") return unwrapTurn({ name: obj.function.name, arguments: obj.function.arguments }, tools);
  const argsOf = () => {
    const raw = ARG_WRAPPERS.map((k) => obj[k]).find((v) => v !== undefined);
    const parsed = typeof raw === "string" ? lenientJson(raw) : raw;
    return isObject(parsed) ? parsed : {};
  };
  if (typeof obj.tool === "string" && obj.tool.trim()) return { tool: obj.tool.trim(), args: argsOf() };
  if ("final" in obj) return { final: obj.final };
  // LangChain-style ReAct: {"action": "Final Answer", "action_input": …}.
  if (typeof obj.action === "string" && /^final(\s*answer)?$/i.test(obj.action.trim())) return { final: obj.action_input ?? "" };
  const name = [obj.name, obj.tool_name, obj.action, obj.function].find((v): v is string => typeof v === "string" && v.trim() !== "");
  if (name !== undefined && resolveToolName(name.trim(), tools)) return { tool: name.trim(), args: argsOf() };
  return null;
}

/** The agent's tool a model meant: exact, then case- and separator-insensitive, then without a `functions.` prefix. */
export function resolveToolName(name: string, tools: AgentTool[]): string | null {
  if (tools.some((t) => t.name === name)) return name;
  const bare = name.replace(/^(functions?|tools?)[.:/]/i, "");
  const want = squash(bare);
  const hits = tools.filter((t) => squash(t.name) === want);
  return hits.length === 1 ? hits[0].name : null;
}

/** Fix the argument slips listed above against the tool's schema. */
export function repairArgs(args: Record<string, unknown>, schema: JsonSchema): { args: Record<string, unknown>; repairs: string[] } {
  const s = schema as { properties?: Record<string, Record<string, unknown>>; additionalProperties?: unknown; required?: string[] };
  const props = s.properties ?? {};
  const repairs: string[] = [];
  let out: Record<string, unknown> = { ...args };
  // A wrapper the schema does not know, holding the real arguments.
  const keys = Object.keys(out);
  if (keys.length === 1 && ARG_WRAPPERS.includes(keys[0]) && !(keys[0] in props)) {
    const inner = typeof out[keys[0]] === "string" ? lenientJson(out[keys[0]] as string) : out[keys[0]];
    if (isObject(inner)) {
      out = { ...inner };
      repairs.push(`unwrapped "${keys[0]}"`);
    }
  }
  for (const key of Object.keys(out)) {
    if (key in props) continue;
    // A key in another case or separator style (`maxResults` for `max_results`).
    const match = Object.keys(props).filter((p) => squash(p) === squash(key));
    if (match.length === 1 && !(match[0] in out)) {
      out[match[0]] = out[key];
      delete out[key];
      repairs.push(`renamed ${key} → ${match[0]}`);
    }
  }
  for (const [key, value] of Object.entries(out)) {
    const p = props[key];
    if (!p) continue;
    const type = typeof p.type === "string" ? p.type : Array.isArray(p.type) ? (p.type as string[]).find((x) => x !== "null") : undefined;
    const fixed = coerce(value, type, p);
    if (fixed !== value) {
      out[key] = fixed;
      repairs.push(`${key}: ${typeof value} → ${type}`);
    }
  }
  if (s.additionalProperties === false) {
    for (const key of Object.keys(out)) {
      if (!(key in props)) {
        delete out[key];
        repairs.push(`dropped ${key}`);
      }
    }
  }
  for (const key of s.required ?? []) {
    if (!(key in out) && props[key] && "default" in props[key]) {
      out[key] = props[key].default;
      repairs.push(`${key}: schema default`);
    }
  }
  return { args: repairs.length ? out : args, repairs };
}

function coerce(value: unknown, type: string | undefined, p: Record<string, unknown>): unknown {
  if (type === "number" || type === "integer") {
    if (typeof value === "string" && /^\s*-?\d+(\.\d+)?\s*$/.test(value)) return Number(value);
  }
  if (type === "boolean" && typeof value === "string" && /^(true|false)$/i.test(value.trim())) return value.trim().toLowerCase() === "true";
  if (type === "string" && (typeof value === "number" || typeof value === "boolean")) return String(value);
  if (type === "array") {
    const itemType = (p.items as { type?: string } | undefined)?.type;
    if (typeof value === "string") {
      const parsed = value.trim().startsWith("[") ? lenientJson(value) : undefined;
      if (Array.isArray(parsed)) return parsed;
      if (itemType === "string" || itemType === undefined) return value.includes(",") ? value.split(",").map((x) => x.trim()).filter(Boolean) : [value];
    }
    if (value !== null && value !== undefined && !Array.isArray(value) && (typeof value === itemType || (itemType === "object" && isObject(value)))) return [value];
  }
  if (type === "object" && typeof value === "string") {
    const parsed = lenientJson(value);
    if (isObject(parsed)) return parsed;
  }
  return value;
}

/** Repair one call against the agent's tools: its name, then its arguments. */
export function repairCall(call: ToolCall, tools: AgentTool[]): RepairedCall {
  const repairs: string[] = [];
  let args: Record<string, unknown> = isObject(call.args) ? call.args : {};
  if (typeof call.args === "string") {
    const parsed = lenientJson(call.args);
    if (isObject(parsed)) {
      args = parsed;
      repairs.push("parsed string arguments");
    }
  }
  const name = resolveToolName(call.name, tools);
  if (name && name !== call.name) repairs.push(`tool ${call.name} → ${name}`);
  const tool = name ? tools.find((t) => t.name === name) : undefined;
  if (tool) {
    const r = repairArgs(args, tool.parameters);
    args = r.args;
    repairs.push(...r.repairs);
  }
  return { call: repairs.length ? { ...call, name: name ?? call.name, args } : call, repairs };
}

/** Whether a repaired call is valid: a tool the agent has, with arguments that match its schema. */
export function callErrors(call: ToolCall, tools: AgentTool[]): SchemaError[] | "unknown-tool" {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return "unknown-tool";
  return validateSchema(call.args, tool.parameters);
}

/**
 * The tool result the model reads after its first invalid call: what was
 * wrong, the tool's exact schema, and the instruction to send one corrected
 * call — the one retry before the run asks the user.
 */
export function retryMessage(call: ToolCall, tools: AgentTool[], error: string): string {
  const tool = tools.find((t) => t.name === call.name);
  const parts = [`Invalid tool call: ${error}.`];
  if (tool) parts.push(`The arguments of "${tool.name}" must match this JSON Schema exactly: ${JSON.stringify(tool.parameters)}.`);
  else parts.push(`Use one of these tools: ${tools.map((t) => t.name).join(", ")}.`);
  parts.push('Reply with one corrected call, {"tool": …, "args": {…}}, or {"final": …} if no tool is needed. Do not invent values the user did not give.');
  return parts.join(" ");
}

/** The error text for a schema failure (runtime's `bad-args:` prefix). */
export function badArgs(errors: SchemaError[]): string {
  return `bad-args: ${formatSchemaErrors(errors)}`;
}
