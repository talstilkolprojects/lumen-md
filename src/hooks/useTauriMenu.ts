import { useEffect } from "react";
import { log } from "../lib/logger";

/**
 * Bridges native Tauri menu events to in-app commands.
 *
 * The Rust shell emits `lumen-menu` with the menu-item id (e.g. `file.new`).
 * Inside the WebView we look up the matching command in the app's command
 * list, or call the supplied handler directly. This keeps a single source of
 * truth for behaviour: the native menu, the toolbar, and the command palette
 * all share the same actions.
 *
 * In a non-Tauri build (regular browser) this hook is a no-op — the dynamic
 * import of `@tauri-apps/api/event` resolves to undefined and the listener
 * is never attached.
 */

export interface MenuActions {
  onNew: () => void;
  onOpen: () => void;
  onSave: (saveAs?: boolean) => void;
  onInsertText?: () => void;
  onCommandPalette: () => void;
  onFocusMode?: () => void;
  onShortcuts?: () => void;
  onTour?: () => void;
  onWorkspaceSearch?: () => void;
  onFindReplace?: () => void;
  onToggleWorkspace?: () => void;
  onToggleOutline?: () => void;
  onToggleTheme?: () => void;
  onSetMode?: (mode: "source" | "split" | "preview" | "wysiwyg") => void;
  onExportHtml?: () => void;
  onExportPdf?: () => void;
  onPrint?: () => void;
  /** File ▸ Quick capture… (plan 4.16). */
  onQuickCapture?: () => void;
}

function isTauri(): boolean {
  return typeof window !== "undefined" &&
    "__TAURI_INTERNALS__" in window;
}

export function useTauriMenu(actions: MenuActions): void {
  useEffect(() => {
    if (!isTauri()) return;

    let unlisten: (() => void) | undefined;
    let cancelled = false;

    (async () => {
      try {
        const { listen } = await import("@tauri-apps/api/event");
        if (cancelled) return;
        const off = await listen<string>("lumen-menu", (event) => {
          const id = event.payload;
          dispatch(id, actions);
        });
        unlisten = off;
      } catch (err) {
        log.warn("tauri menu listener failed to attach", err);
      }
    })();

    return () => {
      cancelled = true;
      unlisten?.();
    };
    // We deliberately depend on the actions object identity — the consumer
    // memoises individual handlers via useCallback so we re-attach only when
    // the bound functions actually change.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [actions]);
}

function dispatch(id: string, a: MenuActions): void {
  switch (id) {
    case "file.new":
      a.onNew();
      return;
    case "file.open":
      a.onOpen();
      return;
    case "file.insertText":
      a.onInsertText?.();
      return;
    case "file.save":
      a.onSave(false);
      return;
    case "file.saveAs":
      a.onSave(true);
      return;
    case "file.exportHtml":
      a.onExportHtml?.();
      return;
    case "file.exportPdf":
      a.onExportPdf?.();
      return;
    case "file.print":
      a.onPrint?.();
      return;
    case "file.quickCapture":
      a.onQuickCapture?.();
      return;
    case "file.toggleWorkspace":
      a.onToggleWorkspace?.();
      return;
    case "edit.find":
      a.onFindReplace?.();
      return;
    case "edit.workspaceSearch":
      a.onWorkspaceSearch?.();
      return;
    case "view.source":
      a.onSetMode?.("source");
      return;
    case "view.split":
      a.onSetMode?.("split");
      return;
    case "view.preview":
      a.onSetMode?.("preview");
      return;
    case "view.wysiwyg":
      a.onSetMode?.("wysiwyg");
      return;
    case "view.toggleOutline":
      a.onToggleOutline?.();
      return;
    case "view.focusMode":
      a.onFocusMode?.();
      return;
    case "view.toggleTheme":
      a.onToggleTheme?.();
      return;
    case "help.commandPalette":
      a.onCommandPalette();
      return;
    case "help.shortcuts":
      a.onShortcuts?.();
      return;
    case "help.tour":
      a.onTour?.();
      return;
    default:
      log.warn("unhandled tauri menu id", id);
  }
}
