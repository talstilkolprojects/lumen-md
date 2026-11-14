/**
 * The `run_python` worker's logic, apart from the worker file so it can be
 * tested with a stand-in interpreter. One worker serves one call: it boots
 * Pyodide, seals itself (`sandbox.ts`), runs the code once and reports.
 */

import { MAX_PYTHON_OUTPUT_CHARS, MAX_PYTHON_REPORTS } from "./limits";
import { cleanPythonError, INPUTS_PRELUDE, SANDBOX_MODULE, SANDBOX_PRELUDE, sealPyodideApi, type SandboxReport } from "./sandbox";

/** The part of the Pyodide API the worker uses. */
export interface PyodideLike {
  runPythonAsync(code: string): Promise<unknown>;
  setStdout(opts: { batched: (s: string) => void }): void;
  setStderr(opts: { batched: (s: string) => void }): void;
  registerJsModule(name: string, module: object): void;
  unregisterJsModule?(name: string): void;
  globals: { set(key: string, value: unknown): void };
}

export interface PythonRunRequest {
  type: "run";
  code: string;
  /** `inputs`, as JSON text (an object). */
  inputsJson: string;
}

export type PythonResultValue = string | number | boolean | null;

export type PythonWorkerMessage =
  /** Booted and sealed; the agent's code starts now (the page starts its timer). */
  | { type: "ready" }
  | { type: "blocked"; api: string; target: string }
  | { type: "done"; stdout: string; stderr: string; result: PythonResultValue; error: string | null; truncated: boolean }
  /** The interpreter did not start. */
  | { type: "fatal"; message: string };

const TRUNCATED = "\n… output truncated";

/** stdout and stderr share one budget with the result. */
export class OutputBudget {
  out = "";
  err = "";
  truncated = false;
  private used = 0;
  private readonly limit: number;
  constructor(limit = MAX_PYTHON_OUTPUT_CHARS) {
    this.limit = limit;
  }

  /** Take what fits of `text`; null once the budget is spent. */
  take(text: string): string | null {
    if (this.truncated) return null;
    const left = this.limit - this.used;
    if (text.length > left) {
      this.truncated = true;
      this.used = this.limit;
      return text.slice(0, Math.max(0, left));
    }
    this.used += text.length;
    return text;
  }

  write(stream: "out" | "err", line: string): void {
    const s = this.take(line + "\n");
    if (s === null) return;
    if (stream === "out") this.out += s;
    else this.err += s;
    if (this.truncated) {
      if (stream === "out") this.out += TRUNCATED;
      else this.err += TRUNCATED;
    }
  }
}

/** The last expression's value, as something JSON can carry. */
export function toResultValue(value: unknown, budget: OutputBudget): PythonResultValue {
  if (value === undefined || value === null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") return Number.isFinite(value) ? value : String(value);
  let text: string;
  if (typeof value === "string") text = value;
  else if (typeof value === "bigint") text = value.toString();
  else {
    // A PyProxy: its str(); then free it.
    try {
      text = String(value);
    } catch {
      text = "<unprintable value>";
    }
    try {
      (value as { destroy?: () => void }).destroy?.();
    } catch {
      /* why: already destroyed */
    }
  }
  const taken = budget.take(text);
  if (taken === null) return "… (truncated)";
  return budget.truncated ? taken + "… (truncated)" : taken;
}

/**
 * The worker's message handler. `seal` seals the worker scope (the real
 * worker passes `sealPythonWorkerScope(self, …)`); it runs after the
 * interpreter booted — booting fetches Pyodide's own same-origin files —
 * and before anything from the call runs.
 */
export function createPythonHandler(deps: {
  loadPyodide: () => Promise<PyodideLike>;
  seal: (report: SandboxReport) => void;
  post: (msg: PythonWorkerMessage) => void;
}): (msg: unknown) => Promise<void> {
  let used = false;
  return async (raw) => {
    const msg = raw as Partial<PythonRunRequest> | null;
    if (used || !msg || msg.type !== "run" || typeof msg.code !== "string") return;
    used = true;
    let reports = 0;
    const report: SandboxReport = (api, target) => {
      if (reports++ >= MAX_PYTHON_REPORTS) return;
      deps.post({ type: "blocked", api: String(api).slice(0, 80), target: String(target ?? "").slice(0, 500) });
    };

    let py: PyodideLike;
    try {
      py = await deps.loadPyodide();
      deps.seal(report);
      sealPyodideApi(py, report);
      py.registerJsModule(SANDBOX_MODULE, { report: (api: unknown, target: unknown) => report(String(api), String(target ?? "")) });
      await py.runPythonAsync(SANDBOX_PRELUDE);
      py.unregisterJsModule?.(SANDBOX_MODULE);
    } catch (err) {
      deps.post({ type: "fatal", message: String((err as Error)?.message ?? err).slice(0, 2000) });
      return;
    }

    const budget = new OutputBudget();
    py.setStdout({ batched: (s) => budget.write("out", s) });
    py.setStderr({ batched: (s) => budget.write("err", s) });
    py.globals.set("__lumen_inputs_json", typeof msg.inputsJson === "string" ? msg.inputsJson : "{}");
    deps.post({ type: "ready" });

    let result: PythonResultValue = null;
    let error: string | null = null;
    try {
      await py.runPythonAsync(INPUTS_PRELUDE);
      result = toResultValue(await py.runPythonAsync(msg.code), budget);
    } catch (err) {
      const text = cleanPythonError(String((err as Error)?.message ?? err));
      error = text.length > 4000 ? text.slice(0, 2000) + "\n…\n" + text.slice(-2000) : text;
    }
    deps.post({ type: "done", stdout: budget.out, stderr: budget.err, result, error, truncated: budget.truncated });
  };
}
