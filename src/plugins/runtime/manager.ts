/**
 * Plugin manager (plan 11.2.1): the running sandboxed plugins and the app
 * services they reach through their grants — the open note, the vault,
 * commands, a side panel, code-block renderers, settings, storage,
 * clipboard and toasts. Lazy: loaded only when a plugin is installed.
 *
 * Every service validates its arguments (the plugin is untrusted even
 * after the capability check) and is scoped to the calling plugin: its
 * own commands, its own panel, its own settings and storage namespace.
 */
import { get as idbGet, set as idbSet, del as idbDel } from "idb-keyval";
import { useAppStore } from "../../store/useStore";
import { getVaultBackend } from "../../storage/vault";
import { showAiToast } from "../../ui/AiToast";
import { setSandboxedPluginCommands, type LumenCommand } from "../pluginSystem";
import { PLUGIN_LANG_RE, pluginForLang, registerPluginLang, unregisterPluginLangs } from "./rendererRegistry";
import { loadPlugin, type HostServices, type PluginInstance } from "./pluginHost";
import type { Grants } from "./capabilities";
import type { PluginManifest } from "./manifest";
import type { UiNode } from "./uiTree";

export const LIMITS = {
  commandsPerPlugin: 50,
  renderersPerPlugin: 10,
  settingsBytes: 64 * 1024,
  storageValueBytes: 1024 * 1024,
  storageKeys: 1000,
  vaultReadBytes: 5 * 1024 * 1024,
  vaultWriteBytes: 5 * 1024 * 1024,
  toastChars: 300,
  clipboardChars: 1024 * 1024,
  renderTimeoutMs: 5000,
};

/** Languages Lumen renders itself; a plugin cannot take them over. */
const RESERVED_LANGS = new Set(["mermaid", "chart", "csv", "tsv", "math", "latex", "html", "js", "javascript", "ts", "typescript", "python", "json", "sql", "md", "markdown", "dataview", "query", "embed"]);

export interface PanelState {
  pluginId: string;
  title: string;
  tree: UiNode | null;
}

interface Running {
  instance: PluginInstance;
  commands: LumenCommand[];
  langs: Set<string>;
  renders: Map<string, (tree: UiNode) => void>;
}

const running = new Map<string, Running>();
let panel: PanelState | null = null;
const panelListeners = new Set<() => void>();
let renderSeq = 0;

function setPanel(next: PanelState | null): void {
  panel = next;
  for (const f of [...panelListeners]) f();
}

export function getPanel(): PanelState | null {
  return panel;
}

export function subscribePanel(fn: () => void): () => void {
  panelListeners.add(fn);
  return () => void panelListeners.delete(fn);
}

/** The user closed the panel: hide it and tell the plugin (event "panel:closed"). */
export function closePanelByUser(pluginId: string): void {
  if (panel?.pluginId === pluginId) setPanel(null);
  running.get(pluginId)?.instance.emit("panel:closed");
}

export function runningPlugins(): PluginInstance[] {
  return [...running.values()].map((r) => r.instance);
}

const str = (v: unknown, what: string, max: number): string => {
  if (typeof v !== "string") throw new TypeError(`${what} must be a string`);
  if (v.length > max) throw new RangeError(`${what} is longer than ${max} characters`);
  return v;
};

/** A vault path a plugin may name: relative, no `..`, no dot-folders (app data such as .trash, .lumen). */
export function pluginVaultPath(v: unknown): string {
  const p = str(v, "path", 500).replace(/\\/g, "/");
  if (!p || p.startsWith("/") || /(^|\/)\.\.?(\/|$)/.test(p) || /(^|\/)\./.test(p)) throw new RangeError("path must be a note path inside the vault (no '..', no hidden folders)");
  return p;
}

const settingsKey = (id: string) => `lumen.plugin.settings.${id}`;
const storageKey = (id: string, key: string) => `lumen-plugin:${id}:${key}`;

