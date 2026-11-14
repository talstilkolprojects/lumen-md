/**
 * Page side of `run_python`: one fresh worker per call (nothing carries
 * over between calls — not variables, not a listener a previous call
 * left behind), terminated when the call ends, times out or is cancelled.
 * Blocked network attempts the worker reports go to the privacy ledger.
 */

import { recordBlockedRequest } from "../../ai/privacyLedger";
import { abortError, ToolError } from "../tools/define";
import { MAX_PYTHON_OUTPUT_CHARS, MAX_PYTHON_REPORTS, PYTHON_BOOT_TIMEOUT_MS } from "./limits";
import type { PythonResultValue, PythonWorkerMessage } from "./handler";

export interface PythonRunResult {
  /** The code ran to the end without an exception. */
  ok: boolean;
  stdout: string;
  stderr: string;
  /** The last expression's value (numbers and booleans as such, anything else as its str()). */
  result: PythonResultValue;
  error: string | null;
  timedOut: boolean;
  /** Output (stdout + stderr + result) hit the cap. */
  truncated: boolean;
  /** Network attempts that were refused (each is in the privacy ledger). */
  blocked: Array<{ api: string; target: string }>;
  ms: number;
}

/** The part of `Worker` the runner uses (tests pass a stand-in). */
export interface PythonWorkerLike {
  postMessage(msg: unknown): void;
  terminate(): void;
  onmessage: ((e: MessageEvent) => void) | null;
  onerror: ((e: ErrorEvent) => void) | null;
}

const defaultFactory = (): PythonWorkerLike => new Worker(new URL("./python.worker.ts", import.meta.url), { type: "module" });
let factory: () => PythonWorkerLike = defaultFactory;

/** Tests: replace the worker (no Pyodide in Node). Without an argument, restore the real one. */
export function setPythonWorkerFactory(f?: () => PythonWorkerLike): void {
  factory = f ?? defaultFactory;
}

export const LEDGER_REASON = "Agent tool run_python: the Python sandbox has no network";

/** The ledger keeps the host only; an attempt without a URL is filed under a host that cannot exist. */
function ledgerUrl(target: string): string {
  return /^(https?|wss?):\/\//i.test(target) ? target : "https://python-sandbox.invalid/";
}

/** The worker already capped; this is the page's own bound (room for the worker's "truncated" marks). */
const OUTPUT_BOUND = MAX_PYTHON_OUTPUT_CHARS + 64;
const cap = (s: unknown, n = OUTPUT_BOUND) => (typeof s === "string" ? s.slice(0, n) : "");

export function runPython(opts: { code: string; inputsJson: string; timeoutMs: number; signal?: AbortSignal }): Promise<PythonRunResult> {
  return new Promise<PythonRunResult>((resolve, reject) => {
    if (opts.signal?.aborted) return reject(abortError());
    const started = Date.now();
    let worker: PythonWorkerLike;
    try {
      worker = factory();
    } catch (err) {
      return reject(new ToolError("failed", `Could not start the Python worker: ${(err as Error)?.message ?? err}`));
    }
    const blocked: PythonRunResult["blocked"] = [];
    let done = false;
    let codeRunning = false;
    const finish = (settle: () => void) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onAbort);
      worker.onmessage = null;
      worker.onerror = null;
      try {
        worker.terminate();
      } catch {
        /* why: already gone */
      }
      settle();
    };
    const empty = (over: Partial<PythonRunResult>): PythonRunResult => ({
      ok: false,
      stdout: "",
      stderr: "",
      result: null,
      error: null,
      timedOut: false,
      truncated: false,
      blocked,
      ms: Date.now() - started,
      ...over,
    });
    const onAbort = () => finish(() => reject(abortError()));
    opts.signal?.addEventListener("abort", onAbort, { once: true });
    let timer = setTimeout(
      () => finish(() => reject(new ToolError("failed", `The Python runtime (Pyodide) did not start within ${PYTHON_BOOT_TIMEOUT_MS / 1000} s`))),
      PYTHON_BOOT_TIMEOUT_MS,
    );

    worker.onmessage = (e: MessageEvent) => {
      const m = e.data as Partial<PythonWorkerMessage> | null;
      if (!m || typeof m !== "object") return;
      if (m.type === "blocked") {
        if (blocked.length >= MAX_PYTHON_REPORTS) return;
        const api = cap((m as { api?: unknown }).api, 80);
        const target = cap((m as { target?: unknown }).target, 500);
        blocked.push({ api, target });
        recordBlockedRequest(ledgerUrl(target), "research", `${LEDGER_REASON} (${api})`);
      } else if (m.type === "ready") {
        // The time limit counts the agent's code, not the interpreter's boot.
        // Once: the code can post messages too (js.postMessage), and a
        // second "ready" must not restart the clock.
        if (codeRunning) return;
        codeRunning = true;
        clearTimeout(timer);
        timer = setTimeout(
          () => finish(() => resolve(empty({ timedOut: true, error: `Timed out after ${opts.timeoutMs} ms: the run was stopped (an endless loop, or too much work for the limit)` }))),
          opts.timeoutMs,
        );
      } else if (m.type === "done") {
        const d = m as Extract<PythonWorkerMessage, { type: "done" }>;
        const stdout = cap(d.stdout);
        const stderr = cap(d.stderr, Math.max(64, OUTPUT_BOUND - stdout.length));
        const result: PythonResultValue =
          typeof d.result === "string" ? cap(d.result) : typeof d.result === "number" || typeof d.result === "boolean" ? d.result : null;
        const error = typeof d.error === "string" ? cap(d.error, 4100) : null;
        finish(() => resolve(empty({ ok: error === null, stdout, stderr, result, error, truncated: d.truncated === true })));
      } else if (m.type === "fatal") {
        const message = cap((m as { message?: unknown }).message, 2000);
        finish(() => reject(new ToolError("failed", `The Python runtime (Pyodide) did not start: ${message}`)));
      }
    };
    worker.onerror = (e: ErrorEvent) => {
      const message = e.message || "worker error";
      finish(() => reject(new ToolError("failed", `The Python worker failed: ${message}`)));
    };
    worker.postMessage({ type: "run", code: opts.code, inputsJson: opts.inputsJson });
  });
}
