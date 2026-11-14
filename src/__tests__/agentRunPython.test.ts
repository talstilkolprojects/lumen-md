/**
 * Plan 6.14: the `run_python` agent tool — Python on the self-hosted
 * Pyodide, offline only. Pyodide cannot load in Node, so the worker is a
 * stand-in that runs the real worker logic (`createPythonHandler`, the
 * real scope seal) around a fake interpreter. The real interpreter, its
 * computing and every network path from Python (pyfetch, js.fetch,
 * micropip, urllib) are exercised in e2e/live-exec.spec.ts.
 *
 *  - the definition: JSON Schema, registered with the other tools, scope
 *    `read` (no network grant, no consent prompt — it makes no request);
 *  - a run returns stdout, the value and errors; `inputs` reach the code;
 *  - the time limit (boot excluded), the output cap, cancellation;
 *  - network attempts fail, reach nothing and are in the privacy ledger.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import type { AgentDefinition, AgentTool, Executor, ExecutorRequest, ExecutorResponse } from "../agents/types";

const storeState = { aiKey: null as string | null, useLocalAi: false, useFineTunedModel: false, fineTunedModelId: null };
vi.mock("../store/useStore", () => ({ useAppStore: { getState: () => storeState } }));
vi.mock("../ai/ollamaProvider", () => ({ isOllamaAvailable: async () => false, getBaseUrl: () => "http://localhost:11434", chatOllama: vi.fn(), chatOllamaStream: vi.fn() }));
vi.mock("../ai/localLlm", () => ({ localLlmAvailable: () => ({ available: false }), chatLocal: vi.fn(), chatLocalStream: vi.fn(), onLocalLlmProgress: () => () => {} }));
vi.mock("../store/useToastStore", () => ({ toast: { info: vi.fn(), warn: vi.fn(), error: vi.fn() } }));
vi.mock("../ui/PromptDialog", () => ({ uiConfirm: vi.fn(async () => false) }));
vi.mock("../billing/aiQuota", () => ({ chargeAiCommandDispatch: vi.fn(), consumeAiPrompt: vi.fn(() => true), aiQuotaStatus: () => ({ allowed: true, limit: Infinity }), AiQuotaExceededError: class extends Error {} }));
vi.mock("../storage/workspace", () => ({ isOPFSAvailable: () => true, listWorkspace: async () => [], readWorkspaceFile: async () => "", writeWorkspaceFile: async () => {}, workspaceHasFile: async () => false, isAssetName: () => false }));
vi.mock("../storage/workspaceIndex", () => ({ searchWorkspace: async () => [], ensureIndex: async () => {}, indexedFiles: () => [] }));

import { ALL_TOOLS, getTool, pickTools } from "../agents/tools";
import { runPythonTool } from "../agents/tools/python";
import { validateSchema } from "../agents/schema";
import { runAgent } from "../agents/runtime";
import { registerExecutor, resetExecutors } from "../agents/executors";
import { clearTrace } from "../agents/trace";
import { LEDGER_REASON, setPythonWorkerFactory, type PythonRunResult, type PythonWorkerLike } from "../agents/python/runner";
import { createPythonHandler, OutputBudget, type PyodideLike } from "../agents/python/handler";
import { cleanPythonError, NETWORK_GLOBALS, SANDBOX_PRELUDE, sealPyodideApi, sealPythonWorkerScope } from "../agents/python/sandbox";
import { MAX_PYTHON_INPUT_BYTES, MAX_PYTHON_OUTPUT_CHARS } from "../agents/python/limits";
import { __resetLedger, ledgerEntries } from "../ai/privacyLedger";
import { setAiPolicy } from "../ai/policy";

/* ── A worker stand-in around the real worker logic ── */

interface Env {
  print: (line: string) => void;
  printErr: (line: string) => void;
  inputs: Record<string, unknown>;
  /** The worker scope after the seal: what Python's `js` module would see. */
  js: Record<string, unknown>;
  /** The reporter the prelude imports (`_lumen_sandbox.report`), as Python's stubs call it. */
  report: (api: string, target: string) => void;
  /** `js.postMessage`: the code can post to the page like the worker does. */
  post: (data: unknown) => void;
}
type Behaviour = (code: string, env: Env) => unknown | Promise<unknown>;

/** What the worker scope's real network APIs would have done: never called. */
const scopeNetwork = vi.fn(async () => new Response("LEAK"));

interface FakeWorker extends PythonWorkerLike {
  terminated: boolean;
}

