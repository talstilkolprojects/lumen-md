/**
 * Limits of the `run_python` agent tool (plan 6.14). Kept apart from the
 * runner so the tool definition, which is part of the startup bundle,
 * pulls in nothing else: the worker and Pyodide load on the first call.
 */

/** Wall-clock time the code may run, once the interpreter is up. */
export const DEFAULT_PYTHON_TIMEOUT_MS = 10_000;
export const MIN_PYTHON_TIMEOUT_MS = 100;
export const MAX_PYTHON_TIMEOUT_MS = 30_000;
/** Booting Pyodide (≈10 MB, same-origin) on a cold, slow machine. */
export const PYTHON_BOOT_TIMEOUT_MS = 120_000;
/** stdout + stderr + the result, together (characters): what a model can read back. */
export const MAX_PYTHON_OUTPUT_CHARS = 20_000;
export const MAX_PYTHON_CODE_CHARS = 20_000;
/** `inputs`, serialised as JSON (UTF-8 bytes). */
export const MAX_PYTHON_INPUT_BYTES = 64_000;
/** Blocked network attempts reported (and recorded in the ledger) per call. */
export const MAX_PYTHON_REPORTS = 20;

export const PYTHON_NETWORK_OFF = "Network access is off in Lumen's Python sandbox: run_python runs offline. Pass the data in `inputs` instead.";
