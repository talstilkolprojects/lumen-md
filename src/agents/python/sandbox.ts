/**
 * The `run_python` sandbox (plan 6.14): what the Pyodide worker does to
 * itself after the interpreter booted and before any agent code runs.
 *
 * Python reaches JavaScript through the `js` module (the worker's global
 * scope), so the walls are built on the JS side, where Python cannot take
 * them down, and repeated on the Python side, where the error is clearer:
 *
 *  - network APIs (fetch, XHR, WebSocket, EventSource, importScripts,
 *    nested workers, …) are replaced by stubs that report the attempt and
 *    fail — on the scope itself and on every prototype that defines them,
 *    so `Object.getPrototypeOf(self).fetch` is gone too;
 *  - storage APIs (IndexedDB, Cache Storage, OPFS through
 *    `navigator.storage`, BroadcastChannel) are removed: the vault is not
 *    reachable, if the agent needs a note it passes the text in; so are
 *    the device APIs (`navigator.serial`, `usb`, `hid`, …);
 *  - JS code from strings (`eval`, the Function constructors, string
 *    timers) is refused, so no new code can rebuild a way out;
 *  - in Python an audit hook refuses sockets and `urllib` requests, and
 *    `pyodide.http` (pyfetch, open_url, pyxhr), `pyodide.code.run_js`
 *    and `micropip` are stubs that fail.
 *
 * Every refusal is reported to the page, which records it in the privacy
 * ledger. The worker is created for one call and terminated after it.
 */

import { PYTHON_NETWORK_OFF } from "./limits";

export type SandboxReport = (api: string, target: string) => void;

/** Worker globals that make requests. Replaced by stubs that report and fail. */
export const NETWORK_GLOBALS = [
  "fetch",
  "fetchLater",
  "XMLHttpRequest",
  "WebSocket",
  "WebSocketStream",
  "WebTransport",
  "EventSource",
  "importScripts",
  "Worker",
  "SharedWorker",
  "FontFace",
] as const;

/** Worker globals that reach the origin's storage (the vault) or other tabs. Removed. */
export const STORAGE_GLOBALS = [
  "indexedDB",
  "IDBFactory",
  "caches",
  "CacheStorage",
  "cookieStore",
  "BroadcastChannel",
  "StorageBucketManager",
  "FileSystemHandle",
  "FileSystemDirectoryHandle",
  "FileSystemFileHandle",
  "FileSystemSyncAccessHandle",
  "fonts",
] as const;

/**
 * Navigator members that reach storage, other contexts or devices. A worker
 * can see Web Serial / WebUSB / WebHID devices the user already authorised
 * for the app; agent code must not read from or write to them.
 */
export const NAVIGATOR_PROPS = ["storage", "locks", "serviceWorker", "sendBeacon", "storageBuckets", "serial", "usb", "hid", "bluetooth", "geolocation", "mediaDevices", "xr"] as const;

/** The first argument as a URL string, when it is one (for the report). */
export function requestTarget(args: readonly unknown[]): string {
  const a = args[0];
  try {
    if (typeof a === "string") return a.slice(0, 500);
    if (a && typeof a === "object") {
      const u = (a as { url?: unknown }).url ?? (a as { href?: unknown }).href;
      if (typeof u === "string") return u.slice(0, 500);
    }
  } catch {
    /* why: a hostile getter: no target */
  }
  return "";
}

function removeEverywhere(obj: object | null, name: string): void {
  for (let o = obj; o && o !== Object.prototype; o = Object.getPrototypeOf(o) as object | null) {
    if (!Object.prototype.hasOwnProperty.call(o, name)) continue;
    try {
      delete (o as Record<string, unknown>)[name];
    } catch {
      /* why: non-configurable */
    }
    if (Object.prototype.hasOwnProperty.call(o, name)) pin(o, name, undefined);
  }
}

