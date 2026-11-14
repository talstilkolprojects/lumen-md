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
  RetryPatch,
  RunOptions,
  ToolCall,
  ToolContext,
  ToolScope,
} from "./types";
import { DEFAULT_EXECUTOR_ORDER, getExecutor, listExecutors, pickExecutor } from "./executors";
import { parseProtocolTurn, toolProtocolPrompt, toolResultMessage } from "./protocol";
import { hebrewRatio } from "../text/hebrew";
import { checkJson } from "./tools/validate";
import { formatSchemaErrors, validateSchema } from "./schema";
import { ToolError } from "./tools/define";
import { review, type Failure } from "./critic";
import { recordRun } from "./trace";
import { AiQuotaExceededError, aiQuotaStatus, chargeAiCommandDispatch, consumeAiPrompt } from "../billing/aiQuota";

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

async function execTool(tools: AgentTool[], call: ToolCall, ctx: ToolContext): Promise<{ result?: unknown; error?: string }> {
  const tool = tools.find((t) => t.name === call.name);
  if (!tool) return { error: `Unknown tool "${call.name}". Available: ${tools.map((t) => t.name).join(", ")}` };
  if (tool.scope !== "read" && !ctx.grants.has(tool.scope)) return { error: `Tool "${call.name}" needs the "${tool.scope}" permission, which was not granted for this run` };
  try {
    return { result: await tool.run(call.args, ctx) };
  } catch (e) {
    if (e instanceof ToolError) return { error: `${e.code}: ${e.message}` };
    return { error: (e as Error)?.message ?? String(e) };
  }
}

