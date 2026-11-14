/**
 * Code-block languages that plugins render (plan 11.2). A tiny, dependency-
 * free set the markdown pipeline consults on the startup path; the plugin
 * runtime itself (manager.ts, PluginBlock.tsx) loads lazily.
 */

const langs = new Map<string, string>(); // lang → plugin id
const listeners = new Set<() => void>();

/** Plugin languages: 2–31 chars, lower-case letters, digits and dashes, starting with a letter. */
export const PLUGIN_LANG_RE = /^[a-z][a-z0-9-]{1,30}$/;

export function pluginForLang(lang: string): string | undefined {
  return langs.get(lang);
}

export function registerPluginLang(lang: string, pluginId: string): void {
  langs.set(lang, pluginId);
  for (const f of [...listeners]) f();
}

export function unregisterPluginLangs(pluginId: string): void {
  let changed = false;
  for (const [lang, id] of langs) if (id === pluginId) changed = langs.delete(lang) || changed;
  if (changed) for (const f of [...listeners]) f();
}

/** The preview re-renders when the set changes (a plugin loaded or unloaded). */
export function subscribePluginLangs(fn: () => void): () => void {
  listeners.add(fn);
  return () => void listeners.delete(fn);
}

export function pluginLangsVersion(): string {
  return [...langs.keys()].sort().join(",");
}
