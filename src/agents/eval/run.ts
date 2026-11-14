/** Run eval cases through the real agent runtime (MASTER_PLAN v2, E1). */

import "../defs";
import { getAgent } from "../registry";
import { runAgent } from "../runtime";
import type { AgentRun, ExecutorId } from "../types";
import type { EvalCase } from "./fixtures";
import { scoreCases, type CaseResult } from "./score";

/** The case's expected tool call is in the run (plan 5.3): made, executed by the runtime, and — unless optional — successful. */
export function toolCheck(c: EvalCase, steps: AgentRun["steps"]): CaseResult["checks"][number] {
  const tool = c.tool;
  const check = { type: "tool", name: tool?.name ?? null } as unknown as CaseResult["checks"][number]["check"];
  // An agent without tools (plan 4.11's formulator) is expected to make none.
  if (!tool) return { check, ok: true, detail: "no tool call expected" };
  const calls = steps.filter((s) => s.kind === "tool" && s.label === tool.name);
  const ok = calls.some((s) => s.ok || tool.mustSucceed === false);
  return { check, ok, detail: ok ? `called ${tool.name}` : calls.length ? `${tool.name} failed: ${calls.map((s) => s.detail).join("; ")}` : `${tool.name} was not called` };
}

export async function runEvalCase(c: EvalCase, opts: { executor?: ExecutorId; model?: string; signal?: AbortSignal } = {}): Promise<CaseResult> {
  const def = getAgent(c.agent);
  if (!def) return { id: c.id, agent: c.agent, status: "failed", executor: null, model: null, attempts: 0, ms: 0, checks: [], error: `unknown agent ${c.agent}` };
  try {
    // Answers must come from the model, not from an earlier run's cache.
    localStorage.setItem("lumen.ai.cache", "off");
  } catch {
    /* why: storage denied */
  }
  const started = Date.now();
  const run = await runAgent(def, c.input, {
    executor: opts.executor,
    signal: opts.signal,
    // A research question is not a document; the eval consents to its searches (what the user would do).
    ...(c.run?.inputMayLeave ? { inputMayLeave: true, consentNetwork: () => true } : { document: c.input.text }),
    selection: c.input.selection,
    grants: c.run?.grants,
    patch: opts.model ? { model: opts.model } : undefined,
  });
  const ms = Date.now() - started;
  const base = { id: c.id, agent: c.agent, executor: run.executor, model: run.model, attempts: run.attempts, ms };
  if (run.status !== "ok") return { ...base, status: "failed", checks: [], error: `${run.errorCode ?? "error"}: ${run.error ?? ""}`.trim() };
  return { ...base, status: "ok", checks: [...(await scoreCases(run.output, c.checks)), ...(c.tool ? [toolCheck(c, run.steps)] : [])] };
}
