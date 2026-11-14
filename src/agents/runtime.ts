/**
 * Agent runtime — runs an agent definition against the first available
 * executor, loops over tool calls, parses and validates the answer, and
 * when there is no usable answer asks the critic for a retry patch or
 * suggestions. Every run is recorded in the trace.
 *
 *   runAgent(def, input, opts) → AgentRun  (never throws for model/tool
 *   failures; `status` + `suggestions` say what happened)
 *   runAgentOrThrow(...)       → the output, or AgentRunError carrying the run
 */

import type {
  AgentDefinition,
  AgentInput,
  AgentRun,
  AgentStep,
  AgentTool,
  ExecutorMessage,
  ExecutorId,
  ModelTier,
  NetworkConsentRequest,
  RetryPatch,
  RunOptions,
  ToolCall,
  ToolContext,
  ToolScope,
} from "./types";
import { DEFAULT_EXECUTOR_ORDER, getExecutor, listExecutors, pickExecutor } from "./executors";
import { parseProtocolTurn, protocolSchema, toolProtocolPrompt, toolResultMessage } from "./protocol";
import { repairCall, retryMessage } from "./toolRepair";
import { hebrewRatio } from "../text/hebrew";
import { checkJson } from "./tools/validate";
import { formatSchemaErrors, validateSchema } from "./schema";
import { coerceArgs, ToolError } from "./tools/define";
import { review, type Failure } from "./critic";
import { recordRun } from "./trace";
import { currentDocumentKey } from "./docKey";
import { noteAiOutput } from "../ai/authorship";
import { AiQuotaExceededError, aiQuotaStatus, chargeAiCommandDispatch, consumeAiPrompt } from "../billing/aiQuota";
import { mergeOutputs, splitText } from "./runtimeText";
export { mergeOutputs, splitText } from "./runtimeText";
// The injection guard (plan 2.7) loads with the first run: the runtime is on the startup path.
const loadGuard = () => import("./untrusted");

export const DEFAULT_MAX_STEPS = 8;
export const DEFAULT_MAX_RETRIES = 2;
const TOOL_RESULT_LIMIT = 16_000;

export class AgentRunError extends Error {
  constructor(
    public run: AgentRun,
    message: string,
  ) {
    super(message);
    this.name = "AgentRunError";
  }
}

let runSeq = 0;
const newRunId = () => `run_${Date.now().toString(36)}_${(++runSeq).toString(36)}`;

function isAbort(e: unknown, signal?: AbortSignal): boolean {
  return !!signal?.aborted || (e instanceof DOMException && e.name === "AbortError") || (e as Error)?.name === "AbortError";
}

function truncate(s: string, n: number): string {
  return s.length > n ? s.slice(0, n) + `… [${s.length - n} more chars]` : s;
}

interface ToolEnv {
  ctx: ToolContext;
  runId: string;
  agentId: string;
  /** The open document the run's `document` comes from (`docKey.ts`). */
  docKey?: string;
  consent?: RunOptions["consentNetwork"];
  /** Ids of the changes staged in this run, in order. */
  staged: string[];
  /**
   * Where the untrusted content in this run's context came from (plan 2.7);
   * grows as tools read outside content. Non-empty: write and network
   * calls need the user's approval.
   */
  taint: string[];
  /**
   * The run holds the user's own content: the document or selection it was
   * given, or what a tool read from the workspace, the editor or a repo.
   * A network call in a tainted run asks the user only then — an injected
   * page can only exfiltrate what the run has. The researcher's web run
   * holds only the question the user asked to send (`inputMayLeave`) and
   * the pages, until the model reads a note.
   */
  private: boolean;
  consentUntrusted?: RunOptions["consentUntrusted"];
}

/** Tools whose result is the model's own input turned around, not the user's data. */
const NOT_PRIVATE = new Set(["validate_json", "validate_mermaid", "validate_echarts", "csv_parse"]);

/** Ask the user about a write / network call in a run with untrusted content (plan 2.7). */
async function approveUntrusted(env: ToolEnv, tool: AgentTool, args: Record<string, unknown>, network?: NetworkConsentRequest): Promise<boolean> {
  return (await loadGuard()).askUntrusted(env.consentUntrusted, { tool: tool.name, scope: tool.scope as "write" | "network", args, sources: [...env.taint], ...(network ? { network } : {}) });
}

/**
 * Run one tool call under the runtime's rules:
 *  - unknown tools and scopes the run was not granted are refused;
 *  - the arguments must match the tool's JSON Schema (numeric / boolean
 *    strings are coerced first);
 *  - `network` tools pass the network gate (AI policy, per-call consent,
 *    privacy ledger) and get the only fetch they may use;
 *  - `write` tools get a `stage` function and must return its receipt: the
 *    change waits for approval in `staging.ts`, nothing is written;
 *  - cancellation propagates (the run ends `aborted`); every other failure
 *    becomes a tool error the model reads.
 */
