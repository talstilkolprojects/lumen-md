/**
 * A scripted model for an eval case (plan 5.3), for the offline tests: it
 * makes the case's expected tool call on its first turn and gives the
 * case's reference answer once it has the result — in whichever form the
 * runtime asked for: a native tool call, or JSON-ReAct (with or without the
 * protocol's schema). A streaming agent gets the answer straight away (its
 * tool is a context call). The fake Ollama server (scripts/fake-ollama.mjs)
 * answers the same way over HTTP.
 */
import type { ExecutorRequest, ExecutorResponse } from "../types";
import type { EvalCase } from "./fixtures";

export function scriptedAnswer(c: EvalCase, req: ExecutorRequest): ExecutorResponse {
  const model = req.model ?? "fake";
  const tool = c.tool;
  // An agent without tools (no expected call) answers straight away.
  const called = !tool || req.messages.some((m) => m.role === "assistant" && m.toolCalls?.some((t) => t.name === tool.name && !t.id.startsWith("ctx_")));
  const protocol = !!(req.schema as { anyOf?: unknown[] } | undefined)?.anyOf || req.messages[0]?.content.includes('{"tool": "<name>"');
  const usage = { inputTokens: 10, outputTokens: 5, estimated: true };
  if (!called && req.tools?.length) return { content: "", toolCalls: [{ id: "c1", name: tool.name, args: tool.args ?? {} }], model, usage };
  if (!called && protocol) return { content: JSON.stringify({ tool: tool.name, args: tool.args ?? {} }), toolCalls: [], model, usage };
  if (protocol) {
    let final: unknown = c.example;
    try {
      final = JSON.parse(c.example);
    } catch {
      /* why: a text answer */
    }
    return { content: JSON.stringify({ final }), toolCalls: [], model, usage };
  }
  return { content: c.example, toolCalls: [], model, usage };
}