/** The app's services, by method. Exported for tests (they run the real services against the store). */
export function appServices(): HostServices {
  const r = (p: PluginInstance) => {
    const x = running.get(p.id);
    if (!x) throw new Error("plugin is not running");
    return x;
  };
  return {
    "document.getText": () => useAppStore.getState().doc.content,
    "document.getFileName": () => useAppStore.getState().doc.name,
    "document.getSelection": () => {
      const detail: { result?: { from: number; to: number; text: string } | null } = {};
      window.dispatchEvent(new CustomEvent("lumen-editor-selection", { detail }));
      return detail.result ?? null;
    },
    "document.setText": (_p, text) => void useAppStore.getState().setContent(str(text, "text", 10 * 1024 * 1024)),
    "document.insertText": (_p, text) => insertAtCursor(str(text, "text", 1024 * 1024)),
    "document.replaceSelection": (_p, text) => insertAtCursor(str(text, "text", 1024 * 1024)),

    "vault.list": async (_p, dir) => {
      const d = dir === undefined || dir === "" ? "" : pluginVaultPath(dir);
      const entries = await getVaultBackend().list(d);
      return entries.filter((e) => !e.name.startsWith(".")).map((e) => ({ name: e.name, path: e.path, kind: e.kind }));
    },
    "vault.read": async (_p, path) => {
      const text = await getVaultBackend().readText(pluginVaultPath(path));
      if (text.length > LIMITS.vaultReadBytes) throw new RangeError("note is too large for a plugin");
      return text;
    },
    "vault.write": async (_p, path, text) => {
      const p = pluginVaultPath(path);
      if (!/\.(md|markdown|txt|json|csv)$/i.test(p)) throw new RangeError("plugins write .md, .txt, .json or .csv files only");
      await getVaultBackend().write(p, str(text, "text", LIMITS.vaultWriteBytes));
    },

    "commands.register": (p, cmd) => {
      const x = r(p);
      if (!cmd || typeof cmd !== "object") throw new TypeError("command must be { id, label, hint? }");
      const c = cmd as Record<string, unknown>;
      const id = str(c.id, "command id", 64);
      if (!/^[A-Za-z0-9_.-]+$/.test(id)) throw new RangeError("command id: letters, digits, '_', '.', '-'");
      const label = str(c.label, "command label", 80);
      const hint = c.hint === undefined ? undefined : str(c.hint, "command hint", 200);
      if (x.commands.length >= LIMITS.commandsPerPlugin && !x.commands.some((k) => k.id === `plugin:${p.id}:${id}`)) throw new RangeError(`at most ${LIMITS.commandsPerPlugin} commands`);
      const full: LumenCommand = { id: `plugin:${p.id}:${id}`, label: `${label} · ${p.manifest.name}`, ...(hint ? { hint } : {}), action: () => p.emit(`command:${id}`, { source: "palette" }) };
      x.commands = [...x.commands.filter((k) => k.id !== full.id), full];
      setSandboxedPluginCommands(p.id, x.commands);
    },
    "commands.unregister": (p, id) => {
      const x = r(p);
      const full = `plugin:${p.id}:${str(id, "command id", 64)}`;
      x.commands = x.commands.filter((k) => k.id !== full);
      setSandboxedPluginCommands(p.id, x.commands);
    },

    "panel.open": async (p, opts) => {
      const title = opts && typeof opts === "object" ? str((opts as Record<string, unknown>).title ?? p.manifest.name, "panel title", 80) : p.manifest.name;
      if (typeof document !== "undefined") (await import("./PluginPanel")).ensurePanelHost();
      setPanel({ pluginId: p.id, title, tree: panel?.pluginId === p.id ? panel.tree : null });
    },
    "panel.close": (p) => {
      if (panel?.pluginId === p.id) setPanel(null);
    },
    // The tree arrives validated (pluginHost.ts); only the open panel of this plugin is updated.
    "panel.render": (p, tree) => {
      if (panel?.pluginId !== p.id) throw new Error("open the panel first (panel.open)");
      setPanel({ ...panel, tree: tree as UiNode });
    },

    "renderer.register": (p, lang) => {
      const x = r(p);
      const l = str(lang, "language", 31).toLowerCase();
      if (!PLUGIN_LANG_RE.test(l)) throw new RangeError("language: 2–31 lower-case letters, digits or '-', starting with a letter");
      if (RESERVED_LANGS.has(l)) throw new RangeError(`Lumen renders \`${l}\` itself`);
      const owner = pluginForLang(l);
      if (owner && owner !== p.id) throw new RangeError(`\`${l}\` is already rendered by ${owner}`);
      if (x.langs.size >= LIMITS.renderersPerPlugin && !x.langs.has(l)) throw new RangeError(`at most ${LIMITS.renderersPerPlugin} languages`);
      x.langs.add(l);
      registerPluginLang(l, p.id);
    },
    "renderer.result": (p, requestId, tree) => {
      const id = str(requestId, "request id", 40);
      const done = r(p).renders.get(id);
      if (!done) throw new Error("no such render request (it may have timed out)");
      r(p).renders.delete(id);
      done(tree as UiNode);
    },

    "settings.get": (p) => {
      try {
        return JSON.parse(localStorage.getItem(settingsKey(p.id)) ?? "{}") as unknown;
      } catch {
        return {};
      }
    },
    "settings.set": (p, value) => {
      const json = JSON.stringify(value ?? {});
      if (json.length > LIMITS.settingsBytes) throw new RangeError(`settings are larger than ${LIMITS.settingsBytes} bytes`);
      localStorage.setItem(settingsKey(p.id), json);
    },

    "storage.get": async (p, key) => (await idbGet(storageKey(p.id, str(key, "key", 200)))) ?? null,
    "storage.set": async (p, key, value) => {
      const k = str(key, "key", 200);
      const json = JSON.stringify(value ?? null);
      if (json.length > LIMITS.storageValueBytes) throw new RangeError(`a stored value is limited to ${LIMITS.storageValueBytes} bytes`);
      const index = ((await idbGet(storageKey(p.id, "\u0000keys"))) as string[] | undefined) ?? [];
      if (!index.includes(k)) {
        if (index.length >= LIMITS.storageKeys) throw new RangeError(`at most ${LIMITS.storageKeys} keys`);
        await idbSet(storageKey(p.id, "\u0000keys"), [...index, k]);
      }
      await idbSet(storageKey(p.id, k), JSON.parse(json) as unknown);
    },
    "storage.delete": async (p, key) => {
      const k = str(key, "key", 200);
      await idbDel(storageKey(p.id, k));
      const index = ((await idbGet(storageKey(p.id, "\u0000keys"))) as string[] | undefined) ?? [];
      await idbSet(storageKey(p.id, "\u0000keys"), index.filter((x) => x !== k));
    },

    "clipboard.writeText": async (_p, text) => navigator.clipboard.writeText(str(text, "text", LIMITS.clipboardChars)),
    "notifications.show": (p, text, kind) => {
      const k = kind === "error" || kind === "success" ? kind : "info";
      showAiToast(`${p.manifest.name}: ${str(text, "text", LIMITS.toastChars)}`, k);
    },
  };
}