async function execTool(tools: AgentTool[], call: ToolCall, env: ToolEnv): Promise<{ result?: unknown; error?: string; note?: string; untrusted?: string[] }> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { error: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}` };
  if (tool.scope !== "read" && !env.ctx.grants.has(tool.scope)) return { error: `Tool "${call.name}" needs the "${tool.scope}" permission, which was not granted for this run` };
  const args = coerceArgs(call.args && typeof call.args === "object" ? call.args : {}, tool.parameters);
  const invalid = validateSchema(args, tool.parameters);
  if (invalid.length) return { error: `bad-args: ${formatSchemaErrors(invalid)}` };
  const callCtx: ToolContext = { ...env.ctx, stage: undefined, fetch: undefined };
  let note: string | undefined;
  const stagedHere: string[] = [];
  try {
    if (env.ctx.signal?.aborted) throw new DOMException("aborted", "AbortError");
    const tainted = env.taint.length > 0;
    if (tool.scope === "network") {
      const { openNetworkGate } = await import("./network");
      // With untrusted content in the run the gate always asks: the
      // local-only per-call consent (which then carries the warning) or,
      // under the other policies, the untrusted-content approval.
      const guard = tainted && env.private ? { untrusted: [...env.taint], approve: (req: NetworkConsentRequest) => approveUntrusted(env, tool, args, req) } : undefined;
      const gate = await openNetworkGate(tool, { ...call, args }, env.consent, guard);
      callCtx.fetch = gate.fetch;
      callCtx.network = gate.bound;
      note = gate.consented ? (tainted ? "network: sent on the user's approval (untrusted content in the run)" : "network: sent on the user's consent (local-only)") : "network: allowed by the AI policy";
    } else if (tool.scope === "write") {
      // Plan 2.7: a change proposed while outside content is in the run
      // waits for the user's explicit yes before it is even staged.
      // Plan W1.33: when all of it comes from repositories the user
      // trusts, the write is staged without that question (still for review).
      if (tainted) {
        const guard = await loadGuard();
        if (guard.taintIsTrusted(env.taint)) {
          note = "no extra approval: the untrusted content comes only from repositories the user trusts";
        } else if (!(await approveUntrusted(env, tool, args))) {
          return { error: `denied: ${guard.UNTRUSTED_DENIED}` };
        } else {
          note = "approved by the user (untrusted content in the run)";
        }
      }
      const { stageChange, receiptOf, textFingerprint } = await import("./staging");
      callCtx.stage = (proposal) => {
        // A range's offsets refer to the document the run received: record which text,
        // and which open document, that was.
        const staged =
          proposal.kind === "range"
            ? { ...proposal, basis: proposal.basis ?? textFingerprint(env.ctx.document ?? ""), docKey: proposal.docKey ?? env.docKey }
            : proposal;
        const change = stageChange(staged, { tool: tool.name, runId: env.runId, agentId: env.agentId });
        stagedHere.push(change.id);
        env.staged.push(change.id);
        return receiptOf(change);
      };
    }
    const result = await tool.run(args, callCtx);
    if (tool.scope === "write") {
      const { isStagedReceipt } = await import("./staging");
      if (!isStagedReceipt(result) || !stagedHere.includes(result.changeId)) throw new ToolError("failed", `"${tool.name}" did not return its staged change; nothing was written`);
      note = `${note ? `${note}; ` : ""}staged ${stagedHere.join(", ")} (waiting for approval)`;
    }
    let untrusted: string[] = [];
    if (tool.untrusted) {
      try {
        untrusted = await tool.untrusted(args, result, callCtx);
      } catch {
        // Can't tell where it came from: treat it as outside content.
        untrusted = [`${tool.name} result`];
      }
    }
    // A read of the user's own data (a note, the document, a repo) is now in the run.
    if (tool.scope !== "network" && !untrusted.length && !NOT_PRIVATE.has(tool.name)) env.private = true;
    return { result, note, untrusted };
  } catch (e) {
    if (isAbort(e, env.ctx.signal)) throw e;
    // A write tool that failed after staging withdraws its proposal.
    if (stagedHere.length) {
      const { rejectStagedChange } = await import("./staging");
      for (const id of stagedHere) {
        rejectStagedChange(id);
        env.staged.splice(env.staged.indexOf(id), 1);
      }
    }
    if (e instanceof ToolError) return { error: `${e.code}: ${e.message}` };
    if ((e as Error)?.name === "PrivacyBlockedError") return { error: `blocked: ${(e as Error).message}. Answer without the web, or tell the user that web research needs their consent.` };
    return { error: (e as Error)?.message ?? String(e) };
  }
}

/**
 * The tools a model may call itself. A streaming agent's tools serve only
 * as its context calls (`context`): its answer streams token by token, and
 * a tool turn would have to be parsed whole first.
 */
function modelTools(def: AgentDefinition<never, unknown>): AgentTool[] {
  return def.streaming ? [] : (def.tools ?? []);
}

function systemPrompt<I extends AgentInput, O>(def: AgentDefinition<I, O>, input: I, nativeTools: boolean, patch: RetryPatch): string {
  const base = patch.systemOverride ?? (typeof def.system === "function" ? def.system(input) : def.system);
  const parts = [base];
  const offered = modelTools(def);
  if (offered.length && !nativeTools) parts.push(toolProtocolPrompt(offered, def.outputSchema));
  // The schema stays in the prompt even when the executor constrains the
  // output natively: web-llm's JSON mode requires the prompt to ask for
  // JSON (otherwise it can emit whitespace to the token limit), and a
  // native-tools model needs to know the shape of its final answer.
  else if (def.outputSchema) parts.push("Reply with JSON only (no prose, no code fences) matching this schema: " + JSON.stringify(def.outputSchema));
  const lang = languageInstruction(def, input);
  if (lang) parts.push(lang);
  return parts.join("\n\n");
}

function inputTextOf<I extends AgentInput>(def: AgentDefinition<I, unknown>, input: I): string {
  try {
    return input.text ?? def.user(input);
  } catch {
    return input.text ?? "";
  }
}

/**
 * "Answer in the language of the input" (T27): every prompt says it, for
 * local and cloud models alike, because small local models drift into
 * English on Hebrew input.
 */
function languageMode<I extends AgentInput>(def: AgentDefinition<I, unknown>, input: I): "input" | "any" {
  const l = def.language ?? "input";
  return typeof l === "function" ? l(input) : l;
}

function languageInstruction<I extends AgentInput>(def: AgentDefinition<I, unknown>, input: I): string | null {
  if (languageMode(def, input) === "any") return null;
  const text = inputTextOf(def, input);
  if (hebrewRatio(text) >= 0.5) return "The user's text is in Hebrew. Write every natural-language part of your answer in Hebrew (keep code, URLs, file names and JSON keys as they are).";
  return "Write every natural-language part of your answer in the same language as the user's text.";
}

/**
 * The script check behind it: a mostly-Hebrew input must not get a
 * mostly-Latin answer. Short answers (under 20 letters) and non-Hebrew
 * inputs pass — they say too little to judge. Code (fenced blocks, inline
 * code spans, HTML tags) is not prose and does not count.
 */
export function sameScript(inputText: string, output: unknown): { ok: true } | { ok: false; reason: string; hint: string } {
  if (hebrewRatio(inputText) < 0.5) return { ok: true };
  const raw = typeof output === "string" ? output : JSON.stringify(output ?? "").replace(/"[\w$-]+":/g, " ");
  const text = raw
    .replace(/```[\s\S]*?(?:```|$)/g, " ")
    .replace(/~~~[\s\S]*?(?:~~~|$)/g, " ")
    .replace(/`[^`\n]*`/g, " ")
    .replace(/<\/?[A-Za-z][^<>]*>/g, " ");
  const letters = text.match(/\p{L}/gu) ?? [];
  if (letters.length < 20) return { ok: true };
  const r = hebrewRatio(text);
  if (r >= 0.15) return { ok: true };
  return { ok: false, reason: `the input is Hebrew but the answer is ${Math.round(r * 100)}% Hebrew`, hint: "Answer in Hebrew, the language of the user's text." };
}

