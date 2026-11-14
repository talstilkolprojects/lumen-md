/**
 * Lumen plugin test kit (plan W3.10): run a plugin's `main.js` in Node
 * against a mock of the `lumen` API, with the same rules as the app's
 * QuickJS sandbox — the same method table, capabilities denied unless
 * granted (a call without its grant rejects with a `PluginDenied` error),
 * JSON-only arguments, events and command handlers — and look at what it
 * did: the calls it made, the panel it rendered, the text it wrote.
 *
 *   import { loadPlugin } from "./tools/testkit.mjs";
 *   const p = await loadPlugin({ dir: "." , document: { text: "# Hi" } });
 *   await p.run("show");                 // run a command it registered
 *   assert.equal(p.panel.tree.type, "box");
 *
 * Zero dependencies. The plugin runs in a fresh `vm` context: no fetch,
 * no require, no process — like the sandbox, only `lumen` and `console`.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import vm from "node:vm";

/** `<namespace>.<method>` → the capability it needs (the app's METHOD_CAPABILITY; a test keeps them equal). */
export const METHODS = {
  "document.getText": "document:read",
  "document.getFileName": "document:read",
  "document.getSelection": "document:read",
  "document.setText": "document:write",
  "document.insertText": "document:write",
  "document.replaceSelection": "document:write",
  "vault.list": "vault:read",
  "vault.read": "vault:read",
  "vault.write": "vault:write",
  "commands.register": "commands",
  "commands.unregister": "commands",
  "panel.open": "panel",
  "panel.close": "panel",
  "panel.render": "panel",
  "renderer.register": "renderer",
  "renderer.result": "renderer",
  "settings.get": "settings",
  "settings.set": "settings",
  "storage.get": "storage",
  "storage.set": "storage",
  "storage.delete": "storage",
  "clipboard.writeText": "clipboard:write",
  "notifications.show": "notifications",
  "network.fetch": "network",
  "bases.query": "bases:read",
  "bases.update": "bases:write",
};

export class PluginDenied extends Error {
  constructor(capability, message) {
    super(message ?? `${capability} was not granted`);
    this.name = "PluginDenied";
    this.capability = capability;
  }
}

const granted = (grants, cap, args) => {
  if (cap !== "network") return grants.has(cap);
  try {
    return grants.has(`network:${new URL(String(args[0])).origin}`);
  } catch {
    return false;
  }
};

/**
 * Load a plugin. `dir` (with lumen-plugin.json) or `manifest` + `code`.
 * `grants`: "all" (default: every capability the manifest asks for) or a list.
 * Mock state: `document` { text, fileName, selection: [from, to] }, `vault` { "folder/note.md": text },
 * `settings`, `storage`, `fetch(url, init)` for granted network calls.
 * `engine` (optional): what runs the code. The default is a fresh Node `vm` context. An engine is
 * `async ({ manifest, code, grants, call, log }) => ({ dispatch(name, payload), denied?, dispose() })`:
 * it runs `code` with a `lumen` object whose calls go to `call(method, args)` and returns how to
 * deliver events. Lumen's own tests pass the app's QuickJS sandbox here, so the same cases run in
 * the real engine (src/__tests__/helpers/quickjsEngine.ts).
 */