/** Insert at the editor's cursor (replacing the selection); without an editor, append to the note. */
function insertAtCursor(text: string): void {
  const handled = !window.dispatchEvent(new CustomEvent("lumen-plugin-insert", { detail: { text }, cancelable: true }));
  if (handled) return;
  const store = useAppStore.getState();
  store.setContent(store.doc.content + text);
}

/** Ask the plugin that renders `lang` for a UI tree of `source`. */
export function renderBlock(lang: string, source: string): Promise<UiNode> {
  const id = pluginForLang(lang);
  const x = id ? running.get(id) : undefined;
  if (!x || !x.instance.alive) return Promise.reject(new Error(`no running plugin renders \`${lang}\``));
  const requestId = `r${++renderSeq}`;
  return new Promise<UiNode>((resolve, reject) => {
    const timer = setTimeout(() => {
      x.renders.delete(requestId);
      reject(new Error("the plugin did not render in time"));
    }, LIMITS.renderTimeoutMs);
    x.renders.set(requestId, (tree) => {
      clearTimeout(timer);
      resolve(tree);
    });
    x.instance.emit(`render:${lang}`, { requestId, source: source.slice(0, 200_000) });
  });
}

/** A UI event from the panel or a rendered block, to the plugin that owns it. */
export function sendUiEvent(pluginId: string, event: { scope: "panel" | "block"; id: string; kind: "click" | "change"; value?: string | boolean }): void {
  running.get(pluginId)?.instance.emit(`ui:${event.scope}`, event);
}

export interface StartOptions {
  manifest: PluginManifest;
  code: string;
  grants: Grants;
  /** For tests. */
  createWorker?: () => Worker;
  services?: HostServices;
}

export async function startPlugin(opts: StartOptions): Promise<PluginInstance> {
  if (running.has(opts.manifest.id)) await stopPlugin(opts.manifest.id);
  const entry: Running = { instance: null as unknown as PluginInstance, commands: [], langs: new Set(), renders: new Map() };
  // Register before the load: the plugin's top-level code calls the services while it starts.
  const services = opts.services ?? appServices();
  const pending = loadPlugin({ manifest: opts.manifest, code: opts.code, grants: opts.grants, services, createWorker: opts.createWorker });
  running.set(opts.manifest.id, entry);
  try {
    entry.instance = await pending;
  } catch (e) {
    cleanup(opts.manifest.id);
    throw e;
  }
  entry.instance.onFatal((error) => {
    cleanup(opts.manifest.id);
    showAiToast(`${opts.manifest.name}: ${error}`.slice(0, 300), "error");
  });
  return entry.instance;
}

function cleanup(pluginId: string): void {
  const x = running.get(pluginId);
  running.delete(pluginId);
  setSandboxedPluginCommands(pluginId, []);
  unregisterPluginLangs(pluginId);
  if (panel?.pluginId === pluginId) setPanel(null);
  for (const done of x?.renders.values() ?? []) done({ type: "text", text: "" });
}

export async function stopPlugin(pluginId: string): Promise<void> {
  const x = running.get(pluginId);
  cleanup(pluginId);
  await x?.instance?.unload?.();
}

/** Remove what a plugin stored (on uninstall). */
export async function clearPluginData(pluginId: string): Promise<void> {
  localStorage.removeItem(settingsKey(pluginId));
  const index = ((await idbGet(storageKey(pluginId, "\u0000keys"))) as string[] | undefined) ?? [];
  for (const k of index) await idbDel(storageKey(pluginId, k));
  await idbDel(storageKey(pluginId, "\u0000keys"));
}
