/**
 * How the app was launched (W6.25: moved out of App.tsx unchanged): a share
 * target, a shortcut or a file opened with Lumen (D3); widgets, App
 * Shortcuts, Siri and Spotlight on phones (W3.4); and the Welcome document
 * and first-run setup on a first launch (14.1).
 */
import { useEffect } from "react";
import { openNewDoc } from "../commands/useCommands";
import { useAppStore } from "../store/useStore";
import { t } from "../i18n";
import { isOPFSAvailable } from "../storage/workspace";
import { showAiToast } from "../ui/AiToast";

export interface LaunchActions {
  setCaptureOpen: (open: boolean) => void;
  setCaptureVoice: (voice: boolean) => void;
  setPaletteOpen: (open: boolean) => void;
  setSearchQuery: (query: string) => void;
  setSearchOpen: (open: boolean) => void;
  setSetupOpen: (open: boolean) => void;
}

export function useLaunchActions({ setCaptureOpen, setCaptureVoice, setPaletteOpen, setSearchQuery, setSearchOpen, setSetupOpen }: LaunchActions): void {
  const openTabAction = useAppStore((s) => s.openTab);
  // The first render's note and tabs, read by the run-once seed below.
  const doc = useAppStore((s) => s.doc);
  const openTabs = useAppStore((s) => s.openTabs);

  // Launched from the installed app: share target, shortcut, or a file
  // opened with Lumen (D3).
  useEffect(() => {
    void import("../pwa/launch").then(({ parseLaunch, sharedItem, clearLaunchParams, onLaunchFiles, onDesktopCapture }) => {
      const l = parseLaunch(location.search);
      const shared = sharedItem(location.search);
      if (l.kind === "share") {
        // A fresh tab name each time: two shares with the same title (or two
        // links from one host) stay two notes.
        const asNote = () => openNewDoc(l.title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60).trim() || "Shared", l.body, true);
        // Plan 4.16: shares go to the end of inbox.md; a new note only where
        // the vault can't be written.
        if (shared && isOPFSAvailable()) void import("../capture/quickCapture").then((m) => m.captureShared(shared)).catch(asNote);
        else asNote();
      } else if (l.kind === "action" && l.action === "capture") {
        setCaptureOpen(true);
      } else if (l.kind === "action" && l.action === "voice") {
        setCaptureVoice(true);
        setCaptureOpen(true);
      } else if (l.kind === "action" && l.action === "new") {
        openNewDoc(t("doc.untitled"), "", false);
      } else if (l.kind === "action" && l.action === "palette") {
        setPaletteOpen(true);
      }
      if (l.kind !== "none") clearLaunchParams();
      onDesktopCapture();
      // With the file's handle, so Save writes back to the file that was opened.
      onLaunchFiles((name, content, handle) => openTabAction({ name, content, workspaceName: null, handle }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Plan W3.4: home-screen widgets, App Shortcuts, Siri / Shortcuts and Spotlight
  // reach the app as lumen:// action links and a queue of captures (iOS / Android only).
  useEffect(() => {
    let stop: (() => void) | undefined;
    void import("../mobile/nativeActions").then(async (m) => {
      stop = await m.initNativeBridge({
        capture: (mode, tappedAt) => {
          m.noteTap(tappedAt);
          setCaptureVoice(mode === "voice");
          setCaptureOpen(true);
        },
        captureText: async (text, when) => {
          const { captureToInbox } = await import("../capture/quickCapture");
          await captureToInbox(text, when);
          showAiToast(t("widgets.captured"), "success");
        },
        newNote: () => openNewDoc(t("doc.untitled"), "", false),
        search: (query) => {
          setSearchQuery(query);
          setSearchOpen(true);
        },
        daily: () => window.dispatchEvent(new CustomEvent("lumen-open-today")),
      });
    });
    return () => stop?.();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Seed the Welcome document on first launch
  useEffect(() => {
    if (!doc.content) {
      // Use openTab so the Welcome doc lands on the tab strip too. Its text
      // (English and Hebrew) loads on demand, off the startup bundle; a note
      // opened in the meantime wins.
      void import("../welcomeDoc").then((m) => {
        if (useAppStore.getState().doc.content) return;
        openTabAction({ name: "Welcome.md", content: m.welcomeDoc(), workspaceName: null });
      });
    } else if (openTabs.length === 0) {
      // Existing session before tabs existed — backfill a tab for the
      // currently active doc so the strip shows up immediately.
      openTabAction({
        name: doc.name,
        content: doc.content,
        workspaceName: doc.workspaceName ?? null,
      });
    }
    // First launch: the setup (plan 14.1), then its short tour. The flag is
    // the old tour's, so anyone who finished that never sees setup.
    try {
      if (!localStorage.getItem("lumen-tour-done")) setSetupOpen(true);
    } catch {
      /* why: storage may be denied in private browsing — setup silently skips */
    }
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
}
