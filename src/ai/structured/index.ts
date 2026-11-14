/**
 * One structured-output path for every local engine (plan W7.14):
 * `generateStructured(schema, prompt)` returns JSON that matches `schema`,
 * from whichever engine is there —
 *
 *   • Ollama: `format` = the JSON Schema (W4.31, Ollama ≥ 0.5);
 *   • web-llm: `response_format: { type: "json_object", schema }`;
 *   • Chrome's built-in model: Prompt API `responseConstraint` (Chrome 148+,
 *     desktop), the "zero download" tier.
 *
 * Every answer is parsed and checked against the schema here, whatever the
 * engine promised: an answer that does not match is retried once on the
 * same engine with the errors, then the next engine is tried. Engines that
 * are not there are skipped without an error (Firefox, Safari, mobile).
 *
 * Order: short tasks (classify, tags, dates) try the built-in model first —
 * but only when its Hebrew eval passed the gate (≥ 90 % of the local
 * model's score, gate.ts); then Ollama, then web-llm. Other tasks: Ollama,
 * web-llm, then the built-in model (same gate).
 *
 * Privacy: the built-in model runs on this device; each call is in the
 * privacy ledger as "local-ai", and airplane mode allows it, since it makes
 * no request once the model is on the device.
 */
import type { Executor, JsonSchema } from "../../agents/types";
import { extractJsonObject } from "../../agents/protocol";
import { formatSchemaErrors, validateSchema } from "../../agents/schema";
import { builtinAvailability, languageModelApi, promptBuiltin, type LanguageModelApi } from "./chromeBuiltin";
import { builtinGateOpen } from "./gate";

export type StructuredEngineId = "builtin" | "ollama" | "webllm";

export interface StructuredRequest {
  system?: string;
  prompt: string;
  schema: JsonSchema;
  temperature?: number;
  signal?: AbortSignal;
}

export interface StructuredEngine {
  id: StructuredEngineId;
  /** Runs on this device with nothing sent anywhere. */
  onDevice: boolean;
  available(): Promise<boolean>;
  /** The raw text the engine returns for the constrained request. */
  generate(req: StructuredRequest): Promise<string>;
}

export interface StructuredResult<T> {
  value: T;
  engine: StructuredEngineId;
  attempts: number;
  /** Engines skipped, with why ("unavailable", "gate", "invalid output"). */
  skipped: Array<{ engine: StructuredEngineId; reason: string }>;
}

export class StructuredOutputError extends Error {
  constructor(
    message: string,
    readonly skipped: StructuredResult<unknown>["skipped"],
  ) {
    super(message);
    this.name = "StructuredOutputError";
  }
}

/** An agent executor (Ollama, web-llm) as a structured engine: its `schema` request is the constraint. */
export function executorEngine(id: "ollama" | "webllm", load: () => Promise<Executor>): StructuredEngine {
  return {
    id,
    onDevice: id === "webllm",
    available: async () => {
      try {
        const ex = await load();
        return (await ex.available()).available && ex.supportsSchema();
      } catch {
        return false;
      }
    },
    generate: async (req) => {
      const ex = await load();
      const res = await ex.chat({
        messages: [...(req.system ? [{ role: "system" as const, content: req.system }] : []), { role: "user" as const, content: req.prompt }],
        schema: req.schema,
        tier: "small",
        temperature: req.temperature ?? 0,
        maxTokens: 800,
        signal: req.signal,
      });
      return res.content;
    },
  };
}

/** Chrome's built-in model. `record`: the privacy-ledger hook (on-device). */
export function builtinEngine(api: () => LanguageModelApi | null = () => languageModelApi(), record: () => void = recordBuiltinUse): StructuredEngine {
  return {
    id: "builtin",
    onDevice: true,
    available: async () => (await builtinAvailability(api())) === "available",
    generate: async (req) => {
      const a = api();
      if (!a) throw new Error("the built-in model is not available");
      record();
      return promptBuiltin(a, req);
    },
  };
}

function recordBuiltinUse(): void {
  void import("../privacyLedger").then((m) => m.recordOnDeviceModel("Chrome built-in model"));
}

export function defaultEngines(): StructuredEngine[] {
  return [
    builtinEngine(),
    executorEngine("ollama", async () => (await import("../../agents/executors/ollama")).ollamaExecutor),
    executorEngine("webllm", async () => (await import("../../agents/executors/webllm")).webllmExecutor),
  ];
}

export type StructuredTask = "short" | "general";

/** The engines to try, in order, for a task. */
export function engineOrder(engines: readonly StructuredEngine[], task: StructuredTask): StructuredEngine[] {
  const by = (id: StructuredEngineId) => engines.find((e) => e.id === id);
  const ids: StructuredEngineId[] = task === "short" ? ["builtin", "ollama", "webllm"] : ["ollama", "webllm", "builtin"];
  return ids.map(by).filter((e): e is StructuredEngine => !!e);
}

/** Parse an engine's text as JSON and check it against the schema. */
export function checkStructured(text: string, schema: JsonSchema): { ok: true; value: unknown } | { ok: false; error: string } {
  const raw = extractJsonObject(text) ?? text.trim();
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return { ok: false, error: "not JSON" };
  }
  const errors = validateSchema(value, schema);
  return errors.length ? { ok: false, error: formatSchemaErrors(errors) } : { ok: true, value };
}

export interface GenerateOptions {
  task?: StructuredTask;
  engines?: StructuredEngine[];
  /** Is the built-in model allowed for this run (its eval gate)? Default: gate.ts. */
  builtinAllowed?: () => boolean;
  /** Retries on the same engine after an answer that does not match (default 1). */
  retries?: number;
}

/** JSON matching `schema` from the first engine that gives it. Throws StructuredOutputError when none does. */
export async function generateStructured<T = unknown>(req: StructuredRequest, opts: GenerateOptions = {}): Promise<StructuredResult<T>> {
  const engines = engineOrder(opts.engines ?? defaultEngines(), opts.task ?? "general");
  const allowBuiltin = opts.builtinAllowed ?? builtinGateOpen;
  const retries = opts.retries ?? 1;
  const skipped: StructuredResult<T>["skipped"] = [];
  let attempts = 0;
  for (const engine of engines) {
    if (req.signal?.aborted) throw new DOMException("aborted", "AbortError");
    if (engine.id === "builtin" && !allowBuiltin()) {
      skipped.push({ engine: engine.id, reason: "gate" });
      continue;
    }
    if (!(await engine.available())) {
      skipped.push({ engine: engine.id, reason: "unavailable" });
      continue;
    }
    let prompt = req.prompt;
    for (let i = 0; i <= retries; i++) {
      attempts++;
      let text: string;
      try {
        text = await engine.generate({ ...req, prompt });
      } catch (e) {
        if ((e as Error)?.name === "AbortError") throw e;
        skipped.push({ engine: engine.id, reason: `error: ${(e as Error)?.message ?? String(e)}`.slice(0, 200) });
        break;
      }
      const c = checkStructured(text, req.schema);
      if (c.ok) return { value: c.value as T, engine: engine.id, attempts, skipped };
      if (i === retries) skipped.push({ engine: engine.id, reason: `invalid output: ${c.error}`.slice(0, 200) });
      prompt = `${req.prompt}\n\nYour last answer did not match the JSON schema (${c.error}). Answer with JSON only, matching the schema exactly.`;
    }
  }
  throw new StructuredOutputError(`No engine gave JSON matching the schema (${skipped.map((s) => `${s.engine}: ${s.reason}`).join("; ") || "no engine"})`, skipped);
}