const LANGUAGE_NAMES: Record<string, string> = { he: "Hebrew", en: "English", ar: "Arabic", ru: "Russian", fr: "French", de: "German", ja: "Japanese", zh: "Chinese", es: "Spanish", it: "Italian", pt: "Portuguese", nl: "Dutch", uk: "Ukrainian", fa: "Persian", tr: "Turkish", pl: "Polish" };
const languageName = (tag: string) => LANGUAGE_NAMES[tag] ?? tag;

/**
 * The language check (plan 6.5): `sameScript` first; then, where input and
 * answer share a script (French in, English out), local language
 * identification decides. It acts only when both texts are long enough for
 * a confident guess, so a short or mixed answer is never rejected on it.
 */
export async function sameLanguage(inputText: string, output: unknown): Promise<{ ok: true } | { ok: false; reason: string; hint: string }> {
  const script = sameScript(inputText, output);
  if (!script.ok || hebrewRatio(inputText) >= 0.5) return script;
  const raw = typeof output === "string" ? output : JSON.stringify(output ?? "").replace(/"[\w$-]+":/g, " ");
  let detect: typeof import("../text/langId").detectLanguage;
  try {
    ({ detectLanguage: detect } = await import("../text/langId"));
  } catch {
    return { ok: true }; // the detector chunk failed to load: keep the script check only
  }
  const a = detect(inputText);
  const b = detect(raw);
  if (!a.confident || !b.confident || a.lang === "und" || b.lang === "und" || a.lang === b.lang || a.script !== b.script) return { ok: true };
  return { ok: false, reason: `the input is ${languageName(a.lang)} but the answer is ${languageName(b.lang)}`, hint: `Answer in ${languageName(a.lang)}, the language of the user's text.` };
}

/** A short stable key of an agent's input: a retry patch is bound to it. */
export function inputKeyOf<I extends AgentInput>(def: AgentDefinition<I, unknown>, input: I): string {
  let text: string;
  try {
    text = def.id + "\u0000" + def.user(input);
  } catch {
    text = def.id + "\u0000" + (input.text ?? "");
  }
  // FNV-1a, 32 bit, plus the length: enough to tell inputs of one command apart.
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return `${(h >>> 0).toString(36)}-${text.length.toString(36)}`;
}