export async function loadPlugin(opts = {}) {
  const manifest = opts.manifest ?? JSON.parse(readFileSync(join(opts.dir, "lumen-plugin.json"), "utf8"));
  const code = opts.code ?? readFileSync(join(opts.dir, manifest.main ?? "main.js"), "utf8");
  const asked = (manifest.capabilities ?? []).map((c) => c.id);
  const grants = new Set(opts.grants === undefined || opts.grants === "all" ? asked : opts.grants.filter((g) => asked.includes(g)));

  const doc = { text: opts.document?.text ?? "", fileName: opts.document?.fileName ?? "Untitled.md", selection: opts.document?.selection ?? [0, 0] };
  const vault = new Map(Object.entries(opts.vault ?? {}));
  let settings = structuredClone(opts.settings ?? {});
  const storage = new Map(Object.entries(opts.storage ?? {}));
  const state = { commands: new Map(), renderers: new Set(), panel: { open: false, title: null, tree: null }, rendered: [], notifications: [], clipboard: null, logs: [], calls: [], denied: new Map(), basesUpdates: [] };
  const handlers = new Map();
  const renders = new Map();
  let renderSeq = 0;
  const json = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
  const sel = () => doc.text.slice(doc.selection[0], doc.selection[1]);

  const services = {
    "document.getText": () => doc.text,
    "document.getFileName": () => doc.fileName,
    "document.getSelection": () => ({ from: doc.selection[0], to: doc.selection[1], text: sel() }),
    "document.setText": (t) => void ((doc.text = String(t)), (doc.selection = [0, 0])),
    "document.insertText": (t) => {
      const at = doc.selection[1];
      doc.text = doc.text.slice(0, at) + String(t) + doc.text.slice(at);
      doc.selection = [at + String(t).length, at + String(t).length];
    },
    "document.replaceSelection": (t) => {
      const [a, b] = doc.selection;
      doc.text = doc.text.slice(0, a) + String(t) + doc.text.slice(b);
      doc.selection = [a, a + String(t).length];
    },
    // Like the app: the entries directly inside `dir` ("" = the vault root), dot files hidden.
    "vault.list": (dir) => {
      const base = dir ? `${String(dir).replace(/^\/+|\/+$/g, "")}/` : "";
      const out = new Map();
      for (const p of [...vault.keys()].sort()) {
        if (!p.startsWith(base)) continue;
        const [name, ...rest] = p.slice(base.length).split("/");
        if (!name || name.startsWith(".")) continue;
        out.set(name, { name, path: base + name, kind: rest.length ? "dir" : "file" });
      }
      return [...out.values()];
    },
    "vault.read": (p) => {
      if (!vault.has(p)) throw new Error(`no such note: ${p}`);
      return vault.get(p);
    },
    "vault.write": (p, t) => {
      if (!/\.(md|markdown|txt|json|csv)$/i.test(String(p))) throw new RangeError("plugins write .md, .txt, .json or .csv files only");
      vault.set(String(p), String(t));
    },
    "commands.register": (c) => void state.commands.set(c.id, c),
    "commands.unregister": (id) => void state.commands.delete(id),
    "panel.open": (o) => void Object.assign(state.panel, { open: true, title: o?.title ?? null }),
    "panel.close": () => void (state.panel.open = false),
    "panel.render": (tree) => {
      if (!state.panel.open) throw new Error("open the panel first (panel.open)");
      state.panel.tree = tree;
      state.rendered.push(tree);
    },
    "renderer.register": (lang) => void state.renderers.add(String(lang).toLowerCase()),
    "renderer.result": (requestId, tree) => {
      const done = renders.get(requestId);
      if (!done) throw new Error("no such render request (it may have timed out)");
      renders.delete(requestId);
      done(tree);
    },
    "settings.get": () => settings,
    "settings.set": (s) => void (settings = { ...settings, ...s }),
    "storage.get": (k) => storage.get(k) ?? null,
    "storage.set": (k, v) => void storage.set(k, v),
    "storage.delete": (k) => void storage.delete(k),
    "clipboard.writeText": (t) => void (state.clipboard = String(t)),
    "notifications.show": (text, kind) => void state.notifications.push({ text: String(text), kind: kind === "error" || kind === "success" ? kind : "info" }),
    "network.fetch": (url, init) => {
      if (!opts.fetch) throw new Error("no fetch mock: pass opts.fetch");
      return opts.fetch(url, init);
    },
    // The Bases API (W6.46): pass opts.bases(path, view) for query; update records the edits and answers
    // the approval with opts.approve (default yes), as the app's one approval screen per call does.
    "bases.query": (path, view, page) => {
      if (!opts.bases) throw new Error("no bases mock: pass opts.bases");
      return opts.bases(path, view, page);
    },
    "bases.update": (edits) => {
      if (!Array.isArray(edits)) throw new TypeError("edits: a list of { path, set }");
      state.basesUpdates.push(edits);
      if (opts.approve === false) return { written: 0, unchanged: 0, declined: true };
      return { written: edits.length, unchanged: 0, declined: false };
    },
  };

  const call = async (method, args) => {
    const cap = METHODS[method];
    if (!cap) throw new Error(`no such method: ${method}`);
    let a;
    try {
      a = JSON.parse(JSON.stringify(args));
    } catch {
      throw new Error("arguments must be JSON-serialisable");
    }
    if (!granted(grants, cap, a)) {
      const key = cap === "network" ? `network:${String(a[0])}` : cap;
      state.denied.set(key, (state.denied.get(key) ?? 0) + 1);
      state.calls.push({ method, args: a, outcome: "denied" });
      throw new PluginDenied(key);
    }
    state.calls.push({ method, args: a, outcome: "ok" });
    return json(await services[method](...a));
  };

  const lumen = Object.create(null);
  for (const m of Object.keys(METHODS)) {
    const [ns, fn] = m.split(".");
    lumen[ns] ??= Object.create(null);
    lumen[ns][fn] = (...args) => call(m, args);
  }
  lumen.on = (name, handler) => {
    if (typeof handler !== "function") throw new TypeError("handler must be a function");
    handlers.set(name, [...(handlers.get(name) ?? []), handler]);
    return () => handlers.set(name, (handlers.get(name) ?? []).filter((h) => h !== handler));
  };
  lumen.commands.register = (cmd, handler) => {
    if (handler) lumen.on(`command:${cmd.id}`, handler);
    return call("commands.register", [cmd]);
  };
  lumen.manifest = Object.freeze(JSON.parse(JSON.stringify(manifest)));
  for (const ns of Object.keys(lumen)) if (typeof lumen[ns] === "object") Object.freeze(lumen[ns]);
  Object.freeze(lumen);

  const fmt = (args) => args.map((a) => (typeof a === "string" ? a : JSON.stringify(a))).join(" ");
  const consoleMock = Object.freeze(Object.fromEntries(["log", "info", "debug", "warn", "error"].map((k) => [k, (...a) => state.logs.push({ level: k === "warn" || k === "error" ? k : "log", text: fmt(a) })])));

  let engine = null;
  if (opts.engine) {
    const log = (level, text) => void state.logs.push({ level: level === "warn" || level === "error" ? level : "log", text: String(text) });
    engine = await opts.engine({ manifest, code, grants: [...grants], call, log });
  } else {
    // A fresh context: the plugin sees only lumen and console (and the language's own built-ins).
    const context = vm.createContext({ lumen, console: consoleMock });
    const fn = vm.runInContext(`(async function () { "use strict";\n${code}\n})`, context, { filename: manifest.main ?? "main.js" });
    await fn();
  }

  const emit = async (name, payload) => {
    if (engine) return engine.dispatch(name, json(payload));
    const list = handlers.get(name) ?? [];
    await Promise.all(list.map((h) => Promise.resolve().then(() => h(json(payload)))));
  };

  return {
    manifest,
    grants,
    document: doc,
    vault,
    get settings() {
      return settings;
    },
    storage,
    commands: state.commands,
    renderers: state.renderers,
    panel: state.panel,
    rendered: state.rendered,
    notifications: state.notifications,
    get clipboard() {
      return state.clipboard;
    },
    logs: state.logs,
    calls: state.calls,
    /** Refused calls by capability (an engine that checks grants itself reports its own count). */
    denied: engine?.denied ?? state.denied,
    /** Stop the plugin (an engine frees what it holds). */
    dispose() {
      engine?.dispose();
    },
    /** Run a command the plugin registered (its handler gets `payload`). */
    async run(id, payload = {}) {
      if (!state.commands.has(id)) throw new Error(`the plugin registered no command "${id}" (it has: ${[...state.commands.keys()].join(", ") || "none"})`);
      await emit(`command:${id}`, payload);
    },
    /** Deliver an event: "ui:panel" { id, kind, value }, "panel:closed", "render:<lang>" …. */
    emit,
    /** Render a code block of a language the plugin registered: its UI tree (as the app would get it). */
    async render(lang, source) {
      if (!state.renderers.has(lang)) throw new Error(`the plugin registered no renderer for \`${lang}\``);
      const requestId = `r${++renderSeq}`;
      const tree = new Promise((resolve) => renders.set(requestId, resolve));
      await emit(`render:${lang}`, { requestId, source });
      let timer;
      const timeout = new Promise((_, reject) => (timer = setTimeout(() => reject(new Error("the plugin did not answer the render within 5 s")), 5000)));
      try {
        return await Promise.race([tree, timeout]);
      } finally {
        clearTimeout(timer);
      }
    },
    /** Put the cursor or a selection in the mock document. */
    select(from, to = from) {
      doc.selection = [from, to];
    },
  };
}
