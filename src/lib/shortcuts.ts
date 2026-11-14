/**
 * Every keyboard shortcut Lumen binds itself (plan W2.8), in one table:
 * App's global keys, the tab bar, and the editor's own bindings. App
 * dispatches through `appShortcutFor()`, so a key is matched by its
 * physical position (`KeyboardEvent.code`) and works with the Hebrew
 * layout on; tests check every entry in both layouts and that no two
 * entries collide.
 *
 * Editor bindings (CodeMirror / ProseMirror keymaps) are listed for the
 * conflict check and the shortcuts list; those libraries already fall back
 * to the physical key for non-Latin layouts.
 */

import { matchShortcut } from "./keyboardLayout";

/** `browser`: left to the browser (print), listed so nothing else takes the key. */
/** `global`: bound by App's own key handler by the physical key (Option changes `e.key` on a Mac), not through `appShortcutFor`. */
export type ShortcutScope = "app" | "global" | "tabs" | "editor" | "browser";

export interface Shortcut {
  id: string;
  /** `Mod+Shift+F`: Mod is ⌘ on macOS, Ctrl elsewhere; the key is its US name. */
  combo: string;
  scope: ShortcutScope;
}

/** Most specific first: App takes the first match. */
export const SHORTCUTS: readonly Shortcut[] = [
  { id: "view.focusMode", combo: "Mod+Shift+F", scope: "app" },
  { id: "insert.smart", combo: "Mod+Shift+V", scope: "app" },
  { id: "file.saveAs", combo: "Mod+Shift+S", scope: "app" },
  { id: "palette.toggle", combo: "Mod+K", scope: "app" },
  { id: "file.save", combo: "Mod+S", scope: "app" },
  { id: "view.findReplace", combo: "Mod+H", scope: "app" },
  { id: "file.open", combo: "Mod+O", scope: "app" },
  { id: "file.new", combo: "Mod+N", scope: "app" },
  { id: "view.source", combo: "Mod+1", scope: "app" },
  { id: "view.split", combo: "Mod+2", scope: "app" },
  { id: "view.preview", combo: "Mod+3", scope: "app" },
  { id: "view.wysiwyg", combo: "Mod+4", scope: "app" },
  { id: "help.shortcuts", combo: "Mod+/", scope: "app" },
  { id: "note.today", combo: "Mod+Alt+D", scope: "global" },
  { id: "note.capture", combo: "Mod+Alt+N", scope: "global" },
  { id: "cite.insert", combo: "Mod+Alt+C", scope: "global" },
  { id: "help.open", combo: "F1", scope: "global" },
  // The outline mode's keys (plan W2.x), bound by the editor's outline keymap (editor/outlineExtension.ts).
  { id: "outline.moveUp", combo: "Alt+Shift+↑", scope: "editor" },
  { id: "outline.moveDown", combo: "Alt+Shift+↓", scope: "editor" },
  { id: "outline.indent", combo: "Ctrl+Alt+→", scope: "editor" },
  { id: "outline.outdent", combo: "Ctrl+Alt+←", scope: "editor" },
  { id: "outline.duplicate", combo: "Alt+Shift+D", scope: "editor" },
  { id: "outline.delete", combo: "Alt+Shift+⌫", scope: "editor" },
  { id: "outline.fold", combo: "Ctrl+Alt+↑", scope: "editor" },
  { id: "outline.unfold", combo: "Ctrl+Alt+↓", scope: "editor" },
  { id: "outline.zoomIn", combo: "Ctrl+Alt+↵", scope: "editor" },
  { id: "tab.close", combo: "Mod+W", scope: "tabs" },
  { id: "edit.undo", combo: "Mod+Z", scope: "editor" },
  { id: "edit.redo", combo: "Mod+Shift+Z", scope: "editor" },
  { id: "edit.redoY", combo: "Mod+Y", scope: "editor" },
  { id: "edit.cut", combo: "Mod+X", scope: "editor" },
  { id: "edit.copy", combo: "Mod+C", scope: "editor" },
  { id: "edit.paste", combo: "Mod+V", scope: "editor" },
  { id: "edit.selectAll", combo: "Mod+A", scope: "editor" },
  { id: "edit.find", combo: "Mod+F", scope: "editor" },
  { id: "edit.bold", combo: "Mod+B", scope: "editor" },
  { id: "edit.italic", combo: "Mod+I", scope: "editor" },
  { id: "edit.formatDocument", combo: "Shift+Alt+F", scope: "editor" },
  { id: "edit.complete", combo: "Ctrl+Space", scope: "editor" },
  { id: "file.print", combo: "Mod+P", scope: "browser" },
];

const APP = SHORTCUTS.filter((s) => s.scope === "app");

/** The App-level shortcut this key press is, if any — in any keyboard layout. */
export function appShortcutFor(e: { key: string; code?: string; metaKey?: boolean; ctrlKey?: boolean; altKey?: boolean; shiftKey?: boolean }): string | null {
  if (!(e.metaKey || e.ctrlKey)) return null;
  for (const s of APP) if (matchShortcut(e, s.combo)) return s.id;
  return null;
}

/** A combo as it reads on this platform: `Mod+K` → `⌘K` / `Ctrl+K`. */
export function formatCombo(combo: string, mac: boolean): string {
  const parts = combo.split("+");
  const key = parts.pop() ?? "";
  const name = key.length === 1 ? key.toUpperCase() : key;
  if (mac) {
    const sym: Record<string, string> = { Mod: "⌘", Shift: "⇧", Alt: "⌥", Ctrl: "⌃" };
    return parts.map((p) => sym[p] ?? p).join("") + name;
  }
  return [...parts.map((p) => (p === "Mod" ? "Ctrl" : p)), name].join("+");
}
