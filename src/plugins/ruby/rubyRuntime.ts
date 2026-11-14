/**
 * Live Ruby runtime — the message protocol and execution logic shared by the
 * Web Worker (`ruby.worker.ts`) and the unit tests. It never touches the DOM:
 * the worker wires `post` to `self.postMessage` and `loadVm` to a ruby.wasm
 * VM instantiated from the self-hosted `/ruby/ruby+stdlib.wasm`.
 *
 * Isolation (defense in depth):
 *  - the code runs in a dedicated worker, never on the page;
 *  - a fresh Ruby VM per run (the compiled module is reused), so nothing
 *    leaks between runs or blocks;
 *  - WASI gets an empty in-memory filesystem: no host files, no sockets;
 *  - before the first VM is created the worker deletes its network and
 *    storage APIs (fetch, XHR, WebSocket, IndexedDB, Cache Storage, OPFS…),
 *    so Ruby's `JS` bridge can't reach the user's documents or the network;
 *  - the page terminates the worker on timeout (a synchronous `eval` can't
 *    be interrupted from inside).
 */

export interface RubyRunRequest {
  type: "run";
  runId: number;
  source: string;
}

export type RubyWorkerMessage =
  | { type: "ready"; runId: number }
  | { type: "output"; runId: number; stream: "out" | "err"; text: string }
  | { type: "result"; runId: number; text: string }
  | { type: "error"; runId: number; message: string }
  | { type: "done"; runId: number; ms: number };

/** The subset of ruby.wasm's RbValue this runtime relies on. */
export interface RbValueLike {
  toString(): string;
  call(method: string, ...args: RbValueLike[]): RbValueLike;
}
export interface RubyVmLike {
  eval(code: string): RbValueLike;
}
export interface RubyPrinter {
  stdout(text: string): void;
  stderr(text: string): void;
}

export const DEFAULT_RUBY_TIMEOUT_MS = 10_000;
/** Cap on captured output per run (characters) so a print loop can't OOM the page. */
export const MAX_OUTPUT_CHARS = 200_000;
/** Output messages per run (stream switches flush a batch). */
export const MAX_OUTPUT_MESSAGES = 2_000;

export const JS_DISABLED = "The JS bridge (require \"js\") is not available in Lumen's sandboxed Ruby";

/** Where the runtime is served (respects a non-root Vite base path). */
export function rubyWasmUrl(base: string = "/"): string {
  return `${base.replace(/\/?$/, "/")}ruby/ruby+stdlib.wasm`;
}

/**
 * Encode `source` as a Ruby expression that rebuilds the exact string,
 * whatever quotes, heredoc markers or `#{}` it contains. Lone surrogates
 * (not representable in UTF-8) become U+FFFD.
 */
export function rubyStringLiteral(source: string): string {
  const cps: number[] = [];
  for (const ch of source) {
    const cp = ch.codePointAt(0) ?? 0xfffd;
    cps.push(cp >= 0xd800 && cp <= 0xdfff ? 0xfffd : cp);
  }
  return cps.length ? `[${cps.join(",")}].pack("U*")` : `+""`;
}

/**
 * The Ruby program that runs one block: evaluates it at top level with the
 * file name `block` (so errors read `block:3: …`), always flushes output,
 * and returns the last value's `inspect` (nil when the value is nil).
 */
export function rubyProgram(source: string): string {
  return [
    "$stdout.sync = true",
    "$stderr.sync = true",
    // The JS bridge is off: the worker has no DOM, and its network/storage
    // APIs are gone anyway (under the production Trusted Types policy the
    // gem can't even load). Say so plainly instead of a JS stack trace.
    `Kernel.prepend(Module.new { def require(name) = name.to_s == "js" ? raise(LoadError, ${JSON.stringify(JS_DISABLED)}) : super })`,
    `->(src) {`,
    `  begin`,
    `    r = TOPLEVEL_BINDING.eval(src, "block", 1)`,
    // Results and error messages are capped inside Ruby, before they are
    // converted to JS strings and posted to the page.
    `    r.nil? ? nil : (s = r.inspect; s.length > ${MAX_OUTPUT_CHARS} ? s[0, ${MAX_OUTPUT_CHARS}] + "… (truncated)" : s)`,
    `  rescue Exception => e`,
    `    m = e.message.to_s`,
    `    raise(m.length > ${MAX_OUTPUT_CHARS} ? e.exception(m[0, ${MAX_OUTPUT_CHARS}] + "… (truncated)") : e)`,
    `  ensure`,
    `    $stdout.flush`,
    `    $stderr.flush`,
    `  end`,
    `}.call(${rubyStringLiteral(source)})`,
  ].join("\n");
}

/** Defensive cap for anything posted to the page. */
const capText = (t: string) => (t.length > MAX_OUTPUT_CHARS ? t.slice(0, MAX_OUTPUT_CHARS) + "… (truncated)" : t);

