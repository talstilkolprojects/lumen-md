/**
 * Keyboard shortcuts written Mac-style (⌘K, ⇧⌘F, ⌥⌘I) read wrong on Windows
 * and Linux, where the same bindings are Ctrl+K, Ctrl+Shift+F, Ctrl+Alt+I.
 * `platformKeys` rewrites them for the current OS; on a Mac it is a no-op.
 */

let cachedMac: boolean | null = null;

export function isMacPlatform(): boolean {
  if (cachedMac !== null) return cachedMac;
  if (typeof navigator === "undefined") return (cachedMac = true);
  const nav = navigator as Navigator & { userAgentData?: { platform?: string } };
  const p = nav.userAgentData?.platform || nav.platform || nav.userAgent || "";
  return (cachedMac = /mac|iphone|ipad|ipod/i.test(p));
}

/** Test hook. */
export function __setMacPlatform(v: boolean | null): void {
  cachedMac = v;
}

const MODS: Record<string, string> = { "⌃": "Ctrl", "⌥": "Alt", "⇧": "Shift", "⌘": "Ctrl" };
// A run of modifier glyphs followed by one key (letter, digit, symbol, or a
// named key such as Enter). Order on Windows: Ctrl, Alt, Shift.
const COMBO = /([⌃⌥⇧⌘]+)(Enter|Esc|Tab|Space|Backspace|Delete|[A-Za-z0-9]|[^\s⌃⌥⇧⌘`'")\]}])/g;
const ORDER = ["Ctrl", "Alt", "Shift"];

export function platformKeys(text: string, mac: boolean = isMacPlatform()): string {
  if (mac || !/[⌘⌥⌃⇧]/.test(text)) return text;
  return text.replace(COMBO, (all, mods: string, key: string) => {
    if (!mods.includes("⌘") && !mods.includes("⌃") && !mods.includes("⌥")) return all; // a lone ⇧ is just an arrow-like glyph
    const names = [...new Set([...mods].map((m) => MODS[m]))].sort((a, b) => ORDER.indexOf(a) - ORDER.indexOf(b));
    return [...names, key.length === 1 ? key.toUpperCase() : key].join("+");
  });
}
