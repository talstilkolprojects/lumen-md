/**
 * The desktop shell's window basics (plan W3.9): which window this is, its
 * own storage key, the tab state that moves between windows and the drop
 * test of a tab dragged out. Pure and small, so the store and the tab strip
 * load them at startup; the rest of the shell (./shell) loads only in the
 * desktop app.
 */

export const isDesktop = (): boolean => typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;

/** This window's label: `main`, `w-N` or `capture` (Rust puts it in the URL). */
export function windowLabel(search: string = typeof location !== "undefined" ? location.search : ""): string {
  const w = new URLSearchParams(search).get("window") ?? "";
  return /^(main|capture|w-[0-9]{1,4})$/.test(w) ? w : "main";
}

/**
 * Each editor window keeps its own tabs and note: the main window uses the
 * usual store key, another window its own key, seeded on first load with
 * the main window's settings (theme, language, …) but none of its notes.
 */
export const STORE_KEY = "lumen-md";

export function storeKeyFor(label: string): string {
  return label === "main" ? STORE_KEY : `${STORE_KEY}:${label}`;
}

/** The main window's persisted store without its note and tabs (a new window's start). */
export function seedFromMain(mainRaw: string | null): string | null {
  if (!mainRaw) return null;
  try {
    const data = JSON.parse(mainRaw) as { state?: Record<string, unknown>; version?: number };
    if (!data?.state || typeof data.state !== "object") return null;
    const { doc: _doc, openTabs: _tabs, ...settings } = data.state;
    return JSON.stringify({ ...data, state: settings });
  } catch {
    return null;
  }
}

/** A Storage for zustand's persist that keeps a secondary window's state apart. */
export function windowStorage(label: string, base: Pick<Storage, "getItem" | "setItem" | "removeItem">): Pick<Storage, "getItem" | "setItem" | "removeItem"> {
  if (label === "main") return base;
  const own = (name: string) => (name === STORE_KEY ? storeKeyFor(label) : `${name}:${label}`);
  return {
    getItem: (name) => base.getItem(own(name)) ?? (name === STORE_KEY ? seedFromMain(base.getItem(STORE_KEY)) : null),
    setItem: (name, value) => base.setItem(own(name), value),
    removeItem: (name) => base.removeItem(own(name)),
  };
}

/** A tab's editing state, as it travels to another window. */
export interface TabState {
  id: string;
  name: string;
  workspaceName: string | null;
  content: string;
  dirty: boolean;
  mode?: "source" | "split" | "preview" | "wysiwyg";
  selection?: { anchor: number; head: number };
  scrollTop?: number;
}

const MODES = new Set(["source", "split", "preview", "wysiwyg"]);

/** Parse a tab state from another window; null when it isn't one. */
export function parseTabState(raw: string): TabState | null {
  try {
    const d = JSON.parse(raw) as Partial<TabState>;
    if (typeof d.id !== "string" || typeof d.name !== "string" || typeof d.content !== "string" || typeof d.dirty !== "boolean") return null;
    if (d.workspaceName !== null && typeof d.workspaceName !== "string") return null;
    const out: TabState = { id: d.id, name: d.name, workspaceName: d.workspaceName ?? null, content: d.content, dirty: d.dirty };
    if (d.mode && MODES.has(d.mode)) out.mode = d.mode;
    const n = d.content.length;
    if (d.selection && Number.isInteger(d.selection.anchor) && Number.isInteger(d.selection.head)) {
      out.selection = { anchor: Math.max(0, Math.min(n, d.selection.anchor)), head: Math.max(0, Math.min(n, d.selection.head)) };
    }
    if (typeof d.scrollTop === "number" && Number.isFinite(d.scrollTop) && d.scrollTop >= 0) out.scrollTop = d.scrollTop;
    return out;
  } catch {
    return null;
  }
}

/** Was a tab dropped outside this window? (Browser drag events report the drop point.) */
export function droppedOutside(e: { clientX: number; clientY: number }, size: { w: number; h: number }): boolean {
  // Chromium reports (0, 0) when a drag ends outside every window it knows of.
  return e.clientX < 0 || e.clientY < 0 || e.clientX > size.w || e.clientY > size.h || (e.clientX === 0 && e.clientY === 0);
}
