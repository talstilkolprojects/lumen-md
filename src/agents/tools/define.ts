import type { AgentTool, ChangeProposal, JsonSchema, StagedReceipt, ToolContext, ToolScope } from "../types";

export class ToolError extends Error {
  constructor(
    public code: "denied" | "not-found" | "bad-args" | "failed",
    message: string,
  ) {
    super(message);
    this.name = "ToolError";
  }
}

/** The error every tool throws when the run's signal fired. */
export function abortError(): DOMException {
  return new DOMException("aborted", "AbortError");
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw abortError();
}

/**
 * Typed helper so each tool file stays declarative. The returned tool
 * honours the run's AbortSignal at its boundaries (before it starts and
 * before its result is handed back), so even a tool whose work is a
 * single synchronous step stops when the user cancels; tools with several
 * awaits check `ctx.signal` between them as well.
 */
export function defineTool<A extends Record<string, unknown>, R>(spec: {
  name: string;
  description: string;
  parameters: JsonSchema;
  scope?: ToolScope;
  run: (args: A, ctx: ToolContext) => Promise<R>;
  untrusted?: (args: A, result: R, ctx: ToolContext) => string[] | Promise<string[]>;
}): AgentTool<A, R> {
  const inner = spec.run;
  return {
    scope: "read",
    ...spec,
    run: async (args, ctx) => {
      throwIfAborted(ctx.signal);
      const result = await inner(args, ctx);
      throwIfAborted(ctx.signal);
      return result;
    },
  };
}

/**
 * Write tools compute a change and hand it to the runtime's `stage`; they
 * never write. Called outside a run (no `stage`), they refuse.
 */
export function stageChange(ctx: ToolContext, tool: string, proposal: ChangeProposal): StagedReceipt {
  if (!ctx.stage) throw new ToolError("denied", `"${tool}" only proposes changes through the agent runtime, which stages them for approval`);
  throwIfAborted(ctx.signal);
  return ctx.stage(proposal);
}

/** Network tools use the fetch the runtime opened for the call (policy, consent, ledger). */
export function networkFetch(ctx: ToolContext, tool: string): typeof fetch {
  if (!ctx.fetch) throw new ToolError("denied", `"${tool}" reaches the network only through the agent runtime (AI policy, consent and the privacy ledger)`);
  return ctx.fetch;
}

/** The research service and settings the runtime approved this call with (set together with `fetch`). */
export function networkBinding(ctx: ToolContext, tool: string): NonNullable<ToolContext["network"]> {
  if (!ctx.network) throw new ToolError("denied", `"${tool}" reaches the network only through the agent runtime (AI policy, consent and the privacy ledger)`);
  return ctx.network;
}

export function requireString(args: Record<string, unknown>, key: string): string {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new ToolError("bad-args", `"${key}" must be a non-empty string`);
  return v;
}

export function optionalNumber(args: Record<string, unknown>, key: string, fallback: number): number {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** A workspace path must stay inside the workspace. */
export function safeWorkspacePath(path: string): string {
  const p = path.replace(/\\/g, "/").replace(/^\/+/, "");
  if (!p || p.split("/").some((seg) => seg === "..")) throw new ToolError("bad-args", `Invalid workspace path: ${path}`);
  return p;
}

/**
 * Small models often send `"10"` for a number or `"true"` for a boolean.
 * Top-level arguments whose schema says number / integer / boolean are
 * coerced from such strings before the schema check; nothing else changes.
 */
export function coerceArgs(args: Record<string, unknown>, schema: JsonSchema): Record<string, unknown> {
  const props = ((schema as { properties?: Record<string, JsonSchema> }).properties ?? {}) as Record<string, { type?: unknown }>;
  let out: Record<string, unknown> | null = null;
  for (const [key, value] of Object.entries(args)) {
    const type = props[key]?.type;
    if (typeof value !== "string") continue;
    const s = value.trim();
    let next: unknown = value;
    if ((type === "number" || type === "integer") && /^-?\d+(\.\d+)?$/.test(s)) next = Number(s);
    else if (type === "boolean" && (s === "true" || s === "false")) next = s === "true";
    if (next !== value) (out ??= { ...args })[key] = next;
  }
  return out ?? args;
}
