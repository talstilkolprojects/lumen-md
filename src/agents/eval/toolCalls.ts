/**
 * Plan W4.31 — tool-call reliability: each probe (toolProbes.ts) runs as a
 * one-request agent through the real runtime (the executor's request with
 * the protocol's JSON schema, parsing, repair, the schema check, the one
 * retry and the request to the user). The offered tools only record the
 * call: nothing is executed, so a probe never reads, writes or sends
 * anything. Used by the live eval (toolCalls.eval.ts, a real Ollama) and by
 * the mock measurement (toolCallsMock.test.ts, the slip model below).
 */

import type { AgentDefinition, AgentTool, Executor, ExecutorRequest, ExecutorResponse, ToolCall } from "../types";
import { runAgent } from "../runtime";
import { getExecutor, registerExecutor } from "../executors";
import { extractJsonObject } from "../protocol";
import { coerceArgs } from "../tools/define";
import { validateSchema } from "../schema";
import type { ProbeTool, ToolProbe } from "./toolProbes";

export interface ProbeResult {
  id: string;
  lang: "he" | "en";
  expected: string;
  /** The tool the run called with schema-valid arguments, or null. */
  called: string | null;
  /** A schema-valid call to the expected tool (the plan's "valid call"). */
  valid: boolean;
  argsMatch: boolean;
  /** The first reply would have passed the parser before W4.31 (5.3.5: fences stripped, `tool`/`args` only, string numbers coerced). */
  before: boolean;
  /** Valid now but not before: fixed by the repair or the one retry. */
  recovered: boolean;
  retried: boolean;
  askedUser: boolean;
  ms: number;
  error?: string;
}

export interface ProbeSummary {
  total: number;
  /** valid / total — the W4.31 target is ≥ 0.95. */
  share: number;
  valid: number;
  argsMatch: number;
  before: number;
  recovered: number;
  retried: number;
  askedUser: number;
  byLang: Record<"he" | "en", { valid: number; total: number }>;
  p50Ms: number;
}

const SYSTEM = "You are the assistant of a Markdown notes app. Do what the user asks by calling exactly one of the tools. Use only values the user gave.";

/** Old behaviour (5.3.5): one strict JSON object with `tool` + `args`, an exact tool name, coerced numbers, and the schema. */
export function passedBefore(res: ExecutorResponse, tools: ProbeTool[]): boolean {
  let call: { name: string; args: unknown } | null = null;
  if (res.toolCalls.length) call = { name: res.toolCalls[0].name, args: res.toolCalls[0].args };
  else {
    const json = extractJsonObject(res.content);
    try {
      const o = json ? (JSON.parse(json) as Record<string, unknown>) : null;
      if (o && typeof o.tool === "string") call = { name: o.tool, args: o.args };
    } catch {
      call = null;
    }
  }
  const tool = call && tools.find((t) => t.name === call!.name);
  if (!tool || !call!.args || typeof call!.args !== "object" || Array.isArray(call!.args)) return false;
  return validateSchema(coerceArgs(call!.args as Record<string, unknown>, tool.parameters), tool.parameters).length === 0;
}