function pin(obj: object, name: string, value: unknown): void {
  try {
    Object.defineProperty(obj, name, { value, writable: false, configurable: false, enumerable: false });
  } catch {
    /* why: already pinned by the platform */
  }
}

function networkStub(name: string, report: SandboxReport): (...args: unknown[]) => never | Promise<never> {
  return function blocked(...args: unknown[]) {
    report(name, requestTarget(args));
    const err = new TypeError(`${name} is blocked. ${PYTHON_NETWORK_OFF}`);
    if (name === "fetch" || name === "fetchLater") return Promise.reject(err);
    throw err;
  };
}

/**
 * A stand-in for a Function constructor: everything about it reads as the
 * real one (`instanceof Function`, `Function.prototype.apply`, `.name` —
 * Pyodide's own calls go through these), but calling or constructing it,
 * i.e. compiling a string, fails.
 */
function refuseCompile<F extends object>(real: F, name: string, report: SandboxReport): F {
  const refuse = () => {
    report(name, "");
    throw new EvalError(`${name} from a string is blocked in Lumen's Python sandbox`);
  };
  return new Proxy(real, { apply: refuse, construct: refuse });
}

/**
 * Seal a worker scope (see the file comment). `scope` is the worker's
 * `self`; tests pass a stand-in. The Function intrinsics are only touched
 * when `scope` is this realm's global.
 */
export function sealPythonWorkerScope(scope: object, report: SandboxReport): void {
  const s = scope as Record<string, unknown>;
  const nav = (s.navigator as object | undefined) ?? null;
  for (const name of NAVIGATOR_PROPS) removeEverywhere(nav, name);
  for (const name of STORAGE_GLOBALS) removeEverywhere(scope, name);
  for (const name of NETWORK_GLOBALS) {
    removeEverywhere(scope, name);
    pin(scope, name, networkStub(name, report));
  }

  // Code from strings: eval, string timers, the Function constructors.
  removeEverywhere(scope, "eval");
  pin(scope, "eval", function evalBlocked() {
    report("eval", "");
    throw new EvalError("eval is blocked in Lumen's Python sandbox");
  });
  for (const name of ["setTimeout", "setInterval"] as const) {
    const orig = s[name];
    if (typeof orig !== "function") continue;
    removeEverywhere(scope, name);
    pin(scope, name, function timer(handler: unknown, ...rest: unknown[]) {
      if (typeof handler !== "function") {
        report(name, "");
        throw new EvalError(`${name} with a string is blocked in Lumen's Python sandbox`);
      }
      return (orig as (...a: unknown[]) => unknown).call(scope, handler, ...rest);
    });
  }
  if (typeof s.Function === "function") {
    const F = s.Function as FunctionConstructor;
    const guarded = refuseCompile(F, "Function", report);
    if (scope === globalThis) {
      // Every route to a compiler: the global and `fn.constructor` for
      // plain, async, generator and async generator functions.
      const intrinsics: Array<[object, string]> = [
        [F.prototype, "Function"],
        [Object.getPrototypeOf(async function () {}) as object, "AsyncFunction"],
        [Object.getPrototypeOf(function* () {}) as object, "GeneratorFunction"],
        [Object.getPrototypeOf(async function* () {}) as object, "AsyncGeneratorFunction"],
      ];
      for (const [proto, name] of intrinsics) {
        const ctor = (proto as { constructor?: unknown }).constructor;
        if (typeof ctor === "function") pin(proto, "constructor", proto === F.prototype ? guarded : refuseCompile(ctor, name, report));
      }
    }
    removeEverywhere(scope, "Function");
    pin(scope, "Function", guarded);
  }
}

/**
 * Pyodide API methods that fetch: `pyodide_js.loadPackage(...)` from
 * Python must fail like a fetch does, not try the network.
 */
export const PYODIDE_NETWORK_METHODS = ["loadPackage", "loadPackagesFromImports", "mountNativeFS", "mountNodeFS"] as const;