export async function runAgent<I extends AgentInput, O = string>(def: AgentDefinition<I, O>, input: I, opts: RunOptions = {}): Promise<AgentRun<O>> {
  // Before anything awaits: the document the caller just read is the active one now.
  const docKey = opts.docKey ?? currentDocumentKey();
  const run: AgentRun<O> = {
    id: newRunId(),
    agentId: def.id,
    commandId: def.commandId,
    executor: null,
    model: null,
    startedAt: Date.now(),
    endedAt: 0,
    status: "failed",
    attempts: 0,
    steps: [],
    suggestions: [],
    tokens: { input: 0, output: 0, estimated: false },
    inputKey: inputKeyOf(def, input),
  };
  const step = (st: Omit<AgentStep, "at">): void => {
    const full = { at: Date.now(), ...st };
    run.steps.push(full);
    opts.onStep?.(full);
  };
  const staged: string[] = [];
  // A streamed answer is marked as it arrives, piece by piece (plan 5.9).
  let streamed = "";
  const onDelta = opts.onDelta
    ? (d: string) => {
        streamed += d;
        noteAiOutput(run.id, streamed);
        opts.onDelta?.(d);
      }
    : undefined;
  const toolEnvRef: { current: ToolEnv | null } = { current: null };
  const finish = async (status: AgentRun["status"], extra: Partial<AgentRun<O>> = {}): Promise<AgentRun<O>> => {
    Object.assign(run, extra, { status, endedAt: Date.now() });
    // Plan 5.9: the editor marks this answer where it lands in a note.
    if (status === "ok") noteAiOutput(run.id, run.output);
    if (toolEnvRef.current?.taint.length) run.untrusted = [...toolEnvRef.current.taint];
    if (staged.length) {
      run.staged = [...staged];
      // A cancelled run withdraws what it proposed; any other run leaves its proposals for review.
      if (status === "aborted") await import("./staging").then((m) => m.discardRunChanges(run.id)).catch(() => 0);
    }
    await recordRun(run as AgentRun);
    // 5.6.3: the answer can be marked "not good"; a re-done run closes its loop.
    if (!opts.part) {
      const sug = await import("./suggestions");
      if (run.retryOf) sug.noteRetried(run.retryOf, run.id);
      if (status === "ok") sug.announceAnswer({ run: run as AgentRun, commandId: run.commandId });
    }
    // T30: if this run follows a suggestion the user picked, learn from it.
    await import("./outcomes").then((m) => m.noteRunOutcome(run as AgentRun)).catch(() => undefined);
    return run;
  };

  const grants = new Set<ToolScope>(["read", ...(opts.grants ?? [])]);
  const missing = (def.requires ?? []).filter((g) => !grants.has(g));
  if (missing.length) {
    return finish("failed", { errorCode: "denied", error: `Agent "${def.id}" needs permissions: ${missing.join(", ")}` });
  }
  const ctx: ToolContext = {
    signal: opts.signal,
    path: opts.path ?? input.path ?? null,
    document: opts.document ?? input.text,
    selection: opts.selection ?? input.selection,
    grants,
    pages: opts.pages ?? new Map(),
  };
  // Plan 2.7: outside content in the input (a clipped page, an imported or
  // pulled note, or what the caller says is untrusted) is cleaned and
  // delimited before the model sees it, and taints the run from the start.
  const guard = await loadGuard();
  const inputUntrusted = await guard.inputSources({ path: ctx.path, document: ctx.document, text: input.text, selection: input.selection, untrusted: opts.untrusted });
  if (inputUntrusted.length) ctx.documentUntrusted = inputUntrusted;
  const toolEnv: ToolEnv = {
    ctx,
    runId: run.id,
    agentId: def.id,
    docKey,
    consent: opts.consentNetwork,
    staged,
    // Outside tools (MCP servers, review 21 C1): offering them already puts outside text in the context.
    taint: [...inputUntrusted, ...new Set((def.tools ?? []).flatMap((t) => t.offeredBy ?? []))],
    // What the run was given is the user's own, unless the user asked for it to go out (a research question).
    private: !opts.inputMayLeave && !!(ctx.document || ctx.selection || input.text),
    consentUntrusted: opts.consentUntrusted,
  };
  const modelInput: I = guard.guardInput(input, inputUntrusted, ctx.document);
  toolEnvRef.current = toolEnv;
  // W11.I2: the privacy log shows when a run became tainted, and by what.
  if (toolEnv.taint.length) await guard.logRuleOfTwo({ event: "tainted", sources: toolEnv.taint });
  const inputChars = (input.text ?? "").length + (input.selection ?? "").length;
  const maxRetries = def.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxSteps = def.maxSteps ?? DEFAULT_MAX_STEPS;
  const preference = def.executorPreference ?? DEFAULT_EXECUTOR_ORDER;

  // A suggestion the user picked for this agent and this input (suggestions panel) applies once.
  const { peekNextRunExecutor, takeNextRunPatch, retryOfPending } = await import("./suggestions");
  const pendingExecutor = peekNextRunExecutor(def.id, run.inputKey);
  // An agent that names its executors runs only on those: a forced one (option,
  // suggestion or critic patch) outside the list is ignored (W2.18: the canvas
  // "draw me" stays on this device's models).
  const allowedExecutor = (id: ExecutorId | undefined) => (id && (!def.executorPreference || def.executorPreference.includes(id)) ? id : undefined);
  let pick = await pickExecutor(preference, allowedExecutor(opts.executor ?? pendingExecutor));
  // "Not good" (5.6.3): this run re-does one the user rejected; the trace links them.
  const redo = retryOfPending(def.id, run.inputKey);
  if (redo) run.retryOf = redo;
  const pending = takeNextRunPatch(def.id, run.inputKey);
  if (!pick.executor) {
    const verdict = await review({ kind: "no-executor", attempt: 1, maxRetries, tier: def.tier ?? "small", executor: null, skipped: pick.skipped, inputChars, splittable: !!def.splittable });
    step({ kind: "critic", ms: 0, label: verdict.diagnosis, ok: false, detail: pick.skipped.map((x) => `${x.id}: ${x.availability.reason ?? "unavailable"}`).join("; ") });
    return finish("failed", { errorCode: "no-executor", error: `No AI executor is available (${verdict.diagnosis})`, suggestions: verdict.suggestions });
  }
  let executor = pick.executor;
  let patch: RetryPatch = { ...(pending ?? {}), ...(opts.patch ?? {}) };
  // The AI mode is read once per run (plan 5.7): switching it in the
  // settings changes the local model of the next run, never of one under
  // way. A retry patch's tier is explicit and is not shifted again.
  const { getAiMode, tierForMode } = await import("../ai/aiMode");
  const mode = getAiMode();
  const tierOf = (id: ExecutorId): ModelTier => (id === "chat" ? def.tier ?? "small" : tierForMode(def.tier ?? "small", mode));

  // "Split the document" (5.6.2): the agent runs on each part, and the answers are merged.
  if (patch.split && def.splittable && (input.text ?? "").length > patch.split) {
    const { split, ...rest } = patch;
    const parts = splitText(input.text ?? "", split);
    const outputs: O[] = [];
    for (const [i, part] of parts.entries()) {
      if (opts.signal?.aborted) return finish("aborted", { errorCode: "aborted", error: "aborted" });
      const sub = await runAgent(def, { ...input, text: part } as I, { ...opts, signal: opts.signal, patch: rest, document: part, selection: undefined, executor: executor.id, part: true });
      run.tokens.input += sub.tokens.input;
      run.tokens.output += sub.tokens.output;
      run.attempts = Math.max(run.attempts, sub.attempts);
      run.executor = sub.executor;
      run.model = sub.model;
      step({ kind: "model", ms: sub.endedAt - sub.startedAt, label: `part ${i + 1}/${parts.length}`, ok: sub.status === "ok", detail: sub.status === "ok" ? `${part.length} chars` : sub.error });
      if (sub.status !== "ok" || sub.output === undefined) return finish(sub.status === "aborted" ? "aborted" : "failed", { errorCode: sub.errorCode ?? "error", error: `part ${i + 1}/${parts.length}: ${sub.error ?? sub.status}`, suggestions: sub.suggestions });
      outputs.push(sub.output);
    }
    return finish("ok", { output: mergeOutputs(outputs) });
  }

  // The context the agent always needs, fetched once through the tool path
  // (plan 5.3); every attempt starts from it. Before the cache lookup: an
  // answer is only reused for the same context (the same tags, the same
  // note list), not just the same prompt.
  const context: ExecutorMessage[] = [];
  for (const [i, c] of (def.context?.(input) ?? []).entries()) {
    if (opts.signal?.aborted) return finish("aborted", { errorCode: "aborted", error: "aborted" });
    const call: ToolCall = { id: `ctx_${run.id}_${i}`, name: c.tool, args: c.args ?? {} };
    const t1 = Date.now();
    let r: Awaited<ReturnType<typeof execTool>>;
    try {
      r = await execTool(def.tools ?? [], call, toolEnv);
    } catch (e) {
      if (isAbort(e, opts.signal)) return finish("aborted", { errorCode: "aborted", error: "aborted" });
      throw e;
    }
    let body: string;
    let guardNote = "";
    if (r.error !== undefined) body = toolResultMessage(call, undefined, r.error);
    else if (r.untrusted?.length) {
      // Plan 2.7: context from outside notes is cleaned and delimited, and taints the run
      // (the system prompt, built after this loop, then carries the rule).
      const wasClean = toolEnv.taint.length === 0;
      ({ body, note: guardNote } = guard.guardToolResult((v) => truncate(toolResultMessage(call, v), TOOL_RESULT_LIMIT), r.result, r.untrusted, toolEnv.taint, []));
      if (wasClean) await guard.logRuleOfTwo({ event: "tainted", sources: toolEnv.taint });
    } else body = truncate(toolResultMessage(call, r.result), TOOL_RESULT_LIMIT);
    step({ kind: "tool", ms: Date.now() - t1, label: call.name, ok: r.error === undefined, detail: ["context", guardNote, r.error ?? truncate(JSON.stringify(call.args), 200)].filter(Boolean).join(" · ") });
    context.push({ role: "assistant", content: "", toolCalls: [call] }, { role: "tool", content: body, toolCallId: call.id, name: call.name });
  }


  // A cached, already-validated answer costs nothing: no prompt, no model.
  const cacheKeyOf = async (): Promise<string | null> => {
    if (!def.cache) return null;
    const { aiCacheEnabled, cacheKey } = await import("../ai/responseCache");
    if (!aiCacheEnabled()) return null;
    const sys = typeof def.system === "function" ? def.system(input) : def.system;
    // v3: answers cached before the language check (T27) are not reused.
    const ctx = context.filter((m) => m.role === "tool").map((m) => m.content);
    return cacheKey({ v: 3, agent: def.id, executor: executor.id, model: executor.modelFor(patch.tier ?? tierOf(executor.id)), sys, user: def.user(input), patch, ...(ctx.length ? { context: ctx } : {}) }).catch(() => null);
  };
  // A run with outside content in its input or context is never cached (nor answered from the cache).
  const key = toolEnv.taint.length ? null : await cacheKeyOf();
  if (key) {
    const { getCached } = await import("../ai/responseCache");
    const hit = await getCached(key);
    if (hit) {
      let output: O | undefined;
      try {
        output = (def.outputSchema || !def.parse ? JSON.parse(hit.text) : def.parse(hit.text, input)) as O;
      } catch {
        output = undefined;
      }
      // A cached answer passes the same language check as a fresh one.
      if (output !== undefined && languageMode(def, input) === "input" && !(await sameLanguage(inputTextOf(def, input), output)).ok) output = undefined;
      if (output !== undefined) {
        step({ kind: "cache", ms: 0, label: "hit", ok: true });
        return finish("ok", { output, model: hit.model, executor: executor.id });
      }
    }
  }

  // One user action = one prompt against the monthly quota, however many
  // model calls, tools and retries the run takes. It is charged right before
  // the first request actually goes out — the chat adapter defers it past
  // its own key / rate-limit checks — so a run that fails locally (or is
  // cancelled first) spends nothing. At the limit nothing goes out at all.
  // A batch job paid for the whole job when it was submitted (`prepaid`).
  let charged = !!opts.prepaid;
  const chargeOnce = (): void => {
    if (charged) return;
    if (opts.ownPrompt) {
      if (!consumeAiPrompt(new Date(), { silent: opts.ownPrompt === "silent" })) throw new AiQuotaExceededError(aiQuotaStatus(new Date()).limit);
    } else chargeAiCommandDispatch();
    charged = true;
  };
  if (!charged && !aiQuotaStatus(new Date()).allowed) {
    try {
      chargeOnce();
    } catch (e) {
      if (e instanceof AiQuotaExceededError) return finish("failed", { errorCode: "quota", error: e.message });
      throw e;
    }
  }

  // One more attempt when the model critic diagnosed the failure and proposed its own retry (5.6.1).
  let modelRetryUsed = false;
  for (let attempt = 1; attempt <= maxRetries + 1 + (modelRetryUsed ? 1 : 0); attempt++) {
    run.attempts = attempt;
    if (patch.executor && patch.executor !== executor.id && allowedExecutor(patch.executor)) {
      const forced = getExecutor(patch.executor);
      if (forced && (await forced.available()).available) executor = forced;
    }
    run.executor = executor.id;
    const tier: ModelTier = patch.tier ?? tierOf(executor.id);
    // The model is resolved once here and pinned on the request, so the
    // capability decision (native tools / schema) and the call agree.
    const offered = modelTools(def);
    const model = patch.model ?? executor.modelFor(tier, { tools: offered.length > 0 });
    // Small models get every turn held to a JSON Schema where the executor can
    // (5.3.5): JSON-ReAct under the protocol's schema is more reliable for
    // them than free-form native tool calls, whose arguments and final answer
    // are not constrained. Every local model is small next to a cloud one, so
    // a local executor constrains at every tier (plan W4.31: Ollama's
    // structured outputs on every tool call); cloud models above "small" use
    // native tools when they have them.
    const constrain = (executor.id !== "chat" || tier === "tiny" || tier === "small") && executor.supportsSchema(model);
    const nativeTools = offered.length > 0 && !constrain && executor.supportsTools(model);
    const nativeSchema = !!def.outputSchema && !offered.length && executor.supportsSchema(model);
    // A model without native tools speaks JSON-ReAct; where the executor can
    // constrain output, every turn is held to the protocol's schema (5.3.5).
    const turnSchema = offered.length && !nativeTools && executor.supportsSchema(model) ? protocolSchema(offered, def.outputSchema) : undefined;
    const messages: ExecutorMessage[] = [
      { role: "system", content: systemPrompt(def, modelInput, nativeTools, patch) + (toolEnv.taint.length ? `\n\n${guard.UNTRUSTED_NOTICE}` : "") },
      { role: "user", content: def.user(modelInput) + (patch.promptSuffix ? `\n\n${patch.promptSuffix}` : "") },
      ...context,
    ];
    run.model = model;

    let failure: Failure | null = null;
    let finalText: string | null = null;
    // Plan W4.31: an invalid tool call gets one retry with the schema error;
    // a second invalid turn in a row stops the run and asks the user.
    let invalidTurns = 0;
    let askUser: { tool: string; problem: string } | null = null;

    try {
      for (let i = 0; i < maxSteps && finalText === null && !askUser; i++) {
        if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
        // The chat adapter charges at dispatch, after its own checks.
        if (executor.id !== "chat") chargeOnce();
        const t0 = Date.now();
        const res = await executor.chat({
          charge: chargeOnce,
          messages,
          tools: nativeTools ? offered : undefined,
          schema: nativeSchema ? def.outputSchema : turnSchema,
          model,
          tier,
          maxTokens: typeof def.maxTokens === "function" ? def.maxTokens(input) : def.maxTokens,
          temperature: patch.temperature ?? def.temperature,
          signal: opts.signal,
          onDelta: def.streaming && !offered.length ? onDelta : undefined,
        });
        run.model = res.model || run.model;
        if (res.usage) {
          run.tokens.input += res.usage.inputTokens;
          run.tokens.output += res.usage.outputTokens;
          run.tokens.estimated ||= res.usage.estimated;
        }
        step({ kind: "model", ms: Date.now() - t0, label: res.model, ok: true, detail: res.toolCalls.length ? `${res.toolCalls.length} tool call(s)` : truncate(res.content, 200) });

        let calls: ToolCall[] = res.toolCalls;
        let assistantContent = res.content;
        if (!calls.length && offered.length && !nativeTools) {
          const turn = parseProtocolTurn(res.content, offered);
          if (turn.kind === "tool") {
            calls = [turn.call];
            assistantContent = "";
          } else {
            finalText = turn.content;
            break;
          }
        }
        if (!calls.length) {
          finalText = res.content;
          break;
        }
        // Plan W4.31: the slips small models make (shape, name case, string
        // numbers, a wrapper object…) are fixed before the call is checked.
        const repaired = calls.map((c) => repairCall(c, offered));
        calls = repaired.map((r) => r.call);
        messages.push({ role: "assistant", content: assistantContent, toolCalls: calls });
        const priorInvalid = invalidTurns > 0;
        let turnInvalid = false;
        for (const [ci, call] of calls.entries()) {
          const t1 = Date.now();
          const r = await execTool(offered, call, toolEnv);
          let body: string;
          let guardNote = "";
          const repairNote = repaired[ci].repairs.length ? `repaired: ${repaired[ci].repairs.join(", ")}` : "";
          const invalid = r.error !== undefined && (r.error.startsWith("bad-args:") || r.error.startsWith("Unknown tool"));
          turnInvalid ||= invalid;
          if (invalid && priorInvalid) {
            // The one retry was spent: ask the user instead of guessing (plan W4.31).
            step({ kind: "tool", ms: Date.now() - t1, label: call.name, ok: false, detail: r.error });
            askUser = { tool: call.name, problem: r.error!.replace(/^bad-args:\s*/, "") };
            break;
          }
          if (invalid) body = toolResultMessage(call, undefined, retryMessage(call, offered, r.error!));
          else if (r.error !== undefined) body = toolResultMessage(call, undefined, r.error);
          else if (r.untrusted?.length) {
            // Outside content: cleaned, then delimited (after truncation, so the closing marker stays).
            const wasClean = toolEnv.taint.length === 0;
            ({ body, note: guardNote } = guard.guardToolResult((v) => truncate(toolResultMessage(call, v), TOOL_RESULT_LIMIT), r.result, r.untrusted, toolEnv.taint, messages));
            if (wasClean) await guard.logRuleOfTwo({ event: "tainted", sources: toolEnv.taint });
          } else body = truncate(toolResultMessage(call, r.result), TOOL_RESULT_LIMIT);
          const argsText = truncate(JSON.stringify(call.args), 200);
          const detail = [r.note, guardNote, repairNote, argsText].filter(Boolean).join(" · ");
          step({ kind: "tool", ms: Date.now() - t1, label: call.name, ok: r.error === undefined, detail: r.error ?? detail });
          messages.push({ role: "tool", content: body, toolCallId: call.id, name: call.name });
        }
        invalidTurns = turnInvalid ? invalidTurns + 1 : 0;
      }
      if (finalText === null && !askUser) {
        failure = { kind: "empty", attempt, maxRetries, tier, executor: executor.id, reason: `no final answer after ${maxSteps} steps`, inputChars, splittable: !!def.splittable };
      }
    } catch (e) {
      if (isAbort(e, opts.signal)) return finish("aborted", { errorCode: "aborted", error: "aborted" });
      if (e instanceof AiQuotaExceededError) return finish("failed", { errorCode: "quota", error: e.message });
      const msg = (e as Error)?.message ?? String(e);
      step({ kind: "model", ms: 0, label: executor.id, ok: false, detail: truncate(msg, 300) });
      failure = { kind: "error", attempt, maxRetries, tier, executor: executor.id, reason: msg, inputChars, splittable: !!def.splittable };
    }

    if (askUser) {
      const ask: { tool: string; problem: string } = askUser;
      return finish("failed", {
        errorCode: "tool-args",
        error: `The model could not make a valid call to ${ask.tool} (${ask.problem}). Say exactly what it needs and run the command again.`,
        suggestions: [{ id: "clarify-tool", title: "agent.suggest.clarifyTool", params: { tool: ask.tool, problem: truncate(ask.problem, 120) } }],
      });
    }
    if (!failure && finalText !== null) {
      let output: O | undefined;
      const text = finalText.trim();
      if (!text) {
        failure = { kind: "empty", attempt, maxRetries, tier, executor: executor.id, reason: "empty answer", inputChars, splittable: !!def.splittable };
      } else {
        try {
          if (def.parse) output = def.parse(text, input);
          else if (def.outputSchema) {
            const j = checkJson(text);
            if (!j.ok) throw new Error(j.error);
            output = j.value as O;
          } else output = text as unknown as O;
        } catch (e) {
          failure = { kind: "parse", attempt, maxRetries, tier, executor: executor.id, reason: (e as Error)?.message ?? "parse failed", hint: def.outputSchema ? "Reply with JSON only." : undefined, inputChars, splittable: !!def.splittable };
          step({ kind: "validate", ms: 0, label: "parse", ok: false, detail: failure.reason });
        }
      }
      // The declared schema is enforced on the parsed value even when the
      // executor constrained the output natively: a model can still ignore
      // the constraint, and prompt-only executors never had one.
      if (!failure && output !== undefined && def.outputSchema) {
        const errors = validateSchema(output, def.outputSchema);
        step({ kind: "validate", ms: 0, label: "schema", ok: errors.length === 0, detail: errors.length ? formatSchemaErrors(errors) : undefined });
        if (errors.length) {
          failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: "schema", reason: `JSON does not match the required schema: ${formatSchemaErrors(errors)}`, hint: "Reply with JSON matching the schema exactly.", inputChars, splittable: !!def.splittable };
        }
      }
      if (!failure && output !== undefined && languageMode(def, input) === "input") {
        const t1 = Date.now();
        const r = await sameLanguage(inputTextOf(def, input), output);
        step({ kind: "validate", ms: Date.now() - t1, label: "language", ok: r.ok, detail: r.ok ? undefined : r.reason });
        if (!r.ok) failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: "language", reason: r.reason, hint: r.hint, inputChars, splittable: !!def.splittable };
      }
      if (!failure && output !== undefined) {
        for (const v of def.validators ?? []) {
          const t2 = Date.now();
          const r = await v.check(output, input, { pages: ctx.pages ?? new Map() });
          step({ kind: "validate", ms: Date.now() - t2, label: v.name, ok: r.ok, detail: r.ok ? undefined : r.reason });
          if (!r.ok) {
            failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: v.name, reason: r.reason, hint: r.hint, inputChars, splittable: !!def.splittable };
            break;
          }
        }
      }
      if (!failure) {
        if (key) {
          const { putCached } = await import("../ai/responseCache");
          // Text agents cache the raw model text (re-parsed on a hit); JSON agents the value.
          await putCached(key, def.outputSchema || !def.parse ? JSON.stringify(output) : text, run.model ?? "").catch(() => { /* why: the answer is already returned; a failed cache write only means no cache hit next time */ });
        }
        return finish("ok", { output });
      }
    }

    // No usable answer: ask the critic.
    const alternatives: ExecutorId[] = [];
    for (const ex of listExecutors()) {
      if (ex.id !== executor.id && preference.includes(ex.id) && (await ex.available()).available) alternatives.push(ex.id);
    }
    const verdict = await review({ ...failure!, alternatives, agentId: def.id, signal: opts.signal });
    if (opts.signal?.aborted) return finish("aborted", { errorCode: "aborted", error: "aborted" });
    step({ kind: "critic", ms: 0, label: verdict.diagnosis, ok: !!verdict.retry, detail: failure!.reason });
    if (verdict.retry && attempt <= maxRetries) {
      patch = { ...patch, ...verdict.retry };
      step({ kind: "retry", ms: 0, label: `attempt ${attempt + 1}`, ok: true, detail: JSON.stringify({ tier: patch.tier, temperature: patch.temperature, executor: patch.executor }) });
      continue;
    }
    if (verdict.retry && verdict.byModel && !modelRetryUsed) {
      // The retries are spent and the model critic proposed a concrete change: one attempt with it.
      modelRetryUsed = true;
      patch = { ...patch, ...verdict.retry };
      step({ kind: "retry", ms: 0, label: `attempt ${attempt + 1} (model critic)`, ok: true, detail: truncate(verdict.retry.promptSuffix ?? "", 200) });
      continue;
    }
    return finish("failed", { errorCode: failure!.kind, error: failure!.reason ?? failure!.kind, suggestions: verdict.suggestions });
  }
  return finish("failed", { errorCode: "error", error: "exhausted" });
}

