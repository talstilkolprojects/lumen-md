import { useCommands, openNewDoc } from "./commands/useCommands";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { EditorHandle } from "./editor/Editor";

import { Toolbar } from "./ui/Toolbar";
import { Outline } from "./ui/Outline";
import { StatusBar } from "./ui/StatusBar";
import { ScrollProgress } from "./ui/ScrollProgress";
import { SearchReplace } from "./ui/SearchReplace";
const GraphView = lazy(() => import("./ui/GraphView").then(m => ({ default: m.GraphView })));
// γ.2 — Canvas now backed by tldraw. The legacy custom-canvas component
// `CanvasWhiteboard.tsx` remains in tree as a fallback in case we ever
// need to surface old `.canvas.json` files; it's intentionally unused.
const CanvasWhiteboard = lazy(() => import("./ui/CanvasTldraw").then(m => ({ default: m.CanvasTldraw })));
const PluginGallery = lazy(() => import("./ui/PluginGallery").then(m => ({ default: m.PluginGallery })));
const TemplateGallery = lazy(() => import("./ui/TemplateGallery").then(m => ({ default: m.TemplateGallery })));
const AuditLog = lazy(() => import("./ui/AuditLog").then(m => ({ default: m.AuditLog })));
const OrgSettings = lazy(() => import("./ui/OrgSettings").then(m => ({ default: m.OrgSettings })));
const TrustedKeysSettings = lazy(() => import("./ui/TrustedKeysSettings").then(m => ({ default: m.TrustedKeysSettings })));
const ThemeSettings = lazy(() => import("./ui/ThemeSettings").then(m => ({ default: m.ThemeSettings })));
const AiSettingsPanel = lazy(() => import("./ui/AiSettingsPanel").then(m => ({ default: m.AiSettingsPanel })));
const PrivacyLedgerPanel = lazy(() => import("./ui/PrivacyLedgerPanel").then(m => ({ default: m.PrivacyLedgerPanel })));
const TrashPanel = lazy(() => import("./ui/TrashPanel").then(m => ({ default: m.TrashPanel })));
const AiDoctorPanel = lazy(() => import("./ui/AiDoctorPanel").then(m => ({ default: m.AiDoctorPanel })));
const FineTuneSettings = lazy(() => import("./ui/FineTuneSettings").then(m => ({ default: m.FineTuneSettings })));
const VersionHistory = lazy(() => import("./ui/VersionHistory").then(m => ({ default: m.VersionHistory })));
const MarkdownTableEditor = lazy(() => import("./ui/MarkdownTableEditor").then(m => ({ default: m.MarkdownTableEditor })));
import { htmlToMarkdown } from "./storage/fileFormats";
import { wirePluginAPI, registerPlugin, unregisterPlugin, wordCountPlugin } from "./plugins/pluginSystem";
import { CommandPalette } from "./ui/CommandPalette";
import { AiFab } from "./ui/AiFab";
import { FileTree } from "./ui/FileTree";
import { SidebarResizer } from "./ui/SidebarResizer";
import { uiAlert, uiConfirm, uiPrompt } from "./ui/PromptDialog";
import { openInsertTextDialog } from "./ui/InsertTextDialog";
import { BacklinksPanel } from "./ui/BacklinksPanel";
// SearchDialog imports the CodeMirror search-highlight extension; lazy so
// the boot path stays CodeMirror-free (the dialog opens on ⌘⇧F).
const SearchDialog = lazy(() =>
  import("./ui/SearchDialog").then((m) => ({ default: m.SearchDialog })),
);
import { AiToastContainer, showAiToast } from "./ui/AiToast";
import { AiSuggestionsPanel } from "./ui/AiSuggestionsPanel";
import { MobileKeyboardBar } from "./ui/MobileKeyboardBar";
import { TagsPanel } from "./ui/TagsPanel";
// CommentsPanel pulls collab/comments.ts → yjs; comments only exist inside a
// collab session, so the panel is lazy and addCommentFromSelection is
// imported at the call site to keep yjs off the boot path.
const CommentsPanel = lazy(() =>
  import("./ui/CommentsPanel").then((m) => ({ default: m.CommentsPanel })),
);
import { DocTabs, tabId } from "./ui/DocTabs";
import { AiInlinePromptOverlay } from "./ui/AiInlinePrompt";
import { RuntimeMetricsPanel } from "./ui/RuntimeMetricsPanel";
import { useFileDragDrop } from "./hooks/useFileDragDrop";
import { useCollab } from "./hooks/useCollab";
import { useTauriMenu } from "./hooks/useTauriMenu";
import { EditorLayout } from "./layouts/EditorLayout";
import { useAuth } from "./auth/useAuth";
import { docIdentity } from "./renderer/previewDoc";
import { auditScope } from "./ui/auditScope";
import { useEntitlement, watchAuthForEntitlements } from "./billing/useEntitlement";
import { useAppStore, applyTheme } from "./store/useStore";
import { applyLocale, t } from "./i18n";
import { localLlmAvailable } from "./ai/localLlm";
import { assessConfigHealth } from "./lib/configHealth";
import { historyKey, isQuotaError, onHistoryQuota, onQuotaWarning, recordSnapshot } from "./storage/history";
import { log } from "./lib/logger";
import { openFileDialog, saveFile } from "./storage/fs";
import { exportToHtml } from "./storage/exportHtml";
import { getRecents, pushRecent, reopenRecent } from "./storage/recent";
import type { RecentFile } from "./storage/recent";
import {
  isOPFSAvailable,
  makeAssetName,
  readWorkspaceFile,
  uniqueWorkspaceName,
  writeWorkspaceBlob,
  writeWorkspaceFile,
} from "./storage/workspace";
import { welcomeDoc } from "./welcomeDoc";
import { ErrorBoundary } from "./ui/ErrorBoundary";
import { KeyboardShortcuts } from "./ui/KeyboardShortcuts";
import { FocusMode } from "./ui/FocusMode";
import { OnboardingTour } from "./ui/OnboardingTour";
import { scrollToHeadingWhenRendered } from "./renderer/wikiLinks";
import { notifyWorkspaceChanged } from "./storage/workspaceEvents";