function fakeWorker(behaviour: Behaviour, opts: { bootMs?: number; bootError?: string } = {}): FakeWorker {
  const proto = { fetch: scopeNetwork, XMLHttpRequest: class { constructor() { void scopeNetwork(); } } };
  const scope = Object.assign(Object.create(proto) as Record<string, unknown>, {
    WebSocket: class { constructor() { void scopeNetwork(); } },
    importScripts: () => void scopeNetwork(),
    indexedDB: { open: () => scopeNetwork() },
    navigator: { storage: { getDirectory: () => scopeNetwork() }, storageBuckets: { open: () => scopeNetwork() }, serial: { requestPort: () => scopeNetwork() }, usb: { getDevices: () => scopeNetwork() }, hid: { getDevices: () => scopeNetwork() } },
    eval: () => scopeNetwork(),
    setTimeout: globalThis.setTimeout,
    Function,
  });
  let stdout: (s: string) => void = () => {};
  let stderr: (s: string) => void = () => {};
  let sandboxModule: { report: (api: unknown, target: unknown) => void } | null = null;
  const globals = new Map<string, unknown>();
  const py: PyodideLike & { loadPackage: () => Promise<unknown> } = {
    globals: { set: (k, v) => void globals.set(k, v) },
    setStdout: (o) => void (stdout = o.batched),
    setStderr: (o) => void (stderr = o.batched),
    registerJsModule: (_name, mod) => void (sandboxModule = mod as typeof sandboxModule),
    unregisterJsModule: () => {},
    loadPackage: async () => scopeNetwork(),
    async runPythonAsync(code: string) {
      if (code.includes("def _lumen_seal") || code.includes("__lumen_json")) return undefined;
      return behaviour(code, {
        print: (l) => stdout(l),
        printErr: (l) => stderr(l),
        inputs: JSON.parse(String(globals.get("__lumen_inputs_json"))) as Record<string, unknown>,
        js: scope,
        report: (api, target) => sandboxModule!.report(api, target),
        post: (data) => {
          if (!w.terminated) w.onmessage?.({ data } as MessageEvent);
        },
      });
    },
  };
  const w: FakeWorker = {
    onmessage: null,
    onerror: null,
    terminated: false,
    terminate() {
      w.terminated = true;
    },
    postMessage(msg) {
      void Promise.resolve().then(() => handle(msg));
    },
  };
  const handle = createPythonHandler({
    loadPyodide: () =>
      new Promise<PyodideLike>((resolve, reject) => {
        const go = () => (opts.bootError ? reject(new Error(opts.bootError)) : resolve(py));
        if (opts.bootMs) setTimeout(go, opts.bootMs);
        else go();
      }),
    seal: (report) => sealPythonWorkerScope(scope, report),
    post: (data) => {
      if (!w.terminated) w.onmessage?.({ data } as MessageEvent);
    },
  });
  return w;
}

let workers: FakeWorker[] = [];
function useBehaviour(behaviour: Behaviour, opts?: { bootMs?: number; bootError?: string }) {
  setPythonWorkerFactory(() => {
    const w = fakeWorker(behaviour, opts);
    workers.push(w);
    return w;
  });
}

const pageFetch = vi.fn(async () => new Response("LEAK"));
const ctx = (signal?: AbortSignal) => ({ grants: new Set(["read" as const]), signal });
const run = (args: Record<string, unknown>, signal?: AbortSignal) => (runPythonTool as unknown as AgentTool).run(args, ctx(signal)) as Promise<PythonRunResult>;

beforeEach(() => {
  workers = [];
  scopeNetwork.mockClear();
  pageFetch.mockClear();
  __resetLedger();
  localStorage.clear();
  vi.stubGlobal("fetch", pageFetch);
});
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  setPythonWorkerFactory();
  setAiPolicy("local-first");
});

