/**
 * Plugin System — minimal extensibility API for Lumen IDE.
 *
 * Plugins register via `registerPlugin()` and can:
 * - Add commands to the command palette
 * - Add toolbar buttons
 * - Hook into document lifecycle events (open, save, change)
 * - Register custom markdown block renderers
 *
 * PLUGIN AUTHORS — initialization lifecycle (ADR-001):
 *   Block plugins that imperatively render into a ref-attached DOM
 *   element via an external library (echarts, abcjs, model-viewer,
 *   leaflet, ...) MUST defer init until the host has nonzero size.
 *   The renderer mounts blocks lazily through React.lazy + Suspense,
 *   so `clientWidth`/`clientHeight` can be 0 at first effect.
 *   Reference implementation: src/plugins/EChart.tsx's `ensureChart`
 *   closure — guard with `clientWidth === 0 || clientHeight === 0`,
 *   then re-attempt init from a ResizeObserver callback. Sibling
 *   pattern for async-loaded sources: `useFetchSource` in
 *   src/plugins/useFetchSource.ts.
 */

import { countWords } from "../text/hebrew";
import { log } from "../lib/logger";

export interface LumenCommand {
  id: string;
  label: string;
  hint?: string;
  icon?: string;
  shortcut?: string;
  action: () => void;
}

export interface LumenPlugin {
  id: string;
  name: string;
  version: string;
  description?: string;
  author?: string;

  /** Called when the plugin is activated */
  activate?: (api: LumenPluginAPI) => void | Promise<void>;
  /** Called when the plugin is deactivated */
  deactivate?: () => void;
}

export interface LumenPluginAPI {
  /** Register a command in the command palette */
  registerCommand: (cmd: LumenCommand) => void;
  /** Remove a previously registered command */
  unregisterCommand: (id: string) => void;
  /** Get the current document content */
  getContent: () => string;
  /** Set the current document content */
  setContent: (content: string) => void;
  /** Get the current document filename */
  getFileName: () => string;
  /** Subscribe to document changes */
  onContentChange: (handler: (content: string) => void) => () => void;
  /** Subscribe to save events */
  onSave: (handler: (content: string) => void) => () => void;
  /** Show a toast notification */
  showToast: (message: string, type?: "info" | "success" | "error") => void;
}

// ── Plugin Registry ─────────────────────────────────────────────────────────

const plugins = new Map<string, { plugin: LumenPlugin; active: boolean }>();
const pluginCommands = new Map<string, LumenCommand[]>();
const changeHandlers = new Map<string, ((content: string) => void)[]>();
const saveHandlers = new Map<string, ((content: string) => void)[]>();

/** Get the current plugin API (wired up lazily by App.tsx) */
let _getContent: () => string = () => "";
let _setContent: (s: string) => void = () => {};
let _getFileName: () => string = () => "Untitled.md";
let _showToast: (msg: string) => void = () => {};

export function wirePluginAPI(opts: {
  getContent: () => string;
  setContent: (s: string) => void;
  getFileName: () => string;
  showToast: (msg: string) => void;
}) {
  _getContent = opts.getContent;
  _setContent = opts.setContent;
  _getFileName = opts.getFileName;
  _showToast = opts.showToast;
}

function createAPI(pluginId: string): LumenPluginAPI {
  return {
    registerCommand: (cmd) => {
      const list = pluginCommands.get(pluginId) ?? [];
      list.push(cmd);
      pluginCommands.set(pluginId, list);
    },
    unregisterCommand: (id) => {
      const list = pluginCommands.get(pluginId) ?? [];
      pluginCommands.set(pluginId, list.filter((c) => c.id !== id));
    },
    getContent: () => _getContent(),
    setContent: (s) => _setContent(s),
    getFileName: () => _getFileName(),
    onContentChange: (handler) => {
      const list = changeHandlers.get(pluginId) ?? [];
      list.push(handler);
      changeHandlers.set(pluginId, list);
      return () => {
        const updated = changeHandlers.get(pluginId) ?? [];
        changeHandlers.set(pluginId, updated.filter((h) => h !== handler));
      };
    },
    onSave: (handler) => {
      const list = saveHandlers.get(pluginId) ?? [];
      list.push(handler);
      saveHandlers.set(pluginId, list);
      return () => {
        const updated = saveHandlers.get(pluginId) ?? [];
        saveHandlers.set(pluginId, updated.filter((h) => h !== handler));
      };
    },
    showToast: (msg, _type) => _showToast(msg),
  };
}

/** Register and activate a plugin */
export async function registerPlugin(plugin: LumenPlugin): Promise<void> {
  if (plugins.has(plugin.id)) {
    log.warn(`plugin "${plugin.id}" already registered`);
    return;
  }
  plugins.set(plugin.id, { plugin, active: false });
  
  if (plugin.activate) {
    const api = createAPI(plugin.id);
    await plugin.activate(api);
  }
  plugins.get(plugin.id)!.active = true;
}

/** Deactivate and remove a plugin */
export function unregisterPlugin(pluginId: string): void {
  const entry = plugins.get(pluginId);
  if (!entry) return;
  
  entry.plugin.deactivate?.();
  pluginCommands.delete(pluginId);
  changeHandlers.delete(pluginId);
  saveHandlers.delete(pluginId);
  plugins.delete(pluginId);
}

/** Commands of a sandboxed plugin (plan 11.2): kept with the built-in plugins' commands, under its id. */
export function setSandboxedPluginCommands(pluginId: string, cmds: LumenCommand[]): void {
  if (cmds.length) pluginCommands.set(pluginId, cmds);
  else pluginCommands.delete(pluginId);
}

/** Get all commands from all active plugins */
export function getPluginCommands(): LumenCommand[] {
  return Array.from(pluginCommands.values()).flat();
}

/** Notify all plugins of a content change */
export function notifyContentChange(content: string): void {
  for (const handlers of changeHandlers.values()) {
    for (const h of handlers) h(content);
  }
}

/** Notify all plugins of a save event */
export function notifySave(content: string): void {
  for (const handlers of saveHandlers.values()) {
    for (const h of handlers) h(content);
  }
}

/** Get list of all registered plugins */
export function getRegisteredPlugins(): { id: string; name: string; version: string; active: boolean }[] {
  return Array.from(plugins.entries()).map(([id, e]) => ({
    id,
    name: e.plugin.name,
    version: e.plugin.version,
    active: e.active,
  }));
}

// ── Built-in Example Plugin: Word Count ─────────────────────────────────────

export const wordCountPlugin: LumenPlugin = {
  id: "lumen.word-count",
  name: "Word Counter",
  version: "1.0.0",
  description: "Shows word count in the command palette",
  author: "Lumen Team",
  activate: (api) => {
    api.registerCommand({
      id: "plugin.wordCount",
      label: "Word Count",
      hint: "Show detailed word statistics",
      action: () => {
        const content = api.getContent();
        const words = countWords(content);
        const chars = content.length;
        const lines = content.split("\n").length;
        const sentences = content.split(/[.!?]+/).filter(Boolean).length;
        api.showToast(`📊 ${words} words, ${chars} chars, ${lines} lines, ${sentences} sentences`);
      },
    });
  },
};
