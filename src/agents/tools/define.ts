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

/** Files that steer other agents (Claude Code, Codex, Copilot, Cursor …): an agent of Lumen never writes them. */
export const AGENT_CONTROL_FILES = /^(claude|claude\.local|agents|agents\.override|gemini|copilot-instructions)\.md$|^\.(cursorrules|windsurfrules|mcp\.json)$/i;

/** Latin look-alikes (Cyrillic, Greek) folded to Latin before matching a name. */
const CONFUSABLES: Record<string, string> = {
  "\u0410": "A", "\u0412": "B", "\u0421": "C", "\u0415": "E", "\u041D": "H", "\u0406": "I", "\u0408": "J", "\u041A": "K", "\u041C": "M", "\u041E": "O", "\u0420": "P", "\u0405": "S", "\u0422": "T", "\u0425": "X", "\u0423": "Y",
  "\u0430": "a", "\u0441": "c", "\u0435": "e", "\u043E": "o", "\u0440": "p", "\u0455": "s", "\u0445": "x", "\u0443": "y", "\u0456": "i", "\u0458": "j",
  "\u0391": "A", "\u0392": "B", "\u0395": "E", "\u0397": "H", "\u0399": "I", "\u039A": "K", "\u039C": "M", "\u039D": "N", "\u039F": "O", "\u03A1": "P", "\u03A4": "T", "\u03A7": "X", "\u03BF": "o",
};

/** A path segment as a file system (and a person) would read it: NFKC, no invisible characters, look-alikes folded, no trailing dots or spaces. */
export function canonicalSegment(seg: string): string {
  return seg
    .normalize("NFKC")
    .replace(/[\p{Cf}]/gu, "")
    .replace(/[\u0370-\u03FF\u0400-\u04FF]/g, (c) => CONFUSABLES[c] ?? c)
    .replace(/[. ]+$/, "");
}

/**
 * A path an agent may WRITE (reviews 21 D3, 24): `safeWorkspacePath`, and not
 * an absolute or UNC path, no `:` (Windows streams, drives) or `~` (8.3 short
 * names), nothing under a dot folder (`.lumen/` holds skills and MCP grants,
 * `.claude/` and `.git/` steer other tools), no agent control file — each
 * segment compared in its canonical form (NFKC, invisible characters
 * dropped, look-alike letters folded, trailing dots and spaces removed).
 * Every write tool calls it; the MCP server applies the same rule to outside clients.
 */
export function safeWriteTarget(path: string): string {
  if (/^([a-zA-Z]:)?[\\/]/.test(path)) throw new ToolError("denied", `Agents write only inside the vault, not to ${path}`);
  const p = safeWorkspacePath(path);
  const parts = p.split("/");
  for (const raw of parts) {
    if (/[:~\\]/.test(raw)) throw new ToolError("denied", `Agents do not write paths with ":", "~" or "\\" (${p})`);
    const seg = canonicalSegment(raw);
    if (!seg || seg.startsWith(".")) throw new ToolError("denied", `Agents do not write under dot folders (${p}): they hold Lumen's skills and permissions and other tools' settings`);
  }
  if (AGENT_CONTROL_FILES.test(canonicalSegment(parts[parts.length - 1]!))) throw new ToolError("denied", `Agents do not write ${p}: it steers other agents`);
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