describe("run_python: the definition", () => {
  it("is registered with the other tools, with a JSON Schema and the read scope", () => {
    expect(getTool("run_python")).toBe(runPythonTool);
    expect(ALL_TOOLS.filter((t) => t.name === "run_python")).toHaveLength(1);
    expect(pickTools("run_python")[0].scope).toBe("read");
    // Not a network tool: no grant, no consent, nothing for the gate to open.
    expect(ALL_TOOLS.filter((t) => t.scope === "network").map((t) => t.name).sort()).toEqual(["fetch_page", "search_web"]);
    const p = runPythonTool.parameters;
    expect(p).toMatchObject({ type: "object", required: ["code"], additionalProperties: false });
    expect(validateSchema({ code: "print(1)", inputs: { text: "שלום", n: [1, 2] }, timeoutMs: 2000 }, p)).toEqual([]);
    expect(validateSchema({}, p).length).toBeGreaterThan(0);
    expect(validateSchema({ code: "" }, p).length).toBeGreaterThan(0);
    expect(validateSchema({ code: "1", inputs: [1] }, p).length).toBeGreaterThan(0);
    expect(validateSchema({ code: "1", timeoutMs: 999_999 }, p).length).toBeGreaterThan(0);
    expect(validateSchema({ code: "1", path: "notes/a.md" }, p).length).toBeGreaterThan(0);
  });

  it("refuses inputs that are not an object or are too large, before starting a worker", async () => {
    useBehaviour(() => 1);
    await expect(run({ code: "1", inputs: [1] })).rejects.toMatchObject({ code: "bad-args" });
    await expect(run({ code: "1", inputs: { big: "x".repeat(MAX_PYTHON_INPUT_BYTES) } })).rejects.toMatchObject({ code: "bad-args" });
    await expect(run({ code: "  " })).rejects.toMatchObject({ code: "bad-args" });
    expect(workers).toHaveLength(0);
  });

  it("runs inside an agent run with no grant and asks no network consent", async () => {
    setAiPolicy("local-only");
    useBehaviour((_code, env) => {
      env.print("4957");
      return 42;
    });
    const consent = vi.fn(() => true);
    let seen: unknown;
    const calls: ExecutorRequest[] = [];
    const executor: Executor = {
      id: "ollama",
      label: "fake",
      available: async () => ({ available: true }),
      supportsTools: () => false,
      supportsSchema: () => false,
      modelFor: (tier) => `fake-${tier}`,
      async chat(req): Promise<ExecutorResponse> {
        calls.push(req);
        if (calls.length === 1) return { content: JSON.stringify({ tool: "run_python", args: { code: "print(sum(range(100)) + 7)\n42" } }), toolCalls: [], model: "fake" };
        seen = JSON.parse(req.messages[req.messages.length - 1].content);
        return { content: JSON.stringify({ final: "done" }), toolCalls: [], model: "fake" };
      },
    };
    resetExecutors();
    await clearTrace();
    registerExecutor(executor);
    const def: AgentDefinition = { id: "py", description: "test", system: "sys", user: () => "go", tools: pickTools("run_python"), requires: [], language: "any", maxRetries: 0 };
    const r = await runAgent(def, {}, { consentNetwork: consent });
    expect(r.status).toBe("ok");
    expect(seen).toMatchObject({ tool: "run_python", result: { ok: true, stdout: "4957\n", result: 42 } });
    expect(consent).not.toHaveBeenCalled();
    expect(ledgerEntries()).toEqual([]);
    expect(pageFetch).not.toHaveBeenCalled();
    resetExecutors();
  });
});