/** The agent's output, or an `AgentRunError` that carries the run (status, error, suggestions). */
export interface CallToolOptions {
  /** Scopes granted for this call (`read` always is). */
  grants?: ToolScope[];
  signal?: AbortSignal;
  document?: string;
  selection?: string;
  path?: string | null;
  consentNetwork?: RunOptions["consentNetwork"];
  /** Who calls, for the staged changes' provenance (write tools). */
  runId?: string;
  agentId?: string;
}

/**
 * Call one tool outside a model turn, under the runtime's rules — the scope
 * must be granted, the arguments must match the tool's schema, a network
 * tool passes the network gate, a write tool only stages. For a command
 * that needs what a tool returns (the note list to check an agent's links
 * against) and for agents that need no model (the digest): they go through
 * the same path as an agent's own calls instead of importing the source.
 * Resolves to the tool's result; rejects with a ToolError carrying its error.
 */
export async function callTool<R = unknown>(name: string, args: Record<string, unknown> = {}, opts: CallToolOptions = {}): Promise<R> {
  const { getTool } = await import("./tools");
  const tool = getTool(name);
  if (!tool) throw new ToolError("bad-args", `Unknown tool "${name}"`);
  const env: ToolEnv = {
    ctx: { signal: opts.signal, path: opts.path ?? null, document: opts.document, selection: opts.selection, grants: new Set<ToolScope>(["read", ...(opts.grants ?? [])]), pages: new Map() },
    runId: opts.runId ?? newRunId(),
    agentId: opts.agentId ?? "command",
    consent: opts.consentNetwork,
    staged: [],
    // No model reads a direct call's result, so outside content in it needs no approval here (plan 2.7).
    taint: [],
    private: false,
  };
  const r = await execTool([tool], { id: `direct_${++runSeq}`, name, args }, env);
  if (r.error !== undefined) {
    const code = r.error.startsWith("bad-args") ? "bad-args" : r.error.startsWith("not-found") ? "not-found" : r.error.startsWith("denied") || / permission, which was not granted/.test(r.error) ? "denied" : "failed";
    throw new ToolError(code, r.error);
  }
  return r.result as R;
}

