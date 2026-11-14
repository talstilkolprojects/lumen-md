/**
 * Live Lua runtime — the message protocol and execution logic shared by the
 * Web Worker (`lua.worker.ts`) and the unit tests. It never touches the DOM:
 * the worker wires `post` to `self.postMessage` and `loadFactory` to a
 * wasmoon `LuaFactory` pointed at the self-hosted `glue.wasm`.
 *
 * Sandboxing (defense in depth — the worker itself is the real boundary):
 *  - a fresh Lua state per run; nothing leaks between runs or blocks;
 *  - `injectObjects: false` / `enableProxy: false`, so Lua can't reach JS
 *    objects; the only JS function Lua sees is the output sink, which is
 *    captured into a local and removed from globals before user code runs;
 *  - process/file escapes (`os.exit`, `os.execute`, `io.popen`, `io.open`,
 *    `dofile`, `loadfile`, `require`, `package`, …) are nil'd;
 *  - an instruction-count hook aborts runaway loops after `timeoutMs`, and
 *    the page additionally terminates the worker if it stops answering.
 */

export interface LuaRunRequest {
  type: "run";
  runId: number;
  source: string;
  timeoutMs: number;
}

export type LuaWorkerMessage =
  | { type: "output"; runId: number; text: string }
  | { type: "result"; runId: number; text: string }
  | { type: "error"; runId: number; message: string }
  | { type: "done"; runId: number; ms: number };

/** The subset of wasmoon's API this runtime relies on. */
export interface LuaThreadLike {
  loadString(code: string, name?: string): void;
  run(argCount?: number, options?: { timeout?: number }): Promise<unknown[]>;
}
export interface LuaEngineLike {
  global: {
    set(name: string, value: unknown): void;
    newThread(): LuaThreadLike;
    close(): void;
    setMemoryMax?(max: number | undefined): void;
  };
  doString(code: string): Promise<unknown>;
}
export interface LuaFactoryLike {
  createEngine(options?: {
    openStandardLibs?: boolean;
    injectObjects?: boolean;
    enableProxy?: boolean;
    traceAllocations?: boolean;
  }): Promise<LuaEngineLike>;
}

export const DEFAULT_LUA_TIMEOUT_MS = 5000;
/** Cap on the Lua heap per run (bytes). */
export const LUA_MEMORY_MAX = 64 * 1024 * 1024;
/** Cap on captured output per run (characters) so a print loop can't OOM the page. */
export const MAX_OUTPUT_CHARS = 200_000;

/**
 * Lua prelude: replaces `print` / `io.write` with versions that route through
 * the captured sink, and strips process/file escapes. Runs before user code.
 */
export const LUA_PRELUDE = `
local emit = __lumen_emit
__lumen_emit = nil
local select, tostring, concat = select, tostring, table.concat
local function join(sep, ...)
  local n = select("#", ...)
  local parts = {}
  for i = 1, n do parts[i] = tostring((select(i, ...))) end
  return concat(parts, sep)
end
print = function(...) emit(join("\\t", ...) .. "\\n") end
if io then
  io.write = function(...) emit(join("", ...)) return io end
  io.read = function() return nil end
  io.popen, io.open, io.lines, io.input, io.output = nil, nil, nil, nil, nil
end
if os then
  os.exit, os.execute, os.remove, os.rename, os.tmpname, os.getenv = nil, nil, nil, nil, nil, nil
end
dofile, loadfile, require, package = nil, nil, nil, nil
`;

function formatValue(v: unknown): string {
  if (v === null || v === undefined) return "nil";
  if (typeof v === "string") return JSON.stringify(v);
  if (typeof v === "number" || typeof v === "boolean") return String(v);
  if (typeof v === "function") return "function";
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Build the worker's message handler. One call per worker; each `run`
 * message gets a fresh Lua state.
 */
export function createLuaHandler(deps: {
  loadFactory: () => Promise<LuaFactoryLike>;
  post: (msg: LuaWorkerMessage) => void;
  now?: () => number;
}): (msg: unknown) => Promise<void> {
  const now = deps.now ?? (() => Date.now());
  return async (raw) => {
    const msg = raw as Partial<LuaRunRequest> | null;
    if (!msg || msg.type !== "run" || typeof msg.runId !== "number") return;
    const runId = msg.runId;
    const source = String(msg.source ?? "");
    const timeoutMs = Number(msg.timeoutMs) > 0 ? Number(msg.timeoutMs) : DEFAULT_LUA_TIMEOUT_MS;
    const started = now();

    let emitted = 0;
    let truncated = false;
    const emit = (text: unknown) => {
      if (truncated) return;
      let s = String(text ?? "");
      if (emitted + s.length > MAX_OUTPUT_CHARS) {
        s = s.slice(0, Math.max(0, MAX_OUTPUT_CHARS - emitted)) + "\n… output truncated\n";
        truncated = true;
      }
      emitted += s.length;
      if (s) deps.post({ type: "output", runId, text: s });
    };

    let engine: LuaEngineLike | null = null;
    try {
      const factory = await deps.loadFactory();
      // traceAllocations is required for the heap cap (setMemoryMax).
      engine = await factory.createEngine({
        openStandardLibs: true,
        injectObjects: false,
        enableProxy: false,
        traceAllocations: true,
      });
      engine.global.setMemoryMax?.(LUA_MEMORY_MAX);
      engine.global.set("__lumen_emit", emit);
      await engine.doString(LUA_PRELUDE);

      const thread = engine.global.newThread();
      // Chunk name "=block" makes error positions read "block:3: …".
      thread.loadString(source, "=block");
      const results = await thread.run(0, { timeout: timeoutMs });
      const values = Array.from(results ?? []);
      if (values.length) {
        deps.post({ type: "result", runId, text: values.map(formatValue).join(", ") });
      }
    } catch (err) {
      const message = errorMessage(err);
      deps.post({
        type: "error",
        runId,
        message: /timeout/i.test(message) ? `Execution timed out after ${timeoutMs} ms` : message,
      });
    } finally {
      try {
        engine?.global.close();
      } catch {
        /* why: already closed */
      }
      deps.post({ type: "done", runId, ms: now() - started });
    }
  };
}