export function sealPyodideApi(api: object, report: SandboxReport): void {
  for (const name of PYODIDE_NETWORK_METHODS) {
    if (!(name in api)) continue;
    const stub = function blocked(...args: unknown[]) {
      report(`pyodide.${name}`, requestTarget(args));
      return Promise.reject(new TypeError(`pyodide.${name} is blocked. ${PYTHON_NETWORK_OFF}`));
    };
    try {
      Object.defineProperty(api, name, { value: stub, writable: false, configurable: false });
    } catch {
      try {
        (api as Record<string, unknown>)[name] = stub;
      } catch {
        /* why: frozen API object: the global fetch stub still stops it */
      }
    }
  }
}

/** The JS module the prelude imports its reporter from. */
export const SANDBOX_MODULE = "_lumen_sandbox";

/**
 * Runs once, in its own function scope (nothing the agent's code can
 * rebind), before the agent's code. An audit hook cannot be removed.
 */
export const SANDBOX_PRELUDE = `
def _lumen_seal():
    import sys, types
    from ${SANDBOX_MODULE} import report
    msg = ${JSON.stringify(PYTHON_NETWORK_OFF)}
    events = frozenset({"socket.connect", "socket.sendto", "socket.sendmsg", "socket.bind", "socket.getaddrinfo", "socket.gethostbyname", "socket.gethostbyaddr", "urllib.Request"})

    def target_of(event, args):
        try:
            if event == "urllib.Request" or event.startswith("socket.geth") or event == "socket.getaddrinfo":
                return str(args[0])[:300]
            addr = args[1]
            return str(addr[0] if isinstance(addr, tuple) else addr)[:300]
        except Exception:
            return ""

    def hook(event, args):
        if event in events:
            report("python:" + event, target_of(event, args))
            raise PermissionError(msg)

    sys.addaudithook(hook)

    def stub(name):
        def blocked(*args, **kwargs):
            report(name, str(args[0])[:300] if args else "")
            raise PermissionError(msg)
        blocked.__name__ = name.rsplit(".", 1)[-1]
        return blocked

    micropip = types.ModuleType("micropip", "Installing packages needs the network, which is off in this sandbox.")
    micropip.install = stub("micropip.install")
    micropip.uninstall = stub("micropip.uninstall")
    sys.modules["micropip"] = micropip

    import pyodide.http as http
    for name in ("pyfetch", "open_url"):
        if hasattr(http, name):
            setattr(http, name, stub("pyodide.http." + name))
    try:
        import pyodide.http.pyxhr as pyxhr
        for name in ("get", "post", "put", "delete", "head", "patch", "options"):
            if hasattr(pyxhr, name):
                setattr(pyxhr, name, stub("pyodide.http.pyxhr." + name))
    except ImportError:
        pass
    import pyodide.code as code
    if hasattr(code, "run_js"):
        code.run_js = stub("pyodide.code.run_js")
    sys.modules.pop("${SANDBOX_MODULE}", None)

_lumen_seal()
del _lumen_seal
`;

/** Bind the call's `inputs` (JSON text in `__lumen_inputs_json`) to the name `inputs`. */
export const INPUTS_PRELUDE = `
import json as __lumen_json
inputs = __lumen_json.loads(__lumen_inputs_json)
del __lumen_json, __lumen_inputs_json
`;

/**
 * Pyodide's traceback starts with its own frames (`/lib/python…/_pyodide/
 * _base.py` running the code); the model needs the frames of its code.
 */
export function cleanPythonError(message: string): string {
  const out: string[] = [];
  let skipping = false;
  for (const line of message.split("\n")) {
    const frame = /^\s{2}File "([^"]*)"/.exec(line);
    if (frame) {
      skipping = frame[1].startsWith("/lib/");
      if (!skipping) out.push(line);
      continue;
    }
    if (skipping && /^\s{4}/.test(line)) continue;
    skipping = false;
    out.push(line);
  }
  return out.join("\n").trim() || "Python error";
}