function systemPrompt<I extends AgentInput, O>(def: AgentDefinition<I, O>, input: I, nativeTools: boolean, patch: RetryPatch): string {
  const base = patch.systemOverride ?? (typeof def.system === "function" ? def.system(input) : def.system);
  const parts = [base];
  if (def.tools?.length && !nativeTools) parts.push(toolProtocolPrompt(def.tools, def.outputSchema));
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
  const finish = async (status: AgentRun["status"], extra: Partial<AgentRun<O>> = {}): Promise<AgentRun<O>> => {
    Object.assign(run, extra, { status, endedAt: Date.now() });
    await recordRun(run as AgentRun);
    // T30: if this run follows a suggestion the user picked, learn from it.
    await import("./outcomes").then((m) => m.noteRunOutcome(run as AgentRun)).catch(() => undefined);
    return run;
  };

  const grants = new Set<ToolScope>(["read", ...(opts.grants ?? [])]);
  const missing = (def.requires ?? []).filter((g) => !grants.has(g));
  if (missing.length) {
    return finish("failed", { errorCode: "denied", error: `Agent "${def.id}" needs permissions: ${missing.join(", ")}` });
  }
  const ctx: ToolContext = { signal: opts.signal, path: opts.path ?? input.path ?? null, document: opts.document ?? input.text, selection: opts.selection ?? input.selection, grants };
  const inputChars = (input.text ?? "").length + (input.selection ?? "").length;
  const maxRetries = def.maxRetries ?? DEFAULT_MAX_RETRIES;
  const maxSteps = def.maxSteps ?? DEFAULT_MAX_STEPS;
  const preference = def.executorPreference ?? DEFAULT_EXECUTOR_ORDER;

  // A suggestion the user picked for this agent and this input (suggestions panel) applies once.
  const { peekNextRunExecutor, takeNextRunPatch } = await import("./suggestions");
  const pendingExecutor = peekNextRunExecutor(def.id, run.inputKey);
  let pick = await pickExecutor(preference, opts.executor ?? pendingExecutor);
  const pending = takeNextRunPatch(def.id, run.inputKey);
  if (!pick.executor) {
    const verdict = await review({ kind: "no-executor", attempt: 1, maxRetries, tier: def.tier ?? "small", executor: null, skipped: pick.skipped, inputChars });
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

  // A cached, already-validated answer costs nothing: no prompt, no model.
  const cacheKeyOf = async (): Promise<string | null> => {
    if (!def.cache) return null;
    const { aiCacheEnabled, cacheKey } = await import("../ai/responseCache");
    if (!aiCacheEnabled()) return null;
    const sys = typeof def.system === "function" ? def.system(input) : def.system;
    // v3: answers cached before the language check (T27) are not reused.
    return cacheKey({ v: 3, agent: def.id, executor: executor.id, model: executor.modelFor(patch.tier ?? tierOf(executor.id)), sys, user: def.user(input), patch }).catch(() => null);
  };
  const key = await cacheKeyOf();
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
  let charged = false;
  const chargeOnce = (): void => {
    if (charged) return;
    if (opts.ownPrompt) {
      if (!consumeAiPrompt(new Date(), { silent: opts.ownPrompt === "silent" })) throw new AiQuotaExceededError(aiQuotaStatus(new Date()).limit);
    } else chargeAiCommandDispatch();
    charged = true;
  };
  if (!aiQuotaStatus(new Date()).allowed) {
    try {
      chargeOnce();
    } catch (e) {
      if (e instanceof AiQuotaExceededError) return finish("failed", { errorCode: "quota", error: e.message });
      throw e;
    }
  }

  for (let attempt = 1; attempt <= maxRetries + 1; attempt++) {
    run.attempts = attempt;
    if (patch.executor && patch.executor !== executor.id) {
      const forced = getExecutor(patch.executor);
      if (forced && (await forced.available()).available) executor = forced;
    }
    run.executor = executor.id;
    const tier: ModelTier = patch.tier ?? tierOf(executor.id);
    // The model is resolved once here and pinned on the request, so the
    // capability decision (native tools / schema) and the call agree.
    const model = patch.model ?? executor.modelFor(tier, { tools: !!def.tools?.length });
    const nativeTools = !!def.tools?.length && executor.supportsTools(model);
    const nativeSchema = !!def.outputSchema && !def.tools?.length && executor.supportsSchema(model);
    const messages: ExecutorMessage[] = [
      { role: "system", content: systemPrompt(def, input, nativeTools, patch) },
      { role: "user", content: def.user(input) + (patch.promptSuffix ? `\n\n${patch.promptSuffix}` : "") },
    ];
    run.model = model;

    let failure: Failure | null = null;
    let finalText: string | null = null;

    try {
      for (let i = 0; i < maxSteps && finalText === null; i++) {
        if (opts.signal?.aborted) throw new DOMException("aborted", "AbortError");
        // The chat adapter charges at dispatch, after its own checks.
        if (executor.id !== "chat") chargeOnce();
        const t0 = Date.now();
        const res = await executor.chat({
          charge: chargeOnce,
          messages,
          tools: nativeTools ? def.tools : undefined,
          schema: nativeSchema ? def.outputSchema : undefined,
          model,
          tier,
          maxTokens: def.maxTokens,
          temperature: patch.temperature ?? def.temperature,
          signal: opts.signal,
          onDelta: def.streaming && !def.tools?.length ? opts.onDelta : undefined,
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
        if (!calls.length && def.tools?.length && !nativeTools) {
          const turn = parseProtocolTurn(res.content);
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
        messages.push({ role: "assistant", content: assistantContent, toolCalls: calls });
        for (const call of calls) {
          const t1 = Date.now();
          const r = await execTool(def.tools ?? [], call, ctx);
          const body = r.error !== undefined ? toolResultMessage(call, undefined, r.error) : truncate(toolResultMessage(call, r.result), TOOL_RESULT_LIMIT);
          step({ kind: "tool", ms: Date.now() - t1, label: call.name, ok: r.error === undefined, detail: r.error ?? truncate(JSON.stringify(call.args), 200) });
          messages.push({ role: "tool", content: body, toolCallId: call.id, name: call.name });
        }
      }
      if (finalText === null) {
        failure = { kind: "empty", attempt, maxRetries, tier, executor: executor.id, reason: `no final answer after ${maxSteps} steps`, inputChars };
      }
    } catch (e) {
      if (isAbort(e, opts.signal)) return finish("aborted", { errorCode: "aborted", error: "aborted" });
      if (e instanceof AiQuotaExceededError) return finish("failed", { errorCode: "quota", error: e.message });
      const msg = (e as Error)?.message ?? String(e);
      step({ kind: "model", ms: 0, label: executor.id, ok: false, detail: truncate(msg, 300) });
      failure = { kind: "error", attempt, maxRetries, tier, executor: executor.id, reason: msg, inputChars };
    }

    if (!failure && finalText !== null) {
      let output: O | undefined;
      const text = finalText.trim();
      if (!text) {
        failure = { kind: "empty", attempt, maxRetries, tier, executor: executor.id, reason: "empty answer", inputChars };
      } else {
        try {
          if (def.parse) output = def.parse(text, input);
          else if (def.outputSchema) {
            const j = checkJson(text);
            if (!j.ok) throw new Error(j.error);
            output = j.value as O;
          } else output = text as unknown as O;
        } catch (e) {
          failure = { kind: "parse", attempt, maxRetries, tier, executor: executor.id, reason: (e as Error)?.message ?? "parse failed", hint: def.outputSchema ? "Reply with JSON only." : undefined, inputChars };
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
          failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: "schema", reason: `JSON does not match the required schema: ${formatSchemaErrors(errors)}`, hint: "Reply with JSON matching the schema exactly.", inputChars };
        }
      }
      if (!failure && output !== undefined && languageMode(def, input) === "input") {
        const t1 = Date.now();
        const r = await sameLanguage(inputTextOf(def, input), output);
        step({ kind: "validate", ms: Date.now() - t1, label: "language", ok: r.ok, detail: r.ok ? undefined : r.reason });
        if (!r.ok) failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: "language", reason: r.reason, hint: r.hint, inputChars };
      }
      if (!failure && output !== undefined) {
        for (const v of def.validators ?? []) {
          const t2 = Date.now();
          const r = await v.check(output, input);
          step({ kind: "validate", ms: Date.now() - t2, label: v.name, ok: r.ok, detail: r.ok ? undefined : r.reason });
          if (!r.ok) {
            failure = { kind: "validation", attempt, maxRetries, tier, executor: executor.id, label: v.name, reason: r.reason, hint: r.hint, inputChars };
            break;
          }
        }
      }
      if (!failure) {
        if (key) {
          const { putCached } = await import("../ai/responseCache");
          // Text agents cache the raw model text (re-parsed on a hit); JSON agents the value.
          await putCached(key, def.outputSchema || !def.parse ? JSON.stringify(output) : text, run.model ?? "").catch(() => {});
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
    return finish("failed", { errorCode: failure!.kind, error: failure!.reason ?? failure!.kind, suggestions: verdict.suggestions });
  }
  return finish("failed", { errorCode: "error", error: "exhausted" });
}

/** The agent's output, or an `AgentRunError` that carries the run (status, error, suggestions). */
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