describe("run_python: a run", () => {
  it("returns stdout, stderr and the last value; inputs reach the code; one worker per call, terminated after", async () => {
    useBehaviour((code, env) => {
      const xs = env.inputs.xs as number[];
      env.print(`sum=${xs.reduce((a, b) => a + b, 0)}`);
      env.printErr("warning: demo");
      return code.length;
    });
    const a = await run({ code: "print(...)", inputs: { xs: [4, 41, 9] } });
    expect(a).toMatchObject({ ok: true, stdout: "sum=54\n", stderr: "warning: demo\n", result: 10, error: null, timedOut: false, truncated: false, blocked: [] });
    await run({ code: "again" });
    expect(workers).toHaveLength(2);
    expect(workers.every((w) => w.terminated)).toBe(true);
  });

  it("returns a Python exception as the result, with Pyodide's own frames dropped", async () => {
    useBehaviour(() => {
      throw new Error(
        [
          "Traceback (most recent call last):",
          '  File "/lib/python314.zip/_pyodide/_base.py", line 597, in eval_code_async',
          "    await CodeRunner(",
          "    ^^^^^^^^^^^",
          '  File "<exec>", line 2, in <module>',
          "    1/0",
          "ZeroDivisionError: division by zero",
        ].join("\n"),
      );
    });
    const r = await run({ code: "1/0" });
    expect(r.ok).toBe(false);
    expect(r.error).toBe('Traceback (most recent call last):\n  File "<exec>", line 2, in <module>\n    1/0\nZeroDivisionError: division by zero');
    expect(cleanPythonError("")).toBe("Python error");
  });

  it("stops code that runs past the time limit (the interpreter's boot does not count)", async () => {
    vi.useFakeTimers();
    useBehaviour(() => new Promise(() => {}), { bootMs: 5_000 });
    const p = run({ code: "while True: pass", timeoutMs: 500 });
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(5_000); // booting
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(499);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    const r = await p;
    expect(r).toMatchObject({ ok: false, timedOut: true, result: null });
    expect(r.error).toMatch(/Timed out after 500 ms/);
    expect(workers[0].terminated).toBe(true);
  });

  it("a second ready message from the code does not restart the time limit", async () => {
    vi.useFakeTimers();
    useBehaviour(async (_c, env) => {
      // Code that posts {type: "ready"} before each deadline must still be stopped.
      for (;;) {
        await new Promise((r) => setTimeout(r, 400));
        env.post({ type: "ready" });
      }
    });
    const p = run({ code: "while True: post_ready()", timeoutMs: 1000 });
    let settled = false;
    void p.then(() => (settled = true));
    await vi.advanceTimersByTimeAsync(999);
    expect(settled).toBe(false);
    await vi.advanceTimersByTimeAsync(2);
    expect(await p).toMatchObject({ timedOut: true });
  });

  it("caps the output (stdout + stderr + value share one budget)", async () => {
    useBehaviour((_c, env) => {
      for (let i = 0; i < 5_000; i++) env.print("0123456789");
      env.printErr("never shown");
      return "a long value";
    });
    const r = await run({ code: "for i in range(5000): print('0123456789')" });
    expect(r.truncated).toBe(true);
    expect(r.stdout.length).toBeLessThanOrEqual(MAX_PYTHON_OUTPUT_CHARS + 30);
    expect(r.stdout.endsWith("… output truncated")).toBe(true);
    expect(r.stderr).toBe("");
    expect(r.result).toBe("… (truncated)");
    const b = new OutputBudget(10);
    expect(b.take("12345")).toBe("12345");
    expect(b.take("123456")).toBe("12345");
    expect(b.take("x")).toBeNull();
  });

  it("is cancelled with the run: the worker is terminated and the call rejects with AbortError", async () => {
    useBehaviour(() => new Promise(() => {}));
    const ctrl = new AbortController();
    const p = run({ code: "while True: pass" }, ctrl.signal);
    await vi.waitFor(() => expect(workers).toHaveLength(1));
    ctrl.abort();
    await expect(p).rejects.toMatchObject({ name: "AbortError" });
    expect(workers[0].terminated).toBe(true);
  });

  it("fails as a tool error when the interpreter does not start", async () => {
    useBehaviour(() => 1, { bootError: "pyodide.asm.wasm: 404" });
    await expect(run({ code: "1" })).rejects.toMatchObject({ code: "failed", message: expect.stringContaining("pyodide.asm.wasm: 404") });
  });
});

