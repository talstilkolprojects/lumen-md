import { useCommands } from "./commands/useCommands";
import { baseAsMarkdown } from "./views/bases/embed";
import { lazy, Suspense, useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import type { EditorHandle } from "./editor/Editor";
import type { SettingsTab } from "./settings/schema";

import { Toolbar } from "./ui/Toolbar";
import { Outline } from "./ui/Outline";
import { StatusBar } from "./ui/StatusBar";
import { ScrollProgress } from "./ui/ScrollProgress";
import { SearchReplace } from "./ui/SearchReplace";
// Canvas on Excalidraw (plan 4.19; γ.2 had it on tldraw). The legacy custom-canvas component
const LocalGraphPanel = lazy(() => import("./ui/LocalGraphPanel").then(m => ({ default: m.LocalGraphPanel })));
// `CanvasWhiteboard.tsx` remains in tree as a fallback in case we ever
// need to surface old `.canvas.json` files; it's intentionally unused.
const CanvasWhiteboard = lazy(() => import("./ui/CanvasExcalidraw").then(m => ({ default: m.CanvasExcalidraw })));
const PluginGallery = lazy(() => import("./ui/PluginGallery").then(m => ({ default: m.PluginGallery })));
const TemplateGallery = lazy(() => import("./ui/TemplateGallery").then(m => ({ default: m.TemplateGallery })));
const AuditLog = lazy(() => import("./ui/AuditLog").then(m => ({ default: m.AuditLog })));
// One settings screen (plan 11.1); the theme, AI, training, trusted-key and
// organization dialogs are its tabs.
const SettingsScreen = lazy(() => import("./ui/SettingsScreen").then(m => ({ default: m.SettingsScreen })));
const ReadingSettings = lazy(() => import("./ui/ReadingSettings").then(m => ({ default: m.ReadingSettings })));
const PrivacyLedgerPanel = lazy(() => import("./ui/PrivacyLedgerPanel").then(m => ({ default: m.PrivacyLedgerPanel })));
const TrashPanel = lazy(() => import("./ui/TrashPanel").then(m => ({ default: m.TrashPanel })));
// Properties editor (plan 4.9) — lazy: the yaml-editing code is not in the startup bundle.
const PropertiesPanel = lazy(() => import("./ui/PropertiesPanel").then(m => ({ default: m.PropertiesPanel })));
// Quick capture to inbox.md (plan 4.16): its own chunk, loaded on first open.
const QuickCapture = lazy(() => import("./ui/QuickCapture").then(m => ({ default: m.QuickCapture })));
const ImageHostsPanel = lazy(() => import("./ui/ImageHostsPanel").then(m => ({ default: m.ImageHostsPanel })));
const AiDoctorPanel = lazy(() => import("./ui/AiDoctorPanel").then(m => ({ default: m.AiDoctorPanel })));
const AgentReviewPanel = lazy(() => import("./ui/AgentReviewPanel").then(m => ({ default: m.AgentReviewPanel })));
const ImportWizard = lazy(() => import("./storage/import/ImportWizard").then(m => ({ default: m.ImportWizard })));
const VersionHistory = lazy(() => import("./ui/VersionHistory").then(m => ({ default: m.VersionHistory })));
const MarkdownTableEditor = lazy(() => import("./ui/MarkdownTableEditor").then(m => ({ default: m.MarkdownTableEditor })));
// PDF reader (plan 4.14): pdf.js and the reader load only when a PDF is opened.
const PdfReader = lazy(() => import("./pdf/PdfReaderOverlay").then(m => ({ default: m.PdfReaderOverlay })));
const EpubReader = lazy(() => import("./epub/EpubReader").then(m => ({ default: m.EpubReaderOverlay })));
import { CommandPalette } from "./ui/CommandPalette";
import { AiFab } from "./ui/AiFab";
import { FileTree } from "./ui/FileTree";
import { SidebarResizer } from "./ui/SidebarResizer";
import { uiAlert, uiPrompt } from "./ui/PromptDialog";
// The Insert-text dialog loads on first use, off the startup path (4.14).
import { insertTextFromDialog } from "./ui/insertTextFromDialog";
import { BacklinksPanel } from "./ui/BacklinksPanel";
// SearchDialog imports the CodeMirror search-highlight extension; lazy so
// the boot path stays CodeMirror-free (the dialog opens on ⌘⇧F).
const SearchDialog = lazy(() =>
  import("./ui/SearchDialog").then((m) => ({ default: m.SearchDialog })),
);
import { AiToastContainer, showAiToast } from "./ui/AiToast";
import { HelpHost } from "./ui/HelpHost";
import { AiSuggestionsPanel } from "./ui/AiSuggestionsPanel";
import { MobileKeyboardBarHost } from "./ui/MobileKeyboardBarHost";
import { TagsPanel } from "./ui/TagsPanel";
// CommentsPanel pulls collab/comments.ts → yjs; comments only exist inside a
// collab session, so the panel is lazy and addCommentFromSelection is
// imported at the call site to keep yjs off the boot path.
const CommentsPanel = lazy(() =>
  import("./ui/CommentsPanel").then((m) => ({ default: m.CommentsPanel })),
);
import { DocTabs, tabId } from "./ui/DocTabs";
import { AiInlinePromptOverlay } from "./ui/AiInlinePrompt";
const RuntimeMetricsPanel = lazy(() => import("./ui/RuntimeMetricsPanel").then(m => ({ default: m.RuntimeMetricsPanel })));
import { useFileDragDrop } from "./hooks/useFileDragDrop";
import { useCollab } from "./hooks/useCollab";
import { useTauriMenu } from "./hooks/useTauriMenu";
import { useAgentReview } from "./hooks/useAgentReview";
import { EditorLayout } from "./layouts/EditorLayout";
import { useAuth } from "./auth/useAuth";
import { docIdentity } from "./renderer/previewDoc";
import { auditScope } from "./ui/auditScope";
import { useEntitlement } from "./billing/useEntitlement";
import { useAppStore, isNarrowScreen } from "./store/useStore";
import { t } from "./i18n";
import { localLlmAvailable } from "./ai/localLlm";
import { assessConfigHealth } from "./lib/configHealth";
import { historyKey } from "./storage/history";
import { isOPFSAvailable, readWorkspaceFile } from "./storage/workspace";
import { ErrorBoundary } from "./ui/ErrorBoundary";
const KeyboardShortcuts = lazy(() => import("./ui/KeyboardShortcuts").then(m => ({ default: m.KeyboardShortcuts })));
import { FocusMode } from "./ui/FocusMode";
const OnboardingTour = lazy(() => import("./ui/OnboardingTour").then(m => ({ default: m.OnboardingTour })));
// First-run setup (plan 14.1): its own chunk, loaded only on a first visit or from ⌘K.
const FirstRun = lazy(() => import("./onboarding/FirstRun"));
// Plan W1.29: the moderator's usability-session panel, loaded only when a study runs.
const UsabilitySessionPanel = lazy(() => import("./ui/UsabilitySessionPanel").then((m) => ({ default: m.UsabilitySessionPanel })));
// Plan W4.25: the participant's self-guided session panel, loaded only when one runs.
const UsabilitySelfPanel = lazy(() => import("./ui/UsabilitySelfPanel").then((m) => ({ default: m.UsabilitySelfPanel })));
import { explainError } from "./lib/userError";
import { useEdgeSwipes, useLongNotesOpenForReading } from "./mobile/useMobileGestures";
import { FeatureFlagsHost } from "./ui/FeatureFlagsHost";
import { useDesktopShell } from "./desktop/useDesktopShell";
// W6.25: App.tsx split into hooks and components, behaviour unchanged.
import { useAppBootEffects } from "./hooks/useAppBootEffects";
import { useAppShortcuts } from "./hooks/useAppShortcuts";
import { useAutosave } from "./hooks/useAutosave";
import { useCommandEvents } from "./hooks/useCommandEvents";
import { useDocFileActions } from "./hooks/useDocFileActions";
import { useLaunchActions } from "./hooks/useLaunchActions";
import { useOpenFileEvent } from "./hooks/useOpenFileEvent";
import { usePropertiesEdit } from "./hooks/usePropertiesEdit";
import { useWindowEvent } from "./hooks/useWindowEvent";
import { GraphOverlay } from "./ui/GraphOverlay";
import { DropHint } from "./ui/DropHint";

export default function App() {
  const doc = useAppStore((s) => s.doc);
  // Side effects that own no App state: reading options, snippets, update check, theme, locale, plugins… (W6.25)
  useAppBootEffects();
  const setContent = useAppStore((s) => s.setContent);
  const setDoc = useAppStore((s) => s.setDoc);
  const openTabs = useAppStore((s) => s.openTabs);
  const openTabAction = useAppStore((s) => s.openTab);
  const closeTabAction = useAppStore((s) => s.closeTab);
  const reorderTabs = useAppStore((s) => s.reorderTabs);
  const mode = useAppStore((s) => s.mode);
  const showOutline = useAppStore((s) => s.showOutline);
  const outlineSheet = useAppStore((s) => s.outlineSheet);
  // Phone width (plan 10.2.4): the outline shows as a bottom sheet, opened on demand.
  const [narrow, setNarrow] = useState(isNarrowScreen);
  useEffect(() => {
    if (typeof window.matchMedia !== "function") return;
    const mq = window.matchMedia("(max-width: 760px)");
    const on = () => setNarrow(mq.matches);
    mq.addEventListener?.("change", on);
    return () => mq.removeEventListener?.("change", on);
  }, []);
  // Phones (plan W1.25): edge swipes for the panels; long notes open for reading.
  useEdgeSwipes();
  useLongNotesOpenForReading(tabId(doc), doc.content);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);
  const showBacklinks = useAppStore((s) => s.showBacklinks);
  const showLocalGraph = useAppStore((s) => s.showLocalGraph);
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
  // A usability session (W1.29, self-guided W4.25) survives a reload: reopen its panel.
  const [usabilityOpen, setUsabilityOpen] = useState<null | "moderated" | "unmoderated">(() => {
    try {
      const raw = localStorage.getItem("lumen-usability-session");
      if (!raw) return null;
      return (JSON.parse(raw) as { mode?: string }).mode === "unmoderated" ? "unmoderated" : "moderated";
    } catch {
      return null;
    }
  });
  useWindowEvent("lumen-open-usability", () => setUsabilityOpen("moderated"));
  useWindowEvent("lumen-open-usability-self", () => setUsabilityOpen("unmoderated"));
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
  // The open settings tab, or null when the settings screen is closed.
  const [settingsTab, setSettingsTab] = useState<SettingsTab | null>(null);
  const setFineTuneOpen = useCallback((open: boolean) => setSettingsTab(open ? "fineTune" : null), []);
  const setOrgSettingsOpen = useCallback((open: boolean) => setSettingsTab(open ? "org" : null), []);
  const setTrustedKeysOpen = useCallback((open: boolean) => setSettingsTab(open ? "security" : null), []);
  const setThemeSettingsOpen = useCallback((open: boolean) => setSettingsTab(open ? "appearance" : null), []);
  const [readingOpen, setReadingOpen] = useState(false);
  useWindowEvent("lumen-open-reading", () => setReadingOpen(true));
  const [aiDoctorOpen, setAiDoctorOpen] = useState(false);
  const [agentReviewOpen, setAgentReviewOpen] = useState(false);
  const openAgentReview = useCallback(() => setAgentReviewOpen(true), []);
  const [importOpen, setImportOpen] = useState(false);
  const [trashOpen, setTrashOpen] = useState(false);
  const [propertiesOpen, setPropertiesOpen] = useState(false);
  const [captureOpen, setCaptureOpen] = useState(false);
  const [captureVoice, setCaptureVoice] = useState(false);
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
  const [setupOpen, setSetupOpen] = useState(false);

  // ── Collaboration (extracted hook) ─────────────────────────────
  const { collab, collabPeers, handleStartCollab, handleStopCollab } = useCollab(doc.content);

  const [searchQuery, setSearchQuery] = useState("");
  // Share targets, shortcuts, files opened with Lumen, phone widgets; the Welcome note and first-run setup (W6.25).
  useLaunchActions({ setCaptureOpen, setCaptureVoice, setPaletteOpen, setSearchQuery, setSearchOpen, setSetupOpen });

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

  // Open, save, new, export and workspace actions, and the recent files (W6.25).
  const {
    recents, setRecents, handleOpen, handleReopenRecent, handleSave, handleNew, handleExportHtml, handleAddAsset,
    handleOpenFromWorkspace, handleActiveRenamed, handleActiveDeleted, adoptIntoWorkspace, handleSaveToWorkspace,
  } = useDocFileActions();

  const insertSnippet = useCallback((snippet: string) => {
    editorRef.current?.insertText(snippet);
  }, []);

  // PDF / EPUB readers and every `lumen-open-file` (W6.25).
  const { pdfView, setPdfView, epubView, setEpubView, registerPdfSaveGate } = useOpenFileEvent(handleOpenFromWorkspace);

  // Automations (W5.24): a lazy chunk that starts only when the vault has a rules file.
  useEffect(() => {
    const id = window.setTimeout(() => void import("./automations/app").then((m) => m.startAutomationsIfConfigured()).catch(() => undefined), 3000);
    return () => window.clearTimeout(id);
  }, []);

  // Today's daily note (plan 4.12): the command and ⌥⌘D. The daily-note code is its own chunk.
  useWindowEvent("lumen-open-today", () => {
    void import("./daily/dailyNote")
      .then((m) => {
        const s = useAppStore.getState();
        return m.openDailyNote(m.dayOf(new Date()), s.dailyNotes, s.locale);
      })
      .catch((e: unknown) => showAiToast(t("daily.failed", { error: explainError(e) }), "error"));
  });

  // ⌘K → "Set up Lumen…" (plan 14.1) reopens the first-run setup.
  useWindowEvent("lumen-open-setup", () => setSetupOpen(true));

  // Quick capture (plan 4.16): the command palette and the desktop
  // global shortcut (src/pwa/launch.ts) send this event.
  useWindowEvent("lumen-open-capture", () => setCaptureOpen(true));

  // Autosave: the open workspace file, files from disk, ad-hoc notes, and a flush on hide (W6.25).
  useAutosave({ handleSave, adoptIntoWorkspace });

  // Keyboard shortcuts (W6.25: src/hooks/useAppShortcuts.ts)
  useAppShortcuts({ editorRef, handleOpen, handleSave, handleNew, focusMode, setFocusMode, setPaletteOpen, setFindReplaceOpen, setShortcutsOpen, setCaptureOpen });

  const { dragHover } = useFileDragDrop(setDoc);

  const pageView = useAppStore((s) => s.pageView);

  // Debounce preview rendering — keeps typing smooth for large docs. The
  // document identity is deferred together with its text so the preview
  // never pairs one document's markdown with another's identity.
  const currentDocKey = docIdentity(doc);
  const previewSource = useMemo(
    // A `.base` file (Obsidian Bases, plan W1.11) previews as its views.
    () => ({ content: /\.base$/i.test(doc.name) ? baseAsMarkdown(doc.content) : doc.content, docKey: currentDocKey }),
    [doc.content, doc.name, currentDocKey],
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

  useCommandEvents(commands);
  useWindowEvent("lumen-open-ai-settings", () => setSettingsTab("ai"));
  useWindowEvent("lumen-open-settings", (e) => setSettingsTab((e as CustomEvent<{ tab?: SettingsTab }>).detail?.tab ?? "general"));
  useWindowEvent("lumen-open-privacy-ledger", () => setPrivacyOpen(true));
  // A saved search in the sidebar (plan W2.12) opens the dialog on its query.
  useWindowEvent("lumen-open-search", (e) => {
    const query = (e as CustomEvent<{ query?: string }>).detail?.query;
    (window as unknown as { __lumenSearchQuery?: string }).__lumenSearchQuery = typeof query === "string" ? query : undefined;
    setSearchOpen(true);
  });
  useWindowEvent("lumen-open-properties", () => setPropertiesOpen((v) => !v));
  // Properties panel and database view edits of the open note (4.9, 4.10).
  const applyPropertiesEdit = usePropertiesEdit(editorRef);
  // Allowed image hosts (plan W1.30), opened from the palette.
  const [imageHostsOpen, setImageHostsOpen] = useState(false);
  useWindowEvent("lumen-open-image-hosts", () => setImageHostsOpen(true));
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
  useWindowEvent("lumen-open-ai-doctor", () => setAiDoctorOpen(true));
  // Changes agents proposed (plan 5.11): the editor applies approved ones,
  // the status bar counts the waiting ones, a toast announces new ones.
  const agentReviewPending = useAgentReview(editorRef, openAgentReview);
  useWindowEvent("lumen-open-agent-review", openAgentReview);
  useWindowEvent("lumen-open-import", () => setImportOpen(true));

  // Comment-anchor click in the editor → window event from
  // commentDecorations.ts. Open the side panel + jump the panel
  // scroll to the matching thread (the panel itself listens for the
  // same event to highlight the right row).
  useWindowEvent("lumen-comment-focus", () => setCommentsPanelOpen(true));

  // Native Tauri menu wiring — no-op when running in a regular browser.
  // Plan W3.9: files from Finder / Explorer, lumen:// links, the tray, tabs between windows.
  const desktopShell = useDesktopShell({ editorRef, onNew: () => void handleNew(), showToast: (m) => showAiToast(m, "info") });
  useTauriMenu({
    onNew: handleNew,
    onOpen: handleOpen,
    onSave: handleSave,
    onInsertText: async () => {
      await insertTextFromDialog(doc.content, setContent, () => editorRef.current);
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
    onQuickCapture: () => setCaptureOpen(true),
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
        data-testid="sr-announcer-polite"
      />
      <Toolbar
        onOpen={handleOpen}
        onSave={handleSave}
        onNew={handleNew}
        onCommandPalette={() => setPaletteOpen(true)}
        onFocusMode={() => setFocusMode(true)}
        onShortcuts={() => setShortcutsOpen(true)}
        onTour={() => setTourOpen(true)}
        onShowWelcome={async () => {
          // Restore the bundled welcome document — handy when the user wants
          // to revisit the feature tour without scrubbing recents for it.
          const { welcomeDoc } = await import("./welcomeDoc");
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
          if (!(await insertTextFromDialog(doc.content, setContent, () => editorRef.current))) return;
          showAiToast(`✅ ${t("toast.insertText.success")}`, "info");
        }}
        onPasteText={async () => {
          const text = await uiPrompt({
            message: t("toast.pasteText.prompt"),
            placeholder: t("toast.pasteText.placeholder"),
          });
          if (!text) return;
          const md = text.trim().startsWith("<") ? (await import("./storage/fileFormats")).htmlToMarkdown(text) : text;
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
            onDragOut={desktopShell.onTabDragOut}
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
        {(narrow ? outlineSheet : showOutline) && <Outline markdownText={doc.content} sheet={narrow} />}
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
                /* why: the linking note was moved or deleted since the backlinks were listed; the click does nothing */
              }
            }}
          />
        )}
        {showLocalGraph && (
          <Suspense fallback={null}>
            <LocalGraphPanel
              filePath={doc.workspaceName ?? null}
              onOpen={async (path) => {
                try {
                  const content = await readWorkspaceFile(path);
                  setDoc({ name: path.split("/").pop() ?? path, content, handle: undefined, workspaceName: path, dirty: false });
                } catch {
                  /* why: missing file */
                }
              }}
            />
          </Suspense>
        )}
        {dragHover && <DropHint />}
      </main>
      <StatusBar
        text={doc.content}
        dirty={doc.dirty}
        filename={doc.name}
        configHealth={configHealth}
        onOpenRuntimeMetrics={() => setRuntimeMetricsOpen(true)}
        agentReviewPending={agentReviewPending}
        onOpenAgentReview={openAgentReview}
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
        initialQuery={searchQuery}
        onClose={() => {
          setSearchOpen(false);
          setSearchQuery("");
        }}
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
      <HelpHost />
      <FeatureFlagsHost />
      <AiSuggestionsPanel />
      <AiInlinePromptOverlay />
      <MobileKeyboardBarHost />
      {usabilityOpen && (
        <Suspense fallback={null}>
          {usabilityOpen === "unmoderated" ? <UsabilitySelfPanel onClose={() => setUsabilityOpen(null)} /> : <UsabilitySessionPanel onClose={() => setUsabilityOpen(null)} />}
        </Suspense>
      )}
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

      {/* PDF reader overlay (plan 4.14) */}
      {pdfView && (
        <Suspense fallback={null}>
          {/* A new PDF gets a fresh reader: no page, search or OCR state carries over. */}
          <PdfReader key={pdfView.path} path={pdfView.path} fragment={pdfView.fragment} openSeq={pdfView.seq} onClose={() => setPdfView(null)} registerSaveGate={registerPdfSaveGate} />
        </Suspense>
      )}

      {/* EPUB reader overlay (plan W1.14) */}
      {epubView && (
        <Suspense fallback={null}>
          <EpubReader key={epubView.path} path={epubView.path} fragment={epubView.fragment} openSeq={epubView.seq} onClose={() => setEpubView(null)} />
        </Suspense>
      )}

      {/* Graph View overlay */}
      {graphOpen && (
        <GraphOverlay
          onClose={() => setGraphOpen(false)}
          onOpenFile={(path, content) => {
            setDoc({ name: path.split("/").pop() ?? path, content, handle: undefined, workspaceName: path, dirty: false });
            setGraphOpen(false);
          }}
        />
      )}

      {/* Canvas Whiteboard overlay */}
      <Suspense fallback={null}>
        <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(var(--danger))' }}>{t("errorBoundary.heading")}</div>}>
          {canvasOpen && <CanvasWhiteboard open={canvasOpen} onClose={() => setCanvasOpen(false)} collab={collab} />}
          {galleryOpen && <PluginGallery open={galleryOpen} onClose={() => setGalleryOpen(false)} />}
          {templateGalleryOpen && <TemplateGallery open={templateGalleryOpen} onClose={() => setTemplateGalleryOpen(false)} />}
          {auditLogOpen && <AuditLog
            open={auditLogOpen}
            onClose={() => setAuditLogOpen(false)}
            // Scope = the signed-in user's organization (WorkOS SSO); free /
            // pro users have no org, so their own id is the scope.
            orgId={auditScope({ id: authUserId ?? "", orgId: authOrgId }) || "personal"}
          />}
          {settingsTab && <SettingsScreen key={settingsTab} tab={settingsTab} onClose={() => setSettingsTab(null)} onOpenAuditLog={() => { setSettingsTab(null); setAuditLogOpen(true); }} />}
          {aiDoctorOpen && <AiDoctorPanel open={aiDoctorOpen} onClose={() => setAiDoctorOpen(false)} />}
          {agentReviewOpen && <AgentReviewPanel open={agentReviewOpen} onClose={() => setAgentReviewOpen(false)} />}
          {privacyOpen && <PrivacyLedgerPanel open={privacyOpen} onClose={() => setPrivacyOpen(false)} />}
          {trashOpen && <TrashPanel open={trashOpen} onClose={() => setTrashOpen(false)} />}
          {importOpen && <ImportWizard open={importOpen} onClose={() => setImportOpen(false)} />}
          {propertiesOpen && <PropertiesPanel open={propertiesOpen} onClose={() => setPropertiesOpen(false)} text={doc.content} applyEdit={applyPropertiesEdit} />}
          {captureOpen && <QuickCapture open={captureOpen} voice={captureVoice} onClose={() => { setCaptureOpen(false); setCaptureVoice(false); }} />}
          {imageHostsOpen && <ImageHostsPanel open={imageHostsOpen} onClose={() => setImageHostsOpen(false)} />}
          {readingOpen && <ReadingSettings open={readingOpen} onClose={() => setReadingOpen(false)} notePath={doc.workspaceName ?? null} />}
        </ErrorBoundary>
      </Suspense>

      {/* Version History overlay */}
      {historyOpen && (
        <Suspense fallback={<div style={{padding:'2rem',color:'hsl(var(--fg-muted))'}}>{t("loading.generic")}</div>}>
          <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(var(--danger))' }}>{t("errorBoundary.heading")}</div>}>
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
          <ErrorBoundary fallback={<div style={{ padding: '2rem', color: 'hsl(var(--danger))' }}>{t("errorBoundary.heading")}</div>}>
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
      {shortcutsOpen && <Suspense fallback={null}><KeyboardShortcuts open={shortcutsOpen} onClose={() => setShortcutsOpen(false)} /></Suspense>}

      {/* First-run setup, then the tour */}
      {setupOpen && (
        <Suspense fallback={null}>
          <FirstRun
            onDone={(r) => {
              setSetupOpen(false);
              if (!r) return;
              const st = useAppStore.getState();
              st.openTab({ name: r.note.path, content: r.note.content, workspaceName: r.note.path });
              if (!st.showWorkspace) st.toggleWorkspace();
              setTourOpen(true);
            }}
          />
        </Suspense>
      )}
      {tourOpen && <Suspense fallback={null}><OnboardingTour
        open={tourOpen}
        onClose={() => {
          setTourOpen(false);
          try { localStorage.setItem("lumen-tour-done", "1"); } catch {
            /* why: storage denied — tour will simply replay next session */
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
      /></Suspense>}
      {runtimeMetricsOpen && (
        <Suspense fallback={null}><RuntimeMetricsPanel onClose={() => setRuntimeMetricsOpen(false)} /></Suspense>
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