export default function App() {
  const doc = useAppStore((s) => s.doc);
  const setContent = useAppStore((s) => s.setContent);
  const setDoc = useAppStore((s) => s.setDoc);
  const markSaved = useAppStore((s) => s.markSaved);
  const adoptWorkspaceName = useAppStore((s) => s.adoptWorkspaceName);
  const openTabs = useAppStore((s) => s.openTabs);
  const openTabAction = useAppStore((s) => s.openTab);
  const closeTabAction = useAppStore((s) => s.closeTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const mode = useAppStore((s) => s.mode);
  const theme = useAppStore((s) => s.theme);
  const showOutline = useAppStore((s) => s.showOutline);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const locale = useAppStore((s) => s.locale);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);
  const showBacklinks = useAppStore((s) => s.showBacklinks);
  const vimEnabled = useAppStore((s) => s.vimEnabled);
  const spellCheck = useAppStore((s) => s.spellCheck);
  const grammarCheck = useAppStore((s) => s.grammarCheck);
  const typewriterMode = useAppStore((s) => s.typewriterMode);
  const suggestingMode = useAppStore((s) => s.suggestingMode);
  const aiKey = useAppStore((s) => s.aiKey);
  const useLocalAi = useAppStore((s) => s.useLocalAi);
  const editorRef = useRef<EditorHandle | null>(null);
  const authStatus = useAuth((s) => s.status);
  const authProviderName = useAuth((s) => s.provider.name);
  const authError = useAuth((s) => s.error);
  const authUserId = useAuth((s) => s.user?.id);
  const authOrgId = useAuth((s) => s.user?.orgId);
  const entitlementLoading = useEntitlement((s) => s.loading);
  const entitlement = useEntitlement((s) => s.entitlement);
  const capabilitiesCloudSync = useEntitlement((s) => s.capabilities.cloudSync);
  const hasWebGPU = useMemo(() => {
    if (typeof window === "undefined" || typeof navigator === "undefined") return false;
    return localLlmAvailable().available;
  }, []);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [searchOpen, setSearchOpen] = useState(false);
  useEffect(() => {
    if (searchOpen) setSearchMounted(true);
  }, [searchOpen]);
  const [findReplaceOpen, setFindReplaceOpen] = useState(false);
  const [graphOpen, setGraphOpen] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [tableEditorOpen, setTableEditorOpen] = useState(false);
  const [canvasOpen, setCanvasOpen] = useState(false);
  const [galleryOpen, setGalleryOpen] = useState(false);
  const [templateGalleryOpen, setTemplateGalleryOpen] = useState(false);
  const [auditLogOpen, setAuditLogOpen] = useState(false);
  const [fineTuneOpen, setFineTuneOpen] = useState(false);
  const [orgSettingsOpen, setOrgSettingsOpen] = useState(false);
  const [trustedKeysOpen, setTrustedKeysOpen] = useState(false);
  const [themeSettingsOpen, setThemeSettingsOpen] = useState(false);
  const [aiSettingsOpen, setAiSettingsOpen] = useState(false);
  const [aiDoctorOpen, setAiDoctorOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  // The search dialog loads on first open and then stays mounted, so an
  // Ask Workspace conversation survives closing it (perf: not at startup).
  const [searchMounted, setSearchMounted] = useState(false);
  const [privacyOpen, setPrivacyOpen] = useState(false);
  const [tagsPanelOpen, setTagsPanelOpen] = useState(false);
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [runtimeMetricsOpen, setRuntimeMetricsOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [focusMode, setFocusMode] = useState(false);
  const [tourOpen, setTourOpen] = useState(false);
  const [recents, setRecents] = useState<RecentFile[]>([]);

  // ── Collaboration (extracted hook) ─────────────────────────────
  const { collab, collabPeers, handleStartCollab, handleStopCollab } = useCollab(doc.content);

  // Load recents on mount.
  useEffect(() => {
    getRecents().then(setRecents).catch(() => setRecents([]));
  }, []);

  useEffect(() => {
    void useEntitlement.getState().refresh();
    // Re-fetch when the user signs in/out or the session restore finishes.
    return watchAuthForEntitlements();
  }, []);

  // Apply theme on mount
  useEffect(() => {
    applyTheme(theme);
  }, [theme]);

  // Plugin system init
  useEffect(() => {
    wirePluginAPI({
      getContent: () => useAppStore.getState().doc.content,
      setContent: (s: string) => useAppStore.getState().setContent(s),
      getFileName: () => useAppStore.getState().doc.name,
      showToast: (msg: string) => showAiToast(msg, "info"),
    });
    registerPlugin(wordCountPlugin);
    // Expose a tiny test surface on window.__lumen for e2e specs. This
    // lets the prod-build paste-html spec call htmlToMarkdown without
    // importing /src/* at runtime (which only works against the dev
    // server). The surface is intentionally minimal — only utilities
    // the test suite needs.
    (window as unknown as { __lumen?: unknown }).__lumen = {
      htmlToMarkdown,
    };
    return () => {
      unregisterPlugin(wordCountPlugin.id);
      delete (window as unknown as { __lumen?: unknown }).__lumen;
    };
  }, []);

  // Apply locale (sets <html lang dir>) on mount and on change.
  useEffect(() => {
    applyLocale(locale);
  }, [locale]);

  // Launched from the installed app: share target, shortcut, or a file
  // opened with Lumen (D3).
  useEffect(() => {
    void import("./pwa/launch").then(({ parseLaunch, clearLaunchParams, onLaunchFiles }) => {
      const l = parseLaunch(location.search);
      if (l.kind === "share") {
        // A fresh tab name each time: two shares with the same title (or two
        // links from one host) stay two notes.
        openNewDoc(l.title.replace(/[\\/:*?"<>|]+/g, " ").slice(0, 60).trim() || "Shared", l.body, true);
      } else if (l.kind === "action" && l.action === "new") {
        openNewDoc(t("doc.untitled"), "", false);
      } else if (l.kind === "action" && l.action === "palette") {
        setPaletteOpen(true);
      }
      if (l.kind !== "none") clearLaunchParams();
      // With the file's handle, so Save writes back to the file that was opened.
      onLaunchFiles((name, content, handle) => openTabAction({ name, content, workspaceName: null, handle }));
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Check for a shared note from the iOS Share Extension.
  useEffect(() => {
    const pending = (window as unknown as Record<string, unknown>).__pendingSharedNote;
    if (typeof pending === "string" && pending.length > 0) {
      // Clear the pending note so we don't process it again.
      delete (window as unknown as Record<string, unknown>).__pendingSharedNote;
      openNewDoc("Shared Note", pending, true);
      showAiToast(t("toast.openedSharedNoteFromIos"), "info");
    }
  }, []);

  // Seed the Welcome document on first launch
  useEffect(() => {
    if (!doc.content) {
      // Use openTab so the Welcome doc lands on the tab strip too.
      openTabAction({ name: "Welcome.md", content: welcomeDoc(), workspaceName: null });
    } else if (openTabs.length === 0) {
      // Existing session before tabs existed — backfill a tab for the
      // currently active doc so the strip shows up immediately.
      openTabAction({
        name: doc.name,
        content: doc.content,
        workspaceName: doc.workspaceName ?? null,
      });
    }
    // Show onboarding tour on first launch
    let tourTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      if (!localStorage.getItem("lumen-tour-done")) {
        tourTimer = setTimeout(() => setTourOpen(true), 1200);
      }
    } catch {
      /* storage may be denied in private browsing — onboarding silently skips */
    }
    return () => {
      if (tourTimer) clearTimeout(tourTimer);
    };
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const configHealth = useMemo(
    () =>
      assessConfigHealth({
        authStatus,
        authProviderName,
        authError,
        userId: authUserId,
        entitlementLoading,
        entitlement,
        capabilitiesCloudSync,
        aiKey,
        useLocalAi,
        hasWebGPU,
      }),
    [
      authStatus,
      authProviderName,
      authError,
      authUserId,
      entitlementLoading,
      entitlement,
      capabilitiesCloudSync,
      aiKey,
      useLocalAi,
      hasWebGPU,
    ],
  );

  // Beforeunload warning if dirty
  useEffect(() => {
    function onBeforeUnload(e: BeforeUnloadEvent) {
      if (doc.dirty) {
        e.preventDefault();
        e.returnValue = "";
      }
    }
    window.addEventListener("beforeunload", onBeforeUnload);
    return () => window.removeEventListener("beforeunload", onBeforeUnload);
  }, [doc.dirty]);

  const handleOpen = useCallback(async () => {
    const file = await openFileDialog();
    if (!file) return;
    setDoc({
      name: file.name,
      content: file.content,
      handle: file.handle,
      dirty: false,
    });
    if (file.handle) {
      await pushRecent({ name: file.name, handle: file.handle });
      setRecents(await getRecents());
    }
  }, [setDoc]);

  const handleReopenRecent = useCallback(
    async (entry: RecentFile) => {
      const opened = await reopenRecent(entry);
      if (!opened) {
        await uiAlert({ message: t("doc.alert.reopenFailed") });
        return;
      }
      setDoc({
        name: opened.name,
        content: opened.content,
        handle: opened.handle,
        dirty: false,
      });
      await pushRecent({ name: opened.name, handle: opened.handle });
      setRecents(await getRecents());
    },
    [setDoc],
  );

  const handleSave = useCallback(
    async (saveAs = false) => {
      try {
        const next = await saveFile(
          { name: doc.name, content: doc.content, handle: doc.handle },
          { saveAs },
        );
        setDoc({
          name: next.name,
          content: next.content,
          handle: next.handle,
          dirty: false,
        });
        markSaved();
        void recordSnapshot(historyKey({ name: next.name, workspaceName: useAppStore.getState().doc.workspaceName }), next.content, "save").catch(() => false);
      } catch (err) {
        // User cancelled Save-As dialog or filesystem error
        if ((err as DOMException)?.name !== "AbortError") {
          await uiAlert({ message: t("doc.alert.saveFailed", { error: (err as Error).message }) });
        }
      }
    },
    [doc.name, doc.content, doc.handle, setDoc, markSaved],
  );

  const handleNew = useCallback(async () => {
    if (doc.dirty && !(await uiConfirm({ message: t("doc.confirm.discardUnsaved") }))) return;
    
    let baseName = `${t("doc.untitled")}.md`;
    if (await isOPFSAvailable()) {
      baseName = await uniqueWorkspaceName(baseName);
    }
    
    setDoc({
      name: baseName,
      content: `# ${baseName.replace(/\.md$/, "")}\n\n`,
      handle: undefined,
      dirty: false,
    });
  }, [doc.dirty, setDoc]);

  const handleExportHtml = useCallback(async () => {
    try {
      await exportToHtml(doc.content, doc.name);
    } catch (e) {
      await uiAlert({ message: t("doc.alert.exportFailed", { error: (e as Error).message }) });
    }
  }, [doc.content, doc.name]);

  const insertSnippet = useCallback((snippet: string) => {
    editorRef.current?.insertText(snippet);
  }, []);

  // ── Real-time collaboration (managed by useCollab hook) ──────────────

  /**
   * When the user pastes/drops an image into the editor, persist it under
   * OPFS as a `lumen-asset-*` file (so the workspace owns the asset) and
   * return the markdown link. Falls back to a data: URL when OPFS isn't
   * available.
   */
  const handleAddAsset = useCallback(async (file: File): Promise<string | null> => {
    if (!isOPFSAvailable()) return null;
    try {
      const name = makeAssetName(file.name);
      await writeWorkspaceBlob(name, file);
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      return name;
    } catch {
      return null;
    }
  }, []);

  // Workspace: open a file from the file tree. Routed through `openTab` so
  // re-opening an already-active doc just focuses its tab without losing
  // unsaved edits in the previous one.
  const handleOpenFromWorkspace = useCallback(
    (name: string, content: string) => {
      openTabAction({ name, content, workspaceName: name });
    },
    [openTabAction],
  );

  // Listen for `lumen-open-file` events fired by Database views, backlinks,
  // graph view, and any other component that knows a workspace path. Single
  // hub keeps the open path consistent (recents, dirty handling, etc).
  useEffect(() => {
    async function onOpen(e: Event) {
      const detail = (e as CustomEvent<{ path: string; heading?: string }>).detail;
      if (!detail?.path) return;
      try {
        const { readWorkspaceFile } = await import("./storage/workspace");
        const content = await readWorkspaceFile(detail.path);
        handleOpenFromWorkspace(detail.path, content);
        // `[[Note#Heading]]`: scroll to the heading (by its slug id) once the
        // opened note has rendered.
        if (detail.heading) {
          scrollToHeadingWhenRendered(detail.heading, { docKey: docIdentity(useAppStore.getState().doc) ?? undefined });
        }
      } catch {
        /* file moved/deleted — silently ignore */
      }
    }
    window.addEventListener("lumen-open-file", onOpen);
    return () => window.removeEventListener("lumen-open-file", onOpen);
  }, [handleOpenFromWorkspace]);

  // Workspace: when active file is renamed (in the tree), keep doc.name in sync.
  const handleActiveRenamed = useCallback(
    (newName: string) => {
      setDoc({ name: newName, workspaceName: newName, dirty: false });
    },
    [setDoc],
  );

  const handleActiveDeleted = useCallback(() => {
    setDoc({
      name: `${t("doc.untitled")}.md`,
      content: "",
      workspaceName: null,
      handle: undefined,
      dirty: false,
    });
  }, [setDoc]);

  // Write the active ad-hoc document (no disk handle, not in the
  // workspace) into the workspace under a free name derived from its own,
  // and switch the document and its tab to that identity. Shared by the
  // explicit "save to workspace" command and by autosave.
  const adoptIntoWorkspace = useCallback(async (): Promise<string | null> => {
    const d = useAppStore.getState().doc;
    if (!isOPFSAvailable()) return null;
    const base = d.name.replace(/\.[^./]+$/, "") + ".md";
    const name = await uniqueWorkspaceName(base);
    await writeWorkspaceFile(name, d.content);
    adoptWorkspaceName(name);
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    return name;
  }, [adoptWorkspaceName]);

  // Save the current doc into the workspace as a fresh file.
  const handleSaveToWorkspace = useCallback(async () => {
    if (!isOPFSAvailable()) {
      await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
      return;
    }
    await adoptIntoWorkspace();
    if (!showWorkspace) toggleWorkspace();
  }, [adoptIntoWorkspace, showWorkspace, toggleWorkspace]);

  // Autosave the active workspace file as the user types (debounced).
  useEffect(() => {
    if (!doc.workspaceName) return;
    if (!doc.dirty) return;
    const name = doc.workspaceName;
    const content = doc.content;
    let retry: ReturnType<typeof setTimeout> | undefined;
    const write = (attempt: number) => {
      writeWorkspaceFile(name, content)
        .then(() => {
          markSaved();
          // Only this file's text changed: listeners skip the full rescan (C3).
          notifyWorkspaceChanged({ kind: "content", paths: [name] });
          // Every save path feeds the one history store (T35).
          void recordSnapshot(name, content, "autosave").catch(() => false);
        })
        .catch((err: unknown) => {
          // A failed write used to vanish silently. Say so once, retry
          // with back-off; the localStorage mirror still holds the text.
          if (attempt === 0) showAiToast(t(isQuotaError(err) ? "doc.save.quota" : "doc.save.failedRetrying", { name }), "error");
          if (attempt < 4) retry = setTimeout(() => write(attempt + 1), 2000 * 2 ** attempt);
        });
    };
    const timer = setTimeout(() => write(0), 600);
    return () => {
      clearTimeout(timer);
      if (retry) clearTimeout(retry);
    };
  }, [doc.workspaceName, doc.content, doc.dirty, markSaved]);

  // History quota: the store pruned its oldest quarter and still could not write.
  useEffect(() => onHistoryQuota(() => showAiToast(t("doc.history.quota"), "error")), []);
  // Plan 3.2: warn before it comes to that — past 80 % of the browser's quota.
  useEffect(
    () => onQuotaWarning(({ usage, quota }) => showAiToast(t("doc.history.quotaWarn", { percent: String(Math.round((usage / quota) * 100)) }), "error")),
    [],
  );

  // Keyboard shortcuts
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const meta = e.metaKey || e.ctrlKey;
      if (!meta) return;
      // ⇧⌘F → focus mode toggle (or workspace search if already in focus mode)
      if (e.shiftKey && (e.key === "f" || e.key === "F")) {
        e.preventDefault();
        if (focusMode) {
          setFocusMode(false);
        } else {
          setFocusMode(true);
        }
        return;
      }
      if (e.key === "k" || e.key === "K") {
        e.preventDefault();
        setPaletteOpen((v) => !v);
      } else if (e.key === "s" || e.key === "S") {
        e.preventDefault();
        handleSave(e.shiftKey);
      } else if (e.key === "h" && (e.metaKey || e.ctrlKey)) {
        e.preventDefault();
        setFindReplaceOpen((v) => !v);
      } else if (e.key === "o" || e.key === "O") {
        e.preventDefault();
        handleOpen();
      } else if (e.key === "n" || e.key === "N") {
        e.preventDefault();
        handleNew();
      } else if (e.key === "1") {
        e.preventDefault();
        useAppStore.getState().setMode("source");
      } else if (e.key === "2") {
        e.preventDefault();
        useAppStore.getState().setMode("split");
      } else if (e.key === "3") {
        e.preventDefault();
        useAppStore.getState().setMode("preview");
      } else if (e.key === "4") {
        e.preventDefault();
        useAppStore.getState().setMode("wysiwyg");
      } else if (e.key === "/") {
        e.preventDefault();
        setShortcutsOpen((v) => !v);
      } else if (e.shiftKey && (e.key === "v" || e.key === "V")) {
        // ⌘⇧V — Smart Insert (paste anything → auto-detect → wrap).
        e.preventDefault();
        (async () => {
          const result = await openInsertTextDialog();
          if (!result) return;
          const cur = useAppStore.getState().doc.content;
          const setter = useAppStore.getState().setContent;
          if (result.mode === "replace") setter(result.markdown);
          else if (result.mode === "atCursor" && editorRef.current) {
            editorRef.current.insertText(result.markdown);
          } else {
            const trimmed = cur.endsWith("\n") ? cur : cur + "\n";
            setter(trimmed + (result.mode === "append" ? "\n" : "") + result.markdown);
          }
        })();
      }
    }
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [handleOpen, handleSave, handleNew, focusMode]);

  // Auto-save: save dirty documents on interval
  const autoSave = useAppStore((s) => s.autoSave);
  const autoSaveInterval = useAppStore((s) => s.autoSaveInterval);
  useEffect(() => {
    if (!autoSave || !doc.dirty) return;
    const timer = setInterval(() => {
      const d = useAppStore.getState().doc;
      if (!d.dirty) return;
      if (d.handle) {
        // From disk: write back through the handle (workspace files are
        // written by the debounced effect above).
        handleSave(false);
      } else if (!d.workspaceName && d.content.trim()) {
        // Untitled / ad-hoc: until now these were never written anywhere
        // but localStorage. Give them a home in the workspace; from then
        // on the debounced workspace autosave owns them.
        adoptIntoWorkspace().catch((err) => log.warn("[autosave] adopt failed", (err as Error).message));
      }
    }, autoSaveInterval);
    return () => clearInterval(timer);
  }, [autoSave, autoSaveInterval, doc.dirty, handleSave, adoptIntoWorkspace]);

  // Flush the pending workspace write when the page is hidden or going
  // away: the debounced effect above may still be waiting, and a closed
  // tab (or a backgrounded phone) never runs it. `pagehide` is the last
  // reliable moment; `visibilitychange` covers mobile, where pages are
  // often frozen instead of unloaded. The localStorage mirror keeps the
  // text either way; this keeps the workspace file current.
  useEffect(() => {
    const flush = () => {
      const d = useAppStore.getState().doc;
      void recordSnapshot(historyKey(d), d.content, "close").catch(() => false);
      if (!d.dirty || !d.workspaceName) return;
      const name = d.workspaceName;
      writeWorkspaceFile(name, d.content)
        .then(() => {
          if (useAppStore.getState().doc.workspaceName === name) markSaved();
        })
        .catch(() => {
          /* best effort; the debounced autosave retries on the next edit */
        });
    };
    const onVisibility = () => {
      if (document.visibilityState === "hidden") flush();
    };
    window.addEventListener("pagehide", flush);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("pagehide", flush);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  }, [markSaved]);

  const { dragHover } = useFileDragDrop(setDoc);

  const pageView = useAppStore((s) => s.pageView);

  // Debounce preview rendering — keeps typing smooth for large docs. The
  // document identity is deferred together with its text so the preview
  // never pairs one document's markdown with another's identity.
  const currentDocKey = docIdentity(doc);
  const previewSource = useMemo(
    () => ({ content: doc.content, docKey: currentDocKey }),
    [doc.content, currentDocKey],
  );
  const deferredPreview = useDeferredValue(previewSource);
  const deferredContent = deferredPreview.content;

  const activeFile = doc.name;

  const commands = useCommands({
    handleNew, handleOpen, handleSave, handleExportHtml, handleSaveToWorkspace,
    insertSnippet, recents, setRecents, handleReopenRecent, collab,
    handleStartCollab, handleStopCollab,
    setSearchOpen, setFindReplaceOpen, setGraphOpen,
    setHistoryOpen, setTableEditorOpen, setCanvasOpen, setGalleryOpen,
    setTemplateGalleryOpen,
    setAuditLogOpen,
    setOrgSettingsOpen,
    setTrustedKeysOpen,
    setThemeSettingsOpen,
    setFineTuneOpen,
    setTagsPanelOpen,
    setCommentsPanelOpen,
    setRuntimeMetricsOpen,
    getEditorView: () => editorRef.current?.getView() ?? null,
    onAddComment: collab
      ? async () => {
          const view = editorRef.current?.getView();
          if (!view) return;
          const { from, to } = view.state.selection.main;
          if (from === to) {
            await uiAlert({ message: t("comment.selectTextFirst") });
            return;
          }
          const body = await uiPrompt({ message: t("comment.promptLabel") });
          if (!body?.trim()) return;
          const { addCommentFromSelection } = await import("./ui/CommentsPanel");
          addCommentFromSelection(collab, body, from, to);
          setCommentsPanelOpen(true);
        }
      : undefined,
  });

  // The suggestions panel (and other UIs) re-run a palette command by id.
  const commandsRef = useRef(commands);
  commandsRef.current = commands;
  useEffect(() => {
    const onRun = (e: Event) => {
      const id = (e as CustomEvent<{ id?: string }>).detail?.id;
      const find = (list: typeof commands): (typeof commands)[number] | undefined => {
        for (const c of list) {
          if (c.id === id) return c;
          const child = c.children ? find(c.children as typeof commands) : undefined;
          if (child) return child;
        }
        return undefined;
      };
      const cmd = id ? find(commandsRef.current) : undefined;
      if (cmd) void cmd.action();
    };
    window.addEventListener("lumen-run-command", onRun);
    return () => window.removeEventListener("lumen-run-command", onRun);
  }, []);
  useEffect(() => {
    const onOpen = () => setAiSettingsOpen(true);
    window.addEventListener("lumen-open-ai-settings", onOpen);
    return () => window.removeEventListener("lumen-open-ai-settings", onOpen);
  }, []);
  useEffect(() => {
    const onOpen = () => setPrivacyOpen(true);
    window.addEventListener("lumen-open-privacy-ledger", onOpen);
    return () => window.removeEventListener("lumen-open-privacy-ledger", onOpen);
  }, []);
  useEffect(() => {
    const onOpen = () => setTrashOpen(true);
    window.addEventListener("lumen-open-trash", onOpen);
    // Trash older than 30 days is deleted for good, once per start.
    const purge = window.setTimeout(() => {
      void import("./storage/trash").then((m) => (isOPFSAvailable() ? m.purgeExpiredTrash() : 0)).catch(() => 0);
    }, 5000);
    return () => {
      window.removeEventListener("lumen-open-trash", onOpen);
      window.clearTimeout(purge);
    };
  }, []);
  useEffect(() => {
    const onOpen = () => setAiDoctorOpen(true);
    window.addEventListener("lumen-open-ai-doctor", onOpen);
    return () => window.removeEventListener("lumen-open-ai-doctor", onOpen);
  }, []);
  // Stage 2 of the improvement agent (a small local model proposes suggestions).
  useEffect(() => {
    void import("./agents/modelCritic").then((m) => m.installModelCritic());
  }, []);

  // Comment-anchor click in the editor → window event from
  // commentDecorations.ts. Open the side panel + jump the panel
  // scroll to the matching thread (the panel itself listens for the
  // same event to highlight the right row).
  useEffect(() => {
    const onCommentFocus = () => setCommentsPanelOpen(true);
    window.addEventListener("lumen-comment-focus", onCommentFocus);
    return () => window.removeEventListener("lumen-comment-focus", onCommentFocus);
  }, []);

  // Native Tauri menu wiring — no-op when running in a regular browser.
  useTauriMenu({
    onNew: handleNew,
    onOpen: handleOpen,
    onSave: handleSave,
    onInsertText: async () => {
      const result = await openInsertTextDialog();
      if (!result) return;
      const current = doc.content;
      if (result.mode === "replace") setContent(result.markdown);
      else if (result.mode === "atCursor" && editorRef.current) {
        editorRef.current.insertText(result.markdown);
      } else if (result.mode === "atCursor") {
        const trimmed = current.endsWith("\n") ? current : current + "\n";
        setContent(trimmed + result.markdown);
      } else setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + result.markdown);
    },
    onCommandPalette: () => setPaletteOpen(true),
    onFocusMode: () => setFocusMode(true),
    onShortcuts: () => setShortcutsOpen(true),
    onTour: () => setTourOpen(true),
    onWorkspaceSearch: () => setSearchOpen(true),
    onFindReplace: () => setFindReplaceOpen(true),
    onToggleWorkspace: () => useAppStore.getState().toggleWorkspace(),
    onToggleOutline: () => useAppStore.getState().toggleOutline(),
    onToggleTheme: () => {
      const cur = useAppStore.getState().theme;
      useAppStore.getState().setTheme(cur === "dark" ? "light" : "dark");
    },
    onSetMode: (mode) => useAppStore.getState().setMode(mode),
    onExportHtml: () => commands.find((c) => c.id === "file.exportHtml")?.action(),
    onExportPdf: () => commands.find((c) => c.id === "file.exportPdf")?.action(),
    onPrint: () => commands.find((c) => c.id === "file.print")?.action(),
  });

  return (
    <div className="h-screen flex flex-col">
      <a href="#main" className="skip-link">
        {t("a11y.skipToContent")}
      </a>
      {/* Screen reader announcements */}
      <div
        role="status"
        aria-live="polite"
        aria-atomic="true"
        className="aria-live-region"
        id="lumen-sr-announcer"
      />
      <Toolbar
        onOpen={handleOpen}
        onSave={handleSave}
        onNew={handleNew}
        onCommandPalette={() => setPaletteOpen(true)}
        onFocusMode={() => setFocusMode(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onTour={() => setTourOpen(true)}
        onShowWelcome={() => {
          // Restore the bundled welcome document — handy when the user wants
          // to revisit the feature tour without scrubbing recents for it.
          setDoc({
            name: "Welcome.md",
            content: welcomeDoc(),
            handle: undefined,
            workspaceName: undefined,
            dirty: false,
          });
        }}
        commands={commands}
        onInsertText={async () => {
          const result = await openInsertTextDialog();
          if (!result) return;
          const current = doc.content;
          if (result.mode === "replace") {
            setContent(result.markdown);
          } else if (result.mode === "atCursor" && editorRef.current) {
            // Real cursor-aware insert via the Editor's exposed handle.
            editorRef.current.insertText(result.markdown);
          } else if (result.mode === "atCursor") {
            // Fallback when the editor isn't mounted (e.g. preview-only mode).
            const trimmed = current.endsWith("\n") ? current : current + "\n";
            setContent(trimmed + result.markdown);
          } else {
            setContent(current + (current.endsWith("\n") ? "" : "\n") + "\n" + result.markdown);
          }
          showAiToast(`✅ ${t("toast.insertText.success")}`, "info");
        }}
        onPasteText={async () => {
          const text = await uiPrompt({
            message: t("toast.pasteText.prompt"),
            placeholder: "<h1>Hello</h1>\n<p>Paste your HTML here...</p>",
          });
          if (!text) return;
          const md = text.trim().startsWith("<") ? htmlToMarkdown(text) : text;
          setContent(doc.content + "\n\n" + md);
          showAiToast(`✅ ${t("toast.pasteText.success")}`, "info");
        }}
      />
      <main id="main" className="flex-1 flex min-h-0 relative">
        <SearchReplace
          open={findReplaceOpen}
          onClose={() => setFindReplaceOpen(false)}
          content={doc.content}
          onChange={setContent}
        />
        {showWorkspace && (
          <>
            <FileTree
              activePath={doc.workspaceName ?? null}
              onOpenFile={handleOpenFromWorkspace}
              onActiveRenamed={handleActiveRenamed}
              onActiveDeleted={handleActiveDeleted}
            />
            <SidebarResizer />
          </>
        )}
        {/* minHeight:0 is load-bearing: without it this flex item refuses to
            shrink below its content (flex min-height:auto), the editor and
            preview sections inflate to the full document height, their inner
            scrollers never overflow, and pane scrolling + scroll-sync go
            dead — the whole page scrolls as one block instead. */}
        <div style={{ flex: 1, display: "flex", flexDirection: "column", minWidth: 0, minHeight: 0 }}>
          <DocTabs
            tabs={openTabs.map((t) => ({
              id: t.id,
              name: t.name,
              dirty: t.dirty,
            }))}
            activeId={tabId(doc)}
            onSelect={(id) => {
              const target = openTabs.find((t) => t.id === id);
              if (!target) return;
              openTabAction({
                name: target.name,
                content: target.content,
                workspaceName: target.workspaceName ?? null,
              });
            }}
            onClose={(id) => closeTabAction(id)}
            onReorder={(from, to) => reorderTabs(from, to)}
          />
          <EditorLayout
            mode={mode}
            docContent={doc.content}
            deferredContent={deferredContent}
            deferredDocKey={deferredPreview.docKey}
            editorRef={editorRef}
            vimEnabled={vimEnabled}
            spellCheck={spellCheck}
            grammarCheck={grammarCheck}
            typewriterMode={typewriterMode}
            suggestingMode={suggestingMode}
            activeFile={activeFile}
            pageView={pageView}
            collab={collab}
            setContent={setContent}
            handleAddAsset={handleAddAsset}
          />
        </div>
        {showOutline && <Outline markdownText={doc.content} />}
        {showBacklinks && (
          <BacklinksPanel
            filePath={doc.workspaceName ?? null}
            onOpen={async (fromPath) => {
              try {
                const content = await readWorkspaceFile(fromPath);
                setDoc({
                  name: fromPath.split("/").pop() ?? fromPath,
                  content,
                  handle: undefined,
                  workspaceName: fromPath,
                  dirty: false,
                });
                if (!showWorkspace) toggleWorkspace();
              } catch {
                /* missing file */
              }
            }}
          />
        )}
        {dragHover && (
          <div
            className="absolute inset-0 flex items-center justify-center pointer-events-none animate-in"
            style={{
              background: "hsl(var(--accent) / 0.06)",
              border: "2px dashed hsl(var(--accent))",
              borderRadius: 12,
              margin: 12,
            }}
          >
            <div
              style={{
                background: "hsl(var(--bg))",
                padding: "1rem 1.5rem",
                borderRadius: 10,
                fontSize: 14,
                color: "hsl(var(--accent))",
                border: "1px solid hsl(var(--accent) / 0.3)",
                fontWeight: 600,
              }}
            >
              {t("dnd.dropHint")}
            </div>
          </div>
        )}
      </main>
      <StatusBar
        text={doc.content}
        dirty={doc.dirty}
        filename={doc.name}
        configHealth={configHealth}
        onOpenRuntimeMetrics={() => setRuntimeMetricsOpen(true)}
        collab={
          collab
            ? {
                roomName: collab.roomName,
                peers: collabPeers,
                onLeave: handleStopCollab,
              }
            : null
        }
      />
      <ScrollProgress />
      <CommandPalette
        open={paletteOpen}
        onClose={() => setPaletteOpen(false)}
        commands={commands}
      />
      {searchMounted && <Suspense fallback={null}>
      <SearchDialog
        open={searchOpen}
        onClose={() => setSearchOpen(false)}
        onOpenFile={(path, content) => {
          setDoc({
            name: path.split("/").pop() ?? path,
            content,
            handle: undefined,
            workspaceName: path,
            dirty: false,
          });
          if (!showWorkspace) toggleWorkspace();
        }}
      />
      </Suspense>}
      <AiToastContainer />
      <AiSuggestionsPanel />
      <AiInlinePromptOverlay />
      <MobileKeyboardBar />
      <TagsPanel open={tagsPanelOpen} onClose={() => setTagsPanelOpen(false)} />
      {collab && (
        <Suspense fallback={null}>
        <CommentsPanel
          open={commentsPanelOpen}
          onClose={() => setCommentsPanelOpen(false)}
          collab={collab}
          onJump={(from, to) => {
            const view = editorRef.current?.getView();
            if (!view) return;
            view.focus();
            view.dispatch({
              selection: { anchor: from, head: to },
              effects: [],
              scrollIntoView: true,
            });
          }}
        />
        </Suspense>
      )}

      {/* Graph View overlay */}
      {graphOpen && (
        <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "hsl(var(--bg))" }}>
          <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
            <h3 style={{ margin: 0, fontSize: 14, color: "hsl(var(--fg))" }}>{t("graphView.title")}</h3>
            <button className="icon-btn" onClick={() => setGraphOpen(false)} style={{ width: "auto", padding: "4px 12px", fontSize: 12 }}>{t("dialog.cancel")}</button>
          </div>
          <div style={{ height: "calc(100vh - 42px)" }}>
            <Suspense fallback={<div style={{padding:'2rem',color:'hsl(var(--fg-muted))'}}>{t("loading.generic")}</div>}>
              <ErrorBoundary fallback={
                <div style={{ padding: "3rem", textAlign: "center", color: "hsl(0 80% 60%)" }}>
                  <strong>{t("graphView.renderFailed")}</strong>
                  <p>{t("graphView.renderFailedDetail")}</p>
                </div>
              }>
                <GraphView onOpenFile={(path, content) => {
                  setDoc({ name: path.split("/").pop() ?? path, content, handle: undefined, workspaceName: path, dirty: false });
                  setGraphOpen(false);
                }} />
              </ErrorBoundary>
            </Suspense>
          </div>
        </div>
      )}

      {/* Canvas Whiteboard overlay */}
      <Suspense fallback={null}>
        <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(0 80% 60%)' }}>{t("errorBoundary.heading")}</div>}>
          {canvasOpen && <CanvasWhiteboard open={canvasOpen} onClose={() => setCanvasOpen(false)} />}
          {galleryOpen && <PluginGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />}
          {templateGalleryOpen && <TemplateGallery open={templateGalleryOpen} onClose={() => setTemplateGalleryOpen(false)} />}
          {auditLogOpen && <AuditLog
            open={auditLogOpen}
            onClose={() => setAuditLogOpen(false)}
            // Scope = the signed-in user's organization (WorkOS SSO); free /
            // pro users have no org, so their own id is the scope.
            orgId={auditScope({ id: authUserId ?? "", orgId: authOrgId }) || "personal"}
          />}
          {fineTuneOpen && <FineTuneSettings open={fineTuneOpen} onClose={() => setFineTuneOpen(false)} />}
          {orgSettingsOpen && <OrgSettings open={orgSettingsOpen} onClose={() => setOrgSettingsOpen(false)} onOpenAuditLog={() => setAuditLogOpen(true)} />}
          {trustedKeysOpen && <TrustedKeysSettings open={trustedKeysOpen} onClose={() => setTrustedKeysOpen(false)} />}
          {aiSettingsOpen && <AiSettingsPanel open={aiSettingsOpen} onClose={() => setAiSettingsOpen(false)} />}
          {aiDoctorOpen && <AiDoctorPanel open={aiDoctorOpen} onClose={() => setAiDoctorOpen(false)} />}
          {privacyOpen && <PrivacyLedgerPanel open={privacyOpen} onClose={() => setPrivacyOpen(false)} />}
          {trashOpen && <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />}
          {themeSettingsOpen && <ThemeSettings open={themeSettingsOpen} onClose={() => setThemeSettingsOpen(false)} />}
        </ErrorBoundary>
      </Suspense>

      {/* Version History overlay */}
      {historyOpen && (
        <Suspense fallback={<div style={{padding:'2rem',color:'hsl(var(--fg-muted))'}}>{t("loading.generic")}</div>}>
          <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(0 80% 60%)' }}>{t("errorBoundary.heading")}</div>}>
            <VersionHistory
              fileName={historyKey(doc)}
              currentContent={doc.content}
              onRestore={(content) => setContent(content)}
              onClose={() => setHistoryOpen(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}

      {/* Table Editor overlay */}
      {tableEditorOpen && (
        <Suspense fallback={null}>
          <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(0 80% 60%)' }}>{t("errorBoundary.heading")}</div>}>
            <MarkdownTableEditor
              onUpdate={(md) => {
                const current = doc.content;
                setContent(current + "\n\n" + md + "\n");
              }}
              onClose={() => setTableEditorOpen(false)}
            />
          </ErrorBoundary>
        </Suspense>
      )}

      {/* Floating AI Prompts button — anchored next to the document body. */}
      <AiFab commands={commands} />

      {/* Keyboard Shortcuts Overlay */}
      <KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} />

      {/* Onboarding Tour */}
      <OnboardingTour
        open={tourOpen}
        onClose={() => {
          setTourOpen(false);
          try { localStorage.setItem("lumen-tour-done", "1"); } catch {
            /* storage denied — tour will simply replay next session */
          }
        }}
        actions={[
          {
            id: "runtimeMetrics.open",
            label: t("tour.action.openRuntimeMetrics"),
            onRun: () => {
              setRuntimeMetricsOpen(true);
              setTourOpen(false);
            },
          },
        ]}
      />
      {runtimeMetricsOpen && (
        <RuntimeMetricsPanel onClose={() => setRuntimeMetricsOpen(false)} />
      )}

      {/* Focus Mode overlay */}
      {focusMode && (
        <FocusMode active={focusMode} onExit={() => setFocusMode(false)}>
          <EditorLayout
            mode={mode}
            docContent={doc.content}
            deferredContent={deferredContent}
            deferredDocKey={deferredPreview.docKey}
            editorRef={editorRef}
            vimEnabled={vimEnabled}
            spellCheck={spellCheck}
            grammarCheck={grammarCheck}
            typewriterMode={typewriterMode}
            suggestingMode={suggestingMode}
            activeFile={activeFile}
            pageView={pageView}
            collab={collab}
            setContent={setContent}
            handleAddAsset={handleAddAsset}
          />
        </FocusMode>
      )}
    </div>
  );
}