const norm = (v: unknown) => String(v).trim().toLowerCase().replace(/^["'״׳]+|["'״׳.]+$/g, "");

/** Whether the call carries the expected arguments (strings compared loosely; a search query may be a superset). */
export function argsMatch(expected: Record<string, unknown>, got: Record<string, unknown>, loose = new Set(["query"])): boolean {
  return Object.entries(expected).every(([k, want]) => {
    const have = got[k];
    if (Array.isArray(want)) return Array.isArray(have) && want.length === have.length && want.every((w) => have.some((h) => norm(h) === norm(w)));
    if (want && typeof want === "object") return !!have && typeof have === "object" && argsMatch(want as Record<string, unknown>, have as Record<string, unknown>, new Set());
    if (typeof want === "string") return have !== undefined && (norm(have) === norm(want) || (loose.has(k) && (norm(have).includes(norm(want)) || norm(want).includes(norm(have)))));
    return have === want || norm(have) === norm(want);
  });
}

/** Run one probe through the runtime on the registered executor `executorId`. */
export async function runProbe(p: ToolProbe, specs: ProbeTool[], opts: { executorId: "ollama" | "webllm"; model?: string }): Promise<ProbeResult> {
  const controller = new AbortController();
  let recorded: ToolCall | null = null;
  const offered = p.tools.map((name) => specs.find((t) => t.name === name)).filter((t): t is ProbeTool => !!t);
  const tools: AgentTool[] = offered.map((t) => ({
    ...t,
    scope: "read" as const,
    run: async (args: Record<string, unknown>) => {
      recorded = { id: "probe", name: t.name, args };
      controller.abort();
      throw new DOMException("probe recorded", "AbortError");
    },
  }));
  // The executor's first reply, to score the parser before W4.31 on the same answer.
  const base = getExecutor(opts.executorId);
  if (!base) throw new Error(`executor ${opts.executorId} is not registered`);
  let first: ExecutorResponse | null = null;
  const spy: Executor = {
    ...base,
    chat: async (req: ExecutorRequest) => {
      // The spy forwards the run's own cancel signal (T55).
      const res = await base.chat({ ...req, signal: req.signal });
      first ??= res;
      return res;
    },
  };
  registerExecutor(spy);
  const def: AgentDefinition = { id: "tool-probe", description: "W4.31 probe", system: SYSTEM, user: () => p.prompt, tools, maxRetries: 0, temperature: 0, maxSteps: 3 };
  try {
    // Answers must come from the model, not from an earlier run's cache.
    localStorage.setItem("lumen.ai.cache", "off");
  } catch {
    /* why: storage denied */
  }
  const t0 = Date.now();
  try {
    const run = await runAgent(def, {}, { executor: opts.executorId, signal: controller.signal, patch: opts.model ? { model: opts.model } : undefined });
    // Assigned in callbacks, so read through a widened type.
    const call = recorded as ToolCall | null;
    const firstRes = first as ExecutorResponse | null;
    const valid = !!call && call.name === p.expect.tool;
    const before = !!firstRes && passedBefore(firstRes, offered);
    return {
      id: p.id,
      lang: p.lang,
      expected: p.expect.tool,
      called: call ? call.name : null,
      valid,
      argsMatch: valid && !!call && argsMatch(p.expect.args, call.args),
      before,
      recovered: valid && !before,
      retried: run.steps.some((s) => s.kind === "tool" && !s.ok),
      askedUser: run.errorCode === "tool-args",
      ms: Date.now() - t0,
      ...(call ? {} : { error: `${run.errorCode ?? run.status}: ${run.error ?? ""}`.slice(0, 300) }),
    };
  } finally {
    registerExecutor(base);
  }
}

export function summarize(rows: ProbeResult[]): ProbeSummary {
  const n = rows.length || 1;
  const count = (f: (r: ProbeResult) => boolean) => rows.filter(f).length;
  const lang = (l: "he" | "en") => ({ valid: count((r) => r.lang === l && r.valid), total: count((r) => r.lang === l) });
  const ms = rows.map((r) => r.ms).sort((a, b) => a - b);
  return {
    total: rows.length,
    share: count((r) => r.valid) / n,
    valid: count((r) => r.valid),
    argsMatch: count((r) => r.argsMatch),
    before: count((r) => r.before),
    recovered: count((r) => r.recovered),
    retried: count((r) => r.retried),
    askedUser: count((r) => r.askedUser),
    byLang: { he: lang("he"), en: lang("en") },
    p50Ms: ms.length ? ms[Math.floor((ms.length - 1) / 2)] : 0,
  };
}

// ── the slip model: a mock of what small local models get wrong ───────────

/**
 * Synthetic, not measured: a deterministic mix of the tool-call slips that
 * small models are reported to make when output is not fully constrained,
 * so the mock run exercises every repair and the retry. The shares are
 * this file's assumption; only the real run (models:day) is a measurement.
 */
export const SLIPS: Array<[name: string, share: number]> = [
  ["clean", 0.5],
  ["prose-and-fence", 0.08],
  ["name-arguments-string", 0.07],
  ["function-envelope", 0.04],
  ["camel-case-name", 0.05],
  ["string-scalars", 0.05],
  ["trailing-comma-python", 0.04],
  ["extra-property", 0.04],
  ["wrapped-args", 0.03],
  ["key-case", 0.03],
  ["action-input", 0.03],
  ["missing-required", 0.02],
  ["unknown-tool", 0.01],
  ["wrong-tool", 0.01],
];

function hash(s: string): number {
  let h = 2166136261;
  for (let i = 0; i < s.length; i++) h = Math.imul(h ^ s.charCodeAt(i), 16777619);
  return (h >>> 0) / 4294967296;
}

export function slipFor(id: string): string {
  let x = hash(id);
  for (const [name, share] of SLIPS) {
    if (x < share) return name;
    x -= share;
  }
  return "clean";
}

const camel = (s: string) => s.replace(/(^|_)([a-z])/g, (_m, _u, c: string) => c.toUpperCase());
const stringify = (args: Record<string, unknown>) => Object.fromEntries(Object.entries(args).map(([k, v]) => [k, typeof v === "number" || typeof v === "boolean" ? String(v) : v]));

/** What the mock model answers to probe `p` on its `attempt`-th call (1 = first; a retry answers clean). */
export function mockReply(p: ToolProbe, attempt: number, specs: ProbeTool[]): string {
  const tool = p.expect.tool;
  const args = p.expect.args;
  const slip = attempt === 1 ? slipFor(p.id) : "clean";
  const call = (o: unknown) => JSON.stringify(o);
  switch (slip) {
    case "prose-and-fence":
      return `Sure — I'll do that.\n\`\`\`json\n${call({ tool, args })}\n\`\`\``;
    case "name-arguments-string":
      return call({ name: tool, arguments: JSON.stringify(args) });
    case "function-envelope":
      return call({ function: { name: tool, arguments: args } });
    case "camel-case-name":
      return call({ tool: camel(tool), args });
    case "string-scalars":
      return call({ tool, args: stringify(args) });
    case "trailing-comma-python":
      return call({ tool, args }).replace(/\}$/, ",}").replace(/true/g, "True");
    case "extra-property":
      return call({ tool, args: { ...args, reason: "the user asked" } });
    case "wrapped-args":
      return call({ tool, args: { arguments: args } });
    case "key-case":
      return call({ tool, args: Object.fromEntries(Object.entries(args).map(([k, v]) => [k.charAt(0).toUpperCase() + k.slice(1), v])) });
    case "action-input":
      return call({ action: tool, action_input: args });
    case "missing-required": {
      const req = ((specs.find((t) => t.name === tool)?.parameters as { required?: string[] }).required ?? [])[0];
      const rest = { ...args };
      if (req) delete rest[req];
      return call({ tool, args: rest });
    }
    case "unknown-tool":
      return call({ tool: `${tool}_v2`, args });
    case "wrong-tool": {
      const other = p.tools.find((t) => t !== tool && !(((specs.find((s) => s.name === t)?.parameters as { required?: string[] }).required ?? []).length));
      return other ? call({ tool: other, args: {} }) : call({ tool, args });
    }
    default:
      return call({ tool, args });
  }
}

/** A mock Ollama executor answering every probe with `mockReply` (schema constraint advertised, like Ollama ≥ 0.5). */
export function slipExecutor(probes: ToolProbe[], specs: ProbeTool[]): Executor {
  const probeOf = (req: ExecutorRequest) => {
    const user = req.messages.find((m) => m.role === "user")?.content ?? "";
    return probes.find((p) => user.startsWith(p.prompt));
  };
  return {
    id: "ollama",
    label: "slip mock",
    available: async () => ({ available: true }),
    supportsTools: () => false,
    supportsSchema: () => true,
    modelFor: () => "slip-mock",
    async chat(req) {
      const p = probeOf(req);
      if (!p) return { content: '{"final": ""}', toolCalls: [], model: "slip-mock" };
      const toolTurns = req.messages.filter((m) => m.role === "tool").length;
      return { content: mockReply(p, toolTurns + 1, specs), toolCalls: [], model: "slip-mock", usage: { inputTokens: 1, outputTokens: 1, estimated: true } };
    },
  };
}