export async function runAgentOrThrow<I extends AgentInput, O = string>(def: AgentDefinition<I, O>, input: I, opts: RunOptions = {}): Promise<O> {
  const run = await runAgent(def, input, opts);
  if (run.status === "ok" && run.output !== undefined) return run.output;
  throw new AgentRunError(run as AgentRun, run.error ?? run.status);
}

/**
 * Run a streaming agent as an async generator of text deltas (what the
 * editor's streaming UIs consume). Throws AgentRunError when the run does
 * not end with a usable answer. Closing the generator early aborts the run.
 */
export async function* streamAgent<I extends AgentInput>(def: AgentDefinition<I, string>, input: I, opts: RunOptions = {}): AsyncGenerator<string, void, undefined> {
  const queue: string[] = [];
  let wake: (() => void) | null = null;
  let done = false;
  let result: AgentRun<string> | null = null;
  const ctrl = new AbortController();
  const onOuter = () => ctrl.abort();
  if (opts.signal?.aborted) ctrl.abort();
  else opts.signal?.addEventListener("abort", onOuter, { once: true });
  const p = runAgent(def, input, {
    ...opts,
    signal: ctrl.signal,
    onDelta: (d) => {
      queue.push(d);
      wake?.();
    },
  }).then((r) => {
    result = r;
    done = true;
    wake?.();
  });
  let yielded = false;
  try {
    for (;;) {
      if (queue.length) {
        yielded = true;
        yield queue.shift()!;
        continue;
      }
      if (done) break;
      await new Promise<void>((r) => {
        wake = r;
      });
      wake = null;
    }
    await p;
    const run = result as AgentRun<string> | null;
    if (!run || run.status !== "ok") throw new AgentRunError(run as AgentRun, run?.error ?? "agent failed");
    // An executor that could not stream: the whole answer arrives once.
    if (!yielded && run.output) yield run.output;
  } finally {
    opts.signal?.removeEventListener("abort", onOuter);
    if (!done) ctrl.abort();
  }
}