describe("run_python: no network", () => {
  it("every network attempt fails, reaches nothing and is recorded in the privacy ledger", async () => {
    useBehaviour(async (_code, env) => {
      const outcome: string[] = [];
      const attempt = async (name: string, f: () => unknown) => {
        try {
          await f();
          outcome.push(`${name}:LEAKED`);
        } catch {
          outcome.push(`${name}:blocked`);
        }
      };
      const js = env.js as Record<string, (...a: unknown[]) => unknown> & { navigator: Record<string, unknown> };
      // js.fetch / js.XMLHttpRequest / js.WebSocket / js.importScripts from Python.
      await attempt("js.fetch", () => js.fetch("https://example.com/js-fetch?q=secret"));
      await attempt("proto.fetch", () => (Object.getPrototypeOf(js) as { fetch?: () => unknown }).fetch!());
      await attempt("xhr", () => new (js.XMLHttpRequest as unknown as new () => unknown)());
      await attempt("ws", () => new (js.WebSocket as unknown as new (u: string) => unknown)("wss://example.com/ws"));
      await attempt("importScripts", () => js.importScripts("https://example.com/x.js"));
      await attempt("eval", () => js.eval("fetch('https://example.com/eval')"));
      await attempt("Function", () => (js.Function as unknown as (s: string) => unknown)("return 1"));
      await attempt("vault", () => (js.indexedDB as unknown as { open: () => unknown }).open());
      await attempt("opfs", () => (js.navigator.storage as { getDirectory: () => unknown }).getDirectory());
      await attempt("buckets", () => (js.navigator.storageBuckets as { open: () => unknown }).open());
      await attempt("serial", () => (js.navigator.serial as { requestPort: () => unknown }).requestPort());
      await attempt("usb", () => (js.navigator.usb as { getDevices: () => unknown }).getDevices());
      await attempt("hid", () => (js.navigator.hid as { getDevices: () => unknown }).getDevices());
      // What the prelude's Python stubs do for pyfetch / micropip / urllib before raising.
      env.report("pyodide.http.pyfetch", "https://example.com/pyfetch");
      env.report("micropip.install", "https://example.com/pkg.whl");
      env.report("python:urllib.Request", "https://example.com/urllib");
      return outcome.join(",");
    });
    const r = await run({ code: "probe" });
    expect(r.ok).toBe(true);
    expect(String(r.result).split(",")).toEqual([
      "js.fetch:blocked",
      "proto.fetch:blocked",
      "xhr:blocked",
      "ws:blocked",
      "importScripts:blocked",
      "eval:blocked",
      "Function:blocked",
      "vault:blocked",
      "opfs:blocked",
      "buckets:blocked",
      "serial:blocked",
      "usb:blocked",
      "hid:blocked",
    ]);
    expect(scopeNetwork).not.toHaveBeenCalled();
    expect(pageFetch).not.toHaveBeenCalled();
    expect(r.blocked.map((b) => b.api)).toEqual(["fetch", "XMLHttpRequest", "WebSocket", "importScripts", "eval", "Function", "pyodide.http.pyfetch", "micropip.install", "python:urllib.Request"]);
    const blocked = ledgerEntries().filter((e) => e.reason.startsWith(LEDGER_REASON));
    expect(blocked).toHaveLength(r.blocked.length);
    expect(blocked.every((e) => e.decision === "blocked" && e.bytesOut === 0)).toBe(true);
    // The ledger keeps the host, never the query string; attempts without a URL get a host that cannot exist.
    expect(new Set(blocked.map((e) => e.host))).toEqual(new Set(["example.com", "python-sandbox.invalid"]));
    expect(JSON.stringify(ledgerEntries())).not.toContain("secret");
  });

  it("caps the reports a run can push into the ledger", async () => {
    useBehaviour(async (_c, env) => {
      for (let i = 0; i < 100; i++) await (env.js.fetch as (u: string) => Promise<unknown>)(`https://example.com/${i}`).catch(() => { /* why: every request is blocked on purpose; the test counts the ledger entries */ });
      return null;
    });
    const r = await run({ code: "spam" });
    expect(r.blocked).toHaveLength(20);
    expect(ledgerEntries().length).toBe(20);
  });

  it("the seal: stubs every network global, on the prototypes too, and cannot be undone", () => {
    const reports: string[] = [];
    const scope = Object.assign(Object.create({ fetch: scopeNetwork }) as Record<string, unknown>, { WebSocket: class {}, Function, setTimeout: vi.fn() });
    sealPythonWorkerScope(scope, (api) => reports.push(api));
    for (const name of NETWORK_GLOBALS) expect(typeof scope[name], name).toBe("function");
    expect(Object.getPrototypeOf(scope).fetch).toBeUndefined();
    expect(() => {
      scope.fetch = scopeNetwork;
    }).toThrow(TypeError);
    expect(() => (scope.setTimeout as (h: string) => void)("fetch('x')")).toThrow(EvalError);
    (scope.setTimeout as (h: () => void, ms: number) => void)(() => {}, 0);
    // A stand-in scope leaves this realm's Function alone; the guard still reads as Function.
    expect(Function.prototype.constructor).toBe(Function);
    expect((() => {}) instanceof (scope.Function as FunctionConstructor)).toBe(true);
    expect(reports).toEqual(["setTimeout"]);
    const api = { loadPackage: async () => scopeNetwork(), loadPackagesFromImports: async () => scopeNetwork() };
    sealPyodideApi(api, (a) => reports.push(a));
    return expect(api.loadPackage()).rejects.toThrow(/blocked/).then(() => {
      expect(scopeNetwork).not.toHaveBeenCalled();
      expect(reports).toContain("pyodide.loadPackage");
    });
  });

  it("the Python prelude closes pyfetch, open_url, pyxhr, run_js, micropip, sockets and urllib", () => {
    for (const s of ['"pyfetch", "open_url"', "pyxhr", "run_js", 'sys.modules["micropip"]', "sys.addaudithook(hook)", '"urllib.Request"', '"socket.connect"', '"socket.getaddrinfo"', "raise PermissionError(msg)", "del _lumen_seal"]) {
      expect(SANDBOX_PRELUDE, s).toContain(s);
    }
  });
});
