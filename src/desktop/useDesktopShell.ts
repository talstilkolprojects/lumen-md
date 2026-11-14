/**
 * The desktop shell in the app (plan W3.9): opens what Finder, Explorer,
 * `lumen://` links and the tray ask for, moves tabs between windows with
 * their editing state, and keeps the tray menu in the UI language.
 * A no-op outside the desktop app; the shell itself (./desktopShellRun,
 * ./shell) loads only there, so it stays out of the browser's startup bundle.
 */

import { useEffect, useRef } from "react";
import type { EditorHandle } from "../editor/Editor";
import { useAppStore } from "../store/useStore";
import { isDesktop } from "./window";

type Run = typeof import("./desktopShellRun");
let run: Promise<Run> | null = null;
const load = (): Promise<Run> => (run ??= import("./desktopShellRun"));

export function useDesktopShell(opts: { editorRef: React.RefObject<EditorHandle | null>; onNew: () => void; showToast: (msg: string) => void }): { onTabDragOut: (id: string) => void } {
  const optsRef = useRef(opts);
  optsRef.current = opts;
  const openTabs = useAppStore((s) => s.openTabs);
  const locale = useAppStore((s) => s.locale);

  useEffect(() => {
    if (!isDesktop()) return;
    let stop: (() => void) | undefined;
    let cancelled = false;
    void load()
      .then((m) => m.startDesktopShell(optsRef))
      .then((s) => {
        if (cancelled) s();
        else stop = s;
      });
    return () => {
      cancelled = true;
      stop?.();
    };
  }, []);

  // Rust tracks which window holds which tab.
  useEffect(() => {
    if (!isDesktop()) return;
    void load().then((m) => m.syncOpenTabs(openTabs.map((x) => x.id)));
  }, [openTabs]);

  // The tray, in the UI language, with this window's recent tabs.
  useEffect(() => {
    if (!isDesktop()) return;
    void load().then((m) => m.updateTray(openTabs));
  }, [openTabs, locale]);

  return {
    onTabDragOut: (id) => {
      if (!isDesktop()) return;
      void load().then((m) => m.dragOut(id, optsRef.current.editorRef));
    },
  };
}
