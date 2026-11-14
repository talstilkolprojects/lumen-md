/**
 * The desktop shell's work in the app (plan W3.9), loaded by
 * ./useDesktopShell only in the desktop app: opens what Finder, Explorer,
 * `lumen://` links and the tray ask for, moves tabs between windows with
 * their editing state, and keeps the tray menu in the UI language.
 * A no-op outside the desktop app.
 */

import type { EditorHandle } from "../editor/Editor";
import { t } from "../i18n";
import { tabIdOf, useAppStore } from "../store/useStore";
import { dragTabOut, formatCapture, INBOX_PATH, initDesktopShell, setTrayMenu, standaloneHandle, syncTabs, type TabState } from "./shell";
import "./desktopShellRunStrings";

/** Run `fn` on the editor once the note `content` is loaded in it (the editor mounts lazily). */
function whenEditorShows(editorRef: React.RefObject<EditorHandle | null>, content: string, fn: (h: EditorHandle) => void, tries = 40): void {
  const h = editorRef.current;
  const view = h?.getView();
  if (h && view && view.state.doc.toString() === content) return fn(h);
  if (tries > 0) setTimeout(() => whenEditorShows(editorRef, content, fn, tries - 1), 75);
}

/** This window's state of one tab, to send to another window. */
export function tabStateOf(id: string, editorRef: React.RefObject<EditorHandle | null>): TabState | null {
  const st = useAppStore.getState();
  const tab = st.openTabs.find((x) => x.id === id);
  if (!tab) return null;
  const active = tabIdOf(st.doc) === id;
  const state: TabState = { id, name: tab.name, workspaceName: tab.workspaceName ?? null, content: active ? st.doc.content : tab.content, dirty: active ? st.doc.dirty : tab.dirty };
  if (active) {
    state.mode = st.mode;
    const view = editorRef.current?.getView();
    if (view) {
      const sel = view.state.selection.main;
      state.selection = { anchor: sel.anchor, head: sel.head };
      state.scrollTop = view.scrollDOM.scrollTop;
    }
  }
  return state;
}

/** What the hook keeps current for the shell: the editor, "new note" and the toast. */
export interface ShellOpts {
  editorRef: React.RefObject<EditorHandle | null>;
  onNew: () => void;
  showToast: (msg: string) => void;
}

/** Start the shell; returns its stop function. */
export async function startDesktopShell(opts: { current: ShellOpts }): Promise<() => void> {
  const ws = await import("../storage/workspace");
  const loc = await import("../storage/vault/location");
  const { invoke } = await import("@tauri-apps/api/core");
  let cachedRoot = await loc.desktopVaultRoot().catch(() => "");
  const s = await initDesktopShell({
    activeRoot: () => cachedRoot,
    switchVault: async (root) => {
      await loc.switchDesktopVault(root);
      cachedRoot = root;
    },
    openVaultFile: async (rel, line) => {
      const content = await ws.readWorkspaceFile(rel);
      useAppStore.getState().openTab({ name: rel.split("/").pop() ?? rel, content, workspaceName: rel });
      if (line) window.dispatchEvent(new CustomEvent("lumen-reveal-line", { detail: { line, content } }));
    },
    openStandalone: async (token, name) => {
      const bytes = await invoke<ArrayBuffer>("external_read", { token });
      const content = new TextDecoder().decode(bytes);
      useAppStore.getState().openTab({ name, content, workspaceName: null, handle: standaloneHandle(token, name, invoke as never) });
    },
    newNote: async (title, text, folder) => {
      if (!title && !text && !folder) return opts.current.onNew();
      const base = (title ?? t("doc.untitled")).replace(/[\\/:*?"<>|]/g, "-");
      const name = await ws.uniqueWorkspaceName(`${folder ? `${folder}/` : ""}${base}.md`);
      const content = `${title ? `# ${title}\n\n` : ""}${text ?? ""}`;
      // Opened unsaved, so nothing is written that the user didn't see.
      useAppStore.getState().openTab({ name: name.split("/").pop() ?? name, content, workspaceName: null });
      useAppStore.getState().setContent(content);
    },
    capture: async (text) => {
      let existing = "";
      try {
        existing = await ws.readWorkspaceFile(INBOX_PATH);
      } catch {
        // why: no inbox note yet: the capture starts a new one
        /* a new inbox */
      }
      const next = await formatCapture(text, existing);
      if (next === null) return;
      await ws.writeWorkspaceFile(INBOX_PATH, next);
      opts.current.showToast(t("desktop.captured"));
    },
    notifyUnknownVault: (name) => opts.current.showToast(t("desktop.unknownVault", { name })),
    tabIds: () => useAppStore.getState().openTabs.map((x) => x.id),
    receiveTab: async (state) => {
      const st = useAppStore.getState();
      st.openTab({ name: state.name, content: state.content, workspaceName: state.workspaceName });
      if (state.dirty) st.setContent(state.content);
      if (state.mode) st.setMode(state.mode);
      whenEditorShows(opts.current.editorRef, state.content, (h) => {
        const view = h.getView();
        if (!view) return;
        if (state.selection) view.dispatch({ selection: state.selection });
        if (state.scrollTop !== undefined) view.scrollDOM.scrollTop = state.scrollTop;
        view.focus();
      });
    },
    dropTab: (id) => useAppStore.getState().closeTab(id),
  });
  return s;
}

/** Rust tracks which window holds which tab. */
export function syncOpenTabs(ids: string[]): void {
  void syncTabs(ids).catch(() => undefined);
}

/** The tray, in the UI language, with this window's recent tabs. */
export function updateTray(openTabs: ReadonlyArray<{ name: string; workspaceName?: string | null }>): void {
  void setTrayMenu(
    { capture: t("desktop.tray.capture"), new_note: t("desktop.tray.new"), recent: t("desktop.tray.recent"), show: t("desktop.tray.show"), quit: t("desktop.tray.quit") },
    openTabs.filter((x) => x.workspaceName).slice(-5).reverse().map((x) => [x.name, x.workspaceName as string]),
  ).catch(() => undefined);
}

/** A tab dragged out of the window: hand its state to Rust. */
export function dragOut(id: string, editorRef: React.RefObject<EditorHandle | null>): void {
  const state = tabStateOf(id, editorRef);
  if (state) void dragTabOut(state).catch(() => undefined);
}
