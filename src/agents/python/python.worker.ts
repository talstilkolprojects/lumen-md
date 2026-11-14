/**
 * The `run_python` worker: one call, one worker. Boots the self-hosted
 * Pyodide (public/pyodide/, staged by scripts/copy-pyodide.mjs — the same
 * runtime the live-python block uses), seals itself, runs the code and is
 * terminated by the page. Pyodide only supports module workers.
 */
import { createPythonHandler, type PyodideLike } from "./handler";
import { sealPythonWorkerScope } from "./sandbox";

const post = self.postMessage.bind(self);

async function loadPyodide(): Promise<PyodideLike> {
  const index = new URL(`${import.meta.env.BASE_URL.replace(/\/?$/, "/")}pyodide/`, self.location.href).href;
  // An absolute URL in a variable, imported at run time: the file is a
  // static asset of public/, not a module of the bundle (Vite leaves an
  // absolute specifier alone in dev, and the build keeps the import).
  const url = index + "pyodide.mjs";
  const mod = (await import(/* @vite-ignore */ url)) as {
    loadPyodide: (opts: { indexURL: string }) => Promise<PyodideLike>;
  };
  // python_stdlib.zip (most of the standard library) comes with the core;
  // the modules Pyodide ships as separate packages (ssl, sqlite3, lzma, …)
  // would need loadPackage, i.e. the network, and are not available.
  return mod.loadPyodide({ indexURL: index });
}

const handle = createPythonHandler({
  loadPyodide,
  seal: (report) => sealPythonWorkerScope(self, report),
  post: (msg) => post(msg),
});

self.addEventListener("message", (e: MessageEvent) => {
  void handle(e.data);
});
