/**
 * `run_python` (plan 6.14) — run a short Python program on this device, on
 * the self-hosted Pyodide the live-python block uses, and read back what it
 * printed, its last value or its error. Scope `read`: it changes nothing
 * and reaches nothing — no network (every way out of the sandbox fails and
 * is recorded in the privacy ledger), no workspace, no DOM. A note the code
 * needs is passed in `inputs`. The worker and the runtime load on the
 * first call (`../python/runner`), never at startup.
 */

import { defineTool, optionalNumber, requireString, ToolError } from "./define";
import {
  DEFAULT_PYTHON_TIMEOUT_MS,
  MAX_PYTHON_CODE_CHARS,
  MAX_PYTHON_INPUT_BYTES,
  MAX_PYTHON_TIMEOUT_MS,
  MIN_PYTHON_TIMEOUT_MS,
} from "../python/limits";
import type { PythonRunResult } from "../python/runner";

export const runPythonTool = defineTool<{ code?: string; inputs?: Record<string, unknown>; timeoutMs?: number }, PythonRunResult>({
  name: "run_python",
  description:
    "Run Python 3 (standard library only) offline on this device: returns stdout, the last expression's value and any error. " +
    "No network, no workspace files, no package installs: pass the data in `inputs` (the code reads it as the dict `inputs`).",
  parameters: {
    type: "object",
    properties: {
      code: { type: "string", minLength: 1, maxLength: MAX_PYTHON_CODE_CHARS },
      inputs: { type: "object", description: "JSON values for the code, as `inputs`" },
      timeoutMs: { type: "integer", minimum: MIN_PYTHON_TIMEOUT_MS, maximum: MAX_PYTHON_TIMEOUT_MS },
    },
    required: ["code"],
    additionalProperties: false,
  },
  run: async (args, ctx) => {
    const code = requireString(args, "code");
    if (code.length > MAX_PYTHON_CODE_CHARS) throw new ToolError("bad-args", `"code" is longer than ${MAX_PYTHON_CODE_CHARS} characters`);
    let inputsJson = "{}";
    if (args.inputs !== undefined) {
      if (!args.inputs || typeof args.inputs !== "object" || Array.isArray(args.inputs)) throw new ToolError("bad-args", `"inputs" must be an object`);
      inputsJson = JSON.stringify(args.inputs);
      if (new TextEncoder().encode(inputsJson).length > MAX_PYTHON_INPUT_BYTES) {
        throw new ToolError("bad-args", `"inputs" is larger than ${MAX_PYTHON_INPUT_BYTES / 1000} KB`);
      }
    }
    const timeoutMs = Math.min(MAX_PYTHON_TIMEOUT_MS, Math.max(MIN_PYTHON_TIMEOUT_MS, Math.round(optionalNumber(args, "timeoutMs", DEFAULT_PYTHON_TIMEOUT_MS))));
    const { runPython } = await import("../python/runner");
    return runPython({ code, inputsJson, timeoutMs, signal: ctx.signal });
  },
});

export const PYTHON_TOOLS = [runPythonTool];