/** Clean up ruby.wasm's error text (drop the JS-side prefix). */
export function rubyErrorMessage(err: unknown): string {
  const raw = err instanceof Error ? err.message : String(err);
  const text = raw.replace(/^(?:Ruby(?:Fatal)?Error|RbError|Error):\s*/, "");
  // Drop backtrace frames that belong to the wrapper (rubyProgram), not
  // to the user's block.
  const lines = text.split("\n").filter((l, i) => i === 0 || !/^\s*(?:eval|-e):/.test(l));
  return lines.join("\n").trim() || "Ruby error";
}

/**
 * Worker globals that reach the network or the origin's storage. Deleted
 * before any Ruby code runs: Ruby's `JS` bridge could otherwise read the
 * user's IndexedDB documents or exfiltrate them.
 */
export const BLOCKED_WORKER_GLOBALS = [
  "fetch",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "indexedDB",
  "IDBFactory",
  "caches",
  "CacheStorage",
  "cookieStore",
  "importScripts",
  "BroadcastChannel",
  "Worker",
  "SharedWorker",
  "FileSystemHandle",
  "FileSystemDirectoryHandle",
] as const;
const BLOCKED_NAVIGATOR_PROPS = ["storage", "locks", "serviceWorker", "sendBeacon"] as const;

function deleteEverywhere(obj: object | null, name: string): void {
  // Remove the property from the object and every prototype that defines
  // it, so it can't be recovered through `Object.getPrototypeOf(...)`.
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    if (Object.prototype.hasOwnProperty.call(o, name)) {
      try {
        delete (o as Record<string, unknown>)[name];
      } catch {
        /* why: non-configurable */
      }
      if (Object.prototype.hasOwnProperty.call(o, name)) {
        try {
          Object.defineProperty(o, name, { value: undefined, configurable: false, writable: false });
        } catch {
          /* why: a frozen global stays as the engine made it */
        }
      }
    }
  }
}

/** Strip network/storage APIs from a worker global scope (see above). */
export function hardenWorkerScope(scope: object): void {
  const nav = (scope as { navigator?: object }).navigator ?? null;
  for (const name of BLOCKED_NAVIGATOR_PROPS) deleteEverywhere(nav, name);
  for (const name of BLOCKED_WORKER_GLOBALS) deleteEverywhere(scope, name);
}

/**
 * Build the worker's message handler. One call per worker; each `run`
 * message gets a fresh Ruby VM from `loadVm`.
 */
export function createRubyHandler(deps: {
  loadVm: (printer: RubyPrinter) => Promise<RubyVmLike>;
  post: (msg: RubyWorkerMessage) => void;
  now?: () => number;
}): (msg: unknown) => Promise<void> {
  const now = deps.now ?? (() => Date.now());
  return async (raw) => {
    const msg = raw as Partial<RubyRunRequest> | null;
    if (!msg || msg.type !== "run" || typeof msg.runId !== "number") return;
    const runId = msg.runId;
    const source = String(msg.source ?? "");
    const started = now();

    let emitted = 0;
    let truncated = false;
    let pending: { stream: "out" | "err"; text: string } | null = null;
    // Messages are capped too: code alternating stdout / stderr one
    // character at a time would otherwise post one message per switch.
    let messages = 0;
    const flush = () => {
      if (pending) {
        messages++;
        if (messages <= MAX_OUTPUT_MESSAGES) deps.post({ type: "output", runId, stream: pending.stream, text: pending.text });
        else if (messages === MAX_OUTPUT_MESSAGES + 1) deps.post({ type: "output", runId, stream: "err", text: "\n… output truncated (too many writes)\n" });
      }
      pending = null;
    };
    const emit = (stream: "out" | "err") => (text: unknown) => {
      if (truncated) return;
      let s = String(text ?? "");
      if (emitted + s.length > MAX_OUTPUT_CHARS) {
        s = s.slice(0, Math.max(0, MAX_OUTPUT_CHARS - emitted)) + "\n… output truncated\n";
        truncated = true;
      }
      emitted += s.length;
      if (!s) return;
      // Many short writes (a loop printing one char) are batched: one
      // message per stream switch or per 8 KB, not one per write.
      if (pending && pending.stream !== stream) flush();
      pending = pending ? { stream, text: pending.text + s } : { stream, text: s };
      if (pending.text.length >= 8192) flush();
    };

    try {
      const vm = await deps.loadVm({ stdout: emit("out"), stderr: emit("err") });
      deps.post({ type: "ready", runId });
      const res = vm.eval(rubyProgram(source));
      flush();
      if (res.call("nil?").toString() !== "true") {
        // Already capped inside Ruby; it also shares the run's output
        // budget with stdout / stderr.
        let text = capText(res.toString());
        const left = Math.max(0, MAX_OUTPUT_CHARS - emitted);
        if (truncated || left === 0) text = "… (truncated)";
        else if (text.length > left) text = text.slice(0, left) + "… (truncated)";
        deps.post({ type: "result", runId, text });
      }
    } catch (err) {
      flush();
      deps.post({ type: "error", runId, message: capText(rubyErrorMessage(err)) });
    } finally {
      flush();
      deps.post({ type: "done", runId, ms: now() - started });
    }
  };
}
