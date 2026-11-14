import { useMemo } from "react";
import type { Command } from "../ui/CommandPalette";
import { cmdIcons } from "../ui/CommandPalette";
import { tabIdOf, useAppStore } from "../store/useStore";
import { t, SUPPORTED_LOCALES, getLocale } from "../i18n";
import { getGitIdentity, setGitIdentity, setGitToken, cloneRepo, pullRepo, commitAndPush, gitStatusSummary } from "../sync/git";
import { getRecents, removeRecent } from "../storage/recent";
import type { RecentFile } from "../storage/recent";
import { BLOCK_SNIPPETS } from "../snippets";
import { uiAlert, uiConfirm, uiPrompt, uiSelect } from "../ui/PromptDialog";
import { generateAiCommitMessage } from "../ai/commands";
import { buildAiSettingsCommand, buildAiOutlineCommand } from "../ai/commands";
import type { CollabSession } from "../collab/yjs";
import { roomShareLink } from "../collab/roomUrl";
import { startVoiceRecording } from "../ui/VoiceDictation";
import { TEMPLATES } from "../editor/templates";
import { buildInstalledTemplateCommands, useInstalledTemplates } from "./installedTemplates";
import { log } from "../lib/logger";
import { AI_PROMPT_TEMPLATES, applyTemplate } from "../ai/multiLangPrompts";
import { getPluginCommands } from "../plugins/pluginSystem";
import { showAiToast } from "../ui/AiToast";
import { encryptDocument, decryptDocument, isEncrypted } from "../storage/encryption";
import { isOPFSAvailable, readWorkspaceFile } from "../storage/workspace";
import { relativeTime } from "../lib/relativeTime";
import { buildFormatCommands } from "../editor/formatCommands";
import { buildSuggestingCommands } from "../editor/suggestingCommands";
import { withAiQuota } from "../billing/aiQuota";
import { canPurchasePlans, manageBilling, upgradeTo } from "../billing/planActions";
import { detectIsMac } from "../ui/KeyboardShortcuts";
import { getSecret, setSecret } from "../lib/secretStore";
import { aiOperation, cancelAllAi, isAbort } from "../ai/aiAbort";


/** Run an AI call as a cancellable operation (Esc / "Cancel AI", T55). */
async function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const op = aiOperation();
  try {
    return await fn(op.signal);
  } finally {
    op.end();
  }
}

/** Save a clip into the library folder and open it (T34). Exported for tests. */
export async function saveClip(clip: { title: string; markdown: string }): Promise<void> {
  const { clipFileName, libraryDir } = await import("../research/clipper");
  const { writeWorkspaceFile, workspaceHasEntry, isOPFSAvailable } = await import("../storage/workspace");
  const name = clipFileName(clip.title);
  if (!isOPFSAvailable()) {
    // Nothing was written: open it as an unsaved (dirty) document in its own
    // tab, so closing the tab or the page warns instead of losing the clip.
    openTemplateDoc(name.replace(/\.md$/, ""), clip.markdown);
    return;
  }
  const dir = libraryDir(getLocale());
  let path = `${dir}/${name}`;
  for (let i = 2; await workspaceHasEntry(path); i++) path = `${dir}/${name.replace(/\.md$/, "")} (${i}).md`;
  await writeWorkspaceFile(path, clip.markdown);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  useAppStore.getState().openTab({ name: path.split("/").pop()!, content: clip.markdown, workspaceName: path });
  showAiToast(t("clip.saved", { path }), "success");
}

export interface UseCommandsOptions {
  handleNew: () => void;
  handleOpen: () => void;
  handleSave: (saveAs?: boolean) => void;
  handleExportHtml: () => void;
  handleSaveToWorkspace: () => void;
  insertSnippet: (snippet: string) => void;
  recents: RecentFile[];
  setRecents: (r: RecentFile[]) => void;
  handleReopenRecent: (r: RecentFile) => void;
  collab: CollabSession | null;
  handleStartCollab: (roomOverride?: string) => void;
  handleStopCollab: () => void;
  setSearchOpen: (open: boolean) => void;
  setFindReplaceOpen: (open: boolean) => void;
  setGraphOpen: (open: boolean) => void;
  setHistoryOpen: (open: boolean) => void;
  setTableEditorOpen: (open: boolean) => void;
  setCanvasOpen: (open: boolean) => void;
  setGalleryOpen: (open: boolean) => void;
  setTemplateGalleryOpen?: (open: boolean) => void;
  setAuditLogOpen?: (open: boolean) => void;
  setOrgSettingsOpen?: (open: boolean) => void;
  setTrustedKeysOpen?: (open: boolean) => void;
  setThemeSettingsOpen?: (open: boolean) => void;
  setFineTuneOpen?: (open: boolean) => void;
  setTagsPanelOpen?: (open: boolean) => void;
  setCommentsPanelOpen?: (open: boolean) => void;
  setRuntimeMetricsOpen?: (open: boolean) => void;
  onAddComment?: () => void;
  /** Mounted CodeMirror view (source/split mode) — used by the formatter. */
  getEditorView?: () => import("@codemirror/view").EditorView | null;
}

/**
 * Open a template as a NEW unsaved tab. Never writes into the active
 * document (that would overwrite its unsaved content), and never reuses an
 * open tab of the same name (that would ignore the template body):
 * "Meeting notes.md" → "Meeting notes 2.md" → …
 */
export function openTemplateDoc(base: string, content: string): void {
  openNewDoc(base, content, true);
}

/**
 * Open `content` as a new note in its own tab, under a name no open tab
 * uses ("Shared.md" → "Shared 2.md"), so it never lands on — and later
 * overwrites — an existing tab of that name. `dirty`: it holds unsaved
 * content (a template, a shared note), unlike an empty new document.
 */
export function openNewDoc(base: string, content: string, dirty: boolean): void {
  const st = useAppStore.getState();
  const currentId = tabIdOf(st.doc);
  if (st.doc.content && !st.openTabs.some((tab) => tab.id === currentId)) {
    // The active doc has no tab (e.g. after a rename): give it one first so
    // switching to the template can't drop it.
    useAppStore.setState((s) => ({
      openTabs: [
        ...s.openTabs,
        {
          id: currentId,
          name: s.doc.name,
          content: s.doc.content,
          workspaceName: s.doc.workspaceName ?? null,
          dirty: s.doc.dirty,
        },
      ],
    }));
  }
  const taken = new Set(useAppStore.getState().openTabs.map((tab) => tab.id));
  taken.add(currentId);
  let name = `${base}.md`;
  for (let i = 2; taken.has(tabIdOf({ workspaceName: null, name })); i++) name = `${base} ${i}.md`;
  useAppStore.getState().openTab({ name, content, workspaceName: null });
  if (dirty) useAppStore.getState().setDoc({ dirty: true });
}

/** Every Markdown note in the workspace, for Vault Doctor (null when there is none). */
async function loadDoctorNotes(): Promise<Array<{ path: string; text: string }> | null> {
  if (!isOPFSAvailable()) {
    showAiToast(t("doctor.noWorkspace"), "error");
    return null;
  }
  const { listWorkspace } = await import("../storage/workspace");
  const notes: Array<{ path: string; text: string }> = [];
  for (const f of await listWorkspace({ includeAssets: false })) {
    if (!/\.(md|markdown)$/i.test(f.path)) continue;
    try {
      notes.push({ path: f.path, text: await readWorkspaceFile(f.path) });
    } catch {
      // A missing note would look like a broken link target (and "fix"
      // links to it): stop rather than scan an incomplete workspace.
      showAiToast(t("doctor.readFailed", { path: f.path }), "error");
      return null;
    }
  }
  if (!notes.length) {
    showAiToast(t("doctor.noWorkspace"), "error");
    return null;
  }
  return notes;
}

export function useCommands({
  handleNew,
  handleOpen,
  handleSave,
  handleExportHtml,
  handleSaveToWorkspace,
  insertSnippet,
  recents,
  setRecents,
  handleReopenRecent,
  collab,
  handleStartCollab,
  handleStopCollab,
  setSearchOpen,
  setFindReplaceOpen,
  setGraphOpen,
  setHistoryOpen,
  setTableEditorOpen,
  setCanvasOpen,
  setGalleryOpen,
  setTemplateGalleryOpen,
  setAuditLogOpen,
  setOrgSettingsOpen,
  setTrustedKeysOpen,
  setThemeSettingsOpen,
  setFineTuneOpen,
  setTagsPanelOpen,
  setCommentsPanelOpen,
  setRuntimeMetricsOpen,
  onAddComment,
  getEditorView,
}: UseCommandsOptions) {
  const doc = useAppStore((s) => s.doc);
  const theme = useAppStore((s) => s.theme);
  const showWorkspace = useAppStore((s) => s.showWorkspace);
  const locale = useAppStore((s) => s.locale);
  const rtl = useAppStore((s) => s.rtl);
  const autoSave = useAppStore((s) => s.autoSave);
  const autoSaveInterval = useAppStore((s) => s.autoSaveInterval);
  const vimEnabled = useAppStore((s) => s.vimEnabled);
  const spellCheck = useAppStore((s) => s.spellCheck);
  const useLocalAi = useAppStore((s) => s.useLocalAi);
  const typewriterMode = useAppStore((s) => s.typewriterMode);
  const writingGoalWords = useAppStore((s) => s.writingGoalWords);
  const pageView = useAppStore((s) => s.pageView);
  
  const toggleRtl = useAppStore((s) => s.toggleRtl);
  const setContent = useAppStore((s) => s.setContent);
  const setDoc = useAppStore((s) => s.setDoc);
  const setLocale = useAppStore((s) => s.setLocale);
  const toggleWorkspace = useAppStore((s) => s.toggleWorkspace);
  const toggleBacklinks = useAppStore((s) => s.toggleBacklinks);
  const toggleVim = useAppStore((s) => s.toggleVim);
  const toggleSpellCheck = useAppStore((s) => s.toggleSpellCheck);
  const toggleLocalAi = useAppStore((s) => s.toggleLocalAi);
  const toggleTypewriter = useAppStore((s) => s.toggleTypewriter);
  const tsChecks = useAppStore((s) => s.tsChecks);
  const toggleTsChecks = useAppStore((s) => s.toggleTsChecks);
  const grammarCheck = useAppStore((s) => s.grammarCheck);
  const toggleGrammarCheck = useAppStore((s) => s.toggleGrammarCheck);
  const suggestingMode = useAppStore((s) => s.suggestingMode);
  const toggleSuggestingMode = useAppStore((s) => s.toggleSuggestingMode);
  const setWritingGoal = useAppStore((s) => s.setWritingGoal);
  const toggleAutoSave = useAppStore((s) => s.toggleAutoSave);
  const installedTemplates = useInstalledTemplates();

    return useMemo<Command[]>(() => {
    // Actions read the document when they run, not when the list was built:
    // the command list no longer rebuilds on every keystroke (C5).
    const liveDoc = () => useAppStore.getState().doc;
    const setMode = useAppStore.getState().setMode;
    const setTheme = useAppStore.getState().setTheme;
    const toggleOutline = useAppStore.getState().toggleOutline;
    const isDark = theme === "dark";

    const recentCmds: Command[] = recents.slice(0, 8).flatMap((r) => [
      {
        id: `recent.${r.id}`,
        label: t("cmd.file.openRecent", { name: r.name }),
        hint: relativeTime(r.openedAt),
        icon: cmdIcons.FolderOpen,
        group: t("group.recent"),
        action: () => handleReopenRecent(r),
      },
      {
        id: `recent.remove.${r.id}`,
        label: t("cmd.file.removeRecent", { name: r.name }),
        icon: cmdIcons.FolderOpen,
        group: t("group.recent"),
        action: async () => {
          await removeRecent(r.id);
          setRecents(await getRecents());
        },
      },
    ]);

    // AI-prompt commands are wrapped with the monthly quota check.
    return withAiQuota([
      ...recentCmds,
      {
        id: "file.new",
        label: t("cmd.file.new"),
        shortcut: "⌘N",
        icon: cmdIcons.FileText,
        group: t("group.file"),
        action: handleNew,
      },
      {
        id: "file.open",
        label: t("cmd.file.open"),
        shortcut: "⌘O",
        icon: cmdIcons.FolderOpen,
        group: t("group.file"),
        action: handleOpen,
      },
      {
        id: "file.save",
        label: t("cmd.file.save"),
        shortcut: "⌘S",
        icon: cmdIcons.Save,
        group: t("group.file"),
        action: () => handleSave(false),
      },
      {
        id: "file.saveAs",
        label: t("cmd.file.saveAs"),
        shortcut: "⇧⌘S",
        icon: cmdIcons.Save,
        group: t("group.file"),
        action: () => handleSave(true),
      },
      {
        id: "file.exportHtml",
        label: t("cmd.file.exportHtml"),
        hint: t("cmd.file.exportHtml.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: handleExportHtml,
      },
      {
        id: "file.exportDocx",
        label: t("cmd.file.exportDocx") ?? "Export to Word (.doc)",
        hint: t("cmd.file.exportDocx.hint") ?? "Download as Word document",
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { exportToDocx } = await import("../storage/exportDocx");
          await exportToDocx(doc.content, doc.name);
        },
      },
      {
        id: "file.exportRtf",
        label: t("cmd.file.exportRtf"),
        hint: t("cmd.file.exportRtf.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToRtf, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.rtf`, markdownToRtf(doc.content), "application/rtf");
        },
      },
      {
        id: "file.exportLatex",
        label: t("cmd.file.exportLatex"),
        hint: t("cmd.file.exportLatex.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToLatex, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.tex`, markdownToLatex(doc.content), "application/x-latex");
        },
      },
      {
        id: "file.exportRst",
        label: t("cmd.file.exportRst"),
        hint: t("cmd.file.exportRst.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToRst, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.rst`, markdownToRst(doc.content), "text/x-rst");
        },
      },
      {
        id: "file.exportAdoc",
        label: t("cmd.file.exportAdoc"),
        hint: t("cmd.file.exportAdoc.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToAdoc, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.adoc`, markdownToAdoc(doc.content), "text/asciidoc");
        },
      },
      {
        id: "file.exportOrg",
        label: t("cmd.file.exportOrg"),
        hint: t("cmd.file.exportOrg.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToOrg, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.org`, markdownToOrg(doc.content), "text/x-org");
        },
      },
      {
        id: "file.exportOpml",
        label: t("cmd.file.exportOpml"),
        hint: t("cmd.file.exportOpml.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToOpml, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.opml`, markdownToOpml(doc.content, baseName), "text/x-opml");
        },
      },
      {
        id: "file.exportReveal",
        label: t("cmd.file.exportReveal"),
        hint: t("cmd.file.exportReveal.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToRevealHtml, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(
            `${baseName}.slides.html`,
            markdownToRevealHtml(doc.content, baseName),
            "text/html",
          );
        },
      },
      {
        id: "file.exportEpub",
        label: t("cmd.file.exportEpub"),
        hint: t("cmd.file.exportEpub.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToEpubBytes, downloadBytes } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          const bytes = await markdownToEpubBytes(doc.content, baseName);
          downloadBytes(`${baseName}.epub`, bytes, "application/epub+zip");
        },
      },
      {
        id: "file.exportIpynb",
        label: t("cmd.file.exportIpynb"),
        hint: t("cmd.file.exportIpynb.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToIpynb, downloadText } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          downloadText(`${baseName}.ipynb`, markdownToIpynb(doc.content), "application/x-ipynb+json");
        },
      },
      {
        id: "file.exportSite",
        label: t("cmd.file.exportSite"),
        hint: t("cmd.file.exportSite.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToStaticSiteBytes, downloadBytes } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          const bytes = await markdownToStaticSiteBytes(doc.content, baseName);
          downloadBytes(`${baseName}-site.zip`, bytes, "application/zip");
        },
      },
      {
        id: "file.exportPptx",
        label: t("cmd.file.exportPptx"),
        hint: t("cmd.file.exportPptx.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { markdownToPptxBytes, PPTX_MIME } = await import("../storage/exportPptx");
          const { downloadBytes } = await import("../storage/exportFormats");
          const baseName = doc.name.replace(/\.[^.]+$/, "");
          const bytes = await markdownToPptxBytes(doc.content, baseName);
          downloadBytes(`${baseName}.pptx`, bytes, PPTX_MIME);
        },
      },
      {
        id: "file.exportPdf",
        label: t("cmd.file.exportPdf"),
        hint: t("cmd.file.exportPdf.hint"),
        icon: cmdIcons.Download,
        group: t("group.file"),
        action: async () => {
          // Snapshot before any await: a tab switch while the chunk loads must not export another note.
          const doc = liveDoc();
          const { printDocument } = await import("../ui/PrintExport");
          await printDocument(doc.content, doc.name);
        },
      },
      {
        id: "file.print",
        label: t("cmd.file.print"),
        hint: t("cmd.file.print.hint"),
        shortcut: "⌘P",
        icon: cmdIcons.Printer,
        group: t("group.file"),
        action: () => {
          // Make sure preview is visible before printing.
          useAppStore.getState().setMode("preview");
          setTimeout(() => window.print(), 50);
        },
      },
      {
        id: "view.source",
        label: t("cmd.view.source"),
        shortcut: "⌘1",
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: () => setMode("source"),
      },
      {
        id: "view.split",
        label: t("cmd.view.split"),
        shortcut: "⌘2",
        icon: cmdIcons.Columns2,
        group: t("group.view"),
        action: () => setMode("split"),
      },
      {
        id: "view.preview",
        label: t("cmd.view.preview"),
        shortcut: "⌘3",
        icon: cmdIcons.Eye,
        group: t("group.view"),
        action: () => setMode("preview"),
      },
      {
        id: "view.wysiwyg",
        label: t("cmd.view.wysiwyg"),
        hint: t("cmd.view.wysiwyg.hint"),
        shortcut: "⌘4",
        icon: cmdIcons.Sparkles,
        group: t("group.view"),
        action: () => setMode("wysiwyg"),
      },
      {
        id: "view.outline",
        label: t("cmd.view.outline"),
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: toggleOutline,
      },
      {
        id: "view.pageView",
        label: t("cmd.view.pageView"),
        hint: pageView ? t("cmd.view.pageView.on") : t("cmd.view.pageView.off"),
        icon: cmdIcons.FileText,
        group: t("group.view"),
        action: () => useAppStore.getState().togglePageView(),
      },
      {
        id: "view.workspace",
        label: t("cmd.view.workspace"),
        hint: t("cmd.view.workspace.hint"),
        icon: cmdIcons.FolderOpen,
        group: t("group.view"),
        action: toggleWorkspace,
      },
      {
        id: "view.backlinks",
        label: t("cmd.view.backlinks"),
        hint: t("cmd.view.backlinks.hint"),
        icon: cmdIcons.Link,
        group: t("group.view"),
        action: toggleBacklinks,
      },
      {
        id: "view.search",
        label: t("cmd.view.search"),
        shortcut: "⇧⌘F",
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: () => setSearchOpen(true),
      },
      {
        id: "view.smartSearch",
        label: t("cmd.view.smartSearch"),
        hint: t("cmd.view.smartSearch.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.view"),
        action: () => {
          (window as unknown as { __lumenSearchMode?: string }).__lumenSearchMode = "smart";
          setSearchOpen(true);
        },
      },
      ...(setRuntimeMetricsOpen
        ? [
            {
              id: "view.runtimeMetrics",
              label: t("cmd.view.runtimeMetrics"),
              hint: t("cmd.view.runtimeMetrics.hint"),
              icon: cmdIcons.BarChart3,
              group: t("group.view"),
              action: () => setRuntimeMetricsOpen(true),
            },
          ]
        : []),
      {
        id: "view.vim",
        label: vimEnabled ? t("cmd.view.vim.off") : t("cmd.view.vim.on"),
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleVim,
      },
      {
        id: "view.spellCheck",
        label: spellCheck
          ? t("cmd.view.spellCheck.off")
          : t("cmd.view.spellCheck.on"),
        hint: t("cmd.view.spellCheck.hint"),
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleSpellCheck,
      },
      {
        id: "view.typewriter",
        label: typewriterMode
          ? t("cmd.view.typewriter.off")
          : t("cmd.view.typewriter.on"),
        hint: t("cmd.view.typewriter.hint"),
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleTypewriter,
      },
      {
        id: "view.tsChecks",
        label: tsChecks ? t("cmd.view.tsChecks.off") : t("cmd.view.tsChecks.on"),
        hint: t("cmd.view.tsChecks.hint"),
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleTsChecks,
      },
      {
        id: "view.grammarCheck",
        label: grammarCheck
          ? t("cmd.view.grammarCheck.off") ?? "Disable grammar check"
          : t("cmd.view.grammarCheck.on") ?? "Enable grammar check (LanguageTool)",
        hint:
          t("cmd.view.grammarCheck.hint") ??
          "Underlines grammar / style / typo issues. Calls LanguageTool — set VITE_LANGUAGETOOL_URL to self-host.",
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleGrammarCheck,
      },
      {
        id: "tools.writingGoal",
        label: writingGoalWords > 0
          ? t("cmd.tools.writingGoal.set", { words: writingGoalWords })
          : t("cmd.tools.writingGoal.unset"),
        hint: t("cmd.tools.writingGoal.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const ans = await uiPrompt({
            message: "Daily writing goal in words (0 to disable):",
            defaultValue: String(writingGoalWords || 500),
          });
          if (ans === null) return;
          setWritingGoal(Number(ans) || 0);
        },
      },
      {
        id: "ai.localToggle",
        label: useLocalAi
          ? (t("cmd.ai.privacy.off") ?? "Privacy Mode: turn off (use cloud AI)")
          : (t("cmd.ai.privacy.on") ?? "Privacy Mode: run AI on this device (WebGPU)"),
        hint:
          t("cmd.ai.privacy.hint") ??
          "When ON, every AI prompt runs locally via @mlc-ai/web-llm. No data leaves your browser.",
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          if (!useLocalAi) {
            // Going Local — verify WebGPU support before flipping.
            const { localLlmAvailable } = await import("../ai/localLlm");
            const status = localLlmAvailable();
            if (!status.available) {
              showAiToast(t("toast.privacyModeUnavailableFallsBack", { reason: status.reason ?? "" }),
                "error",
              );
              return;
            }
            showAiToast(t("toast.privacyModeOnTheFirst"),
              "info",
            );
          } else {
            showAiToast(t("toast.privacyModeOffSwitchedBack"), "info");
          }
          toggleLocalAi();
        },
      },
      {
        id: "tools.vaultDoctor",
        label: t("cmd.tools.vaultDoctor"),
        hint: t("cmd.tools.vaultDoctor.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const notes = await loadDoctorNotes();
          if (!notes) return;
          showAiToast(t("doctor.checking", { count: notes.length }), "info");
          const { runVaultDoctor, formatDoctorReport } = await import("../lint/vaultDoctor");
          const findings = runVaultDoctor(notes);
          openTemplateDoc("Vault Doctor report", formatDoctorReport(findings, notes.length));
          showAiToast(t("doctor.done", { count: findings.length }), findings.length ? "info" : "success");
        },
      },
      {
        id: "tools.vaultDoctorFix",
        label: t("cmd.tools.vaultDoctorFix"),
        hint: t("cmd.tools.vaultDoctorFix.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const notes = await loadDoctorNotes();
          if (!notes) return;
          const { runVaultDoctor, applyLinkFixes } = await import("../lint/vaultDoctor");
          // Notes open in a tab may hold unsaved edits: never rewrite them.
          const open = new Set(useAppStore.getState().openTabs.map((tab) => tab.workspaceName).filter(Boolean));
          const current = useAppStore.getState().doc.workspaceName;
          if (current) open.add(current);
          const byFile = new Map<string, Array<{ from: string; to: string }>>();
          for (const f of runVaultDoctor(notes)) {
            if (f.kind !== "broken-wiki-link" || !f.suggestion || !f.detail || open.has(f.path)) continue;
            byFile.set(f.path, [...(byFile.get(f.path) ?? []), { from: f.detail, to: f.suggestion }]);
          }
          const links = [...byFile.values()].reduce((n, l) => n + l.length, 0);
          if (!links) {
            showAiToast(t("doctor.noFixes"), "info");
            return;
          }
          const list = [...byFile]
            .flatMap(([path, fixes]) => fixes.map((x) => `${path}: [[${x.from}]] → [[${x.to}]]`))
            .slice(0, 15)
            .join("\n");
          const ok = await uiConfirm({ message: t("doctor.confirmFix", { links, files: byFile.size, list }) });
          if (!ok) return;
          const { writeWorkspaceFile } = await import("../storage/workspace");
          for (const [path, fixes] of byFile) {
            const note = notes.find((n) => n.path === path)!;
            await writeWorkspaceFile(path, applyLinkFixes(note.text, fixes));
          }
          // Backlinks, tags, file tree and database views refresh on this.
          window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
          showAiToast(t("doctor.fixed", { links, files: byFile.size }), "success");
        },
      },
      {
        id: "tools.autoTag",
        label: t("cmd.tools.autoTag"),
        hint: t("cmd.tools.autoTag.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          try {
            showAiToast(t("toast.suggestingTags"), "info");
            const { suggestTags, mergeTagsIntoFrontmatter } = await import("../agents/commands");
            const tags = await cancellable((signal) => suggestTags(liveDoc().content, signal));
            if (tags.length === 0) {
              showAiToast(t("toast.noTagSuggestionsReturned"), "info");
              return;
            }
            const accept = await uiPrompt({
              message: `Suggested tags:\n  ${tags.join(", ")}\n\nPress OK to merge into frontmatter, or edit the list (comma-separated):`,
              defaultValue: tags.join(", "),
            });
            if (accept === null) return;
            const final = accept
              .split(/[,\s]+/)
              .map((s) => s.trim().toLowerCase())
              .filter((s) => s.length > 1);
            if (final.length === 0) return;
            setContent(mergeTagsIntoFrontmatter(liveDoc().content, final));
            showAiToast(t("toast.addedTag", { count: final.length }), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "tools.autoTag")) return;
            showAiToast(t("toast.autoTagFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "tools.suggestLinks",
        label: t("cmd.tools.suggestLinks"),
        hint: t("cmd.tools.suggestLinks.hint"),
        icon: cmdIcons.Link,
        group: t("group.tools"),
        action: async () => {
          if (!liveDoc().workspaceName) {
            await uiAlert({ message: "Open the file from your workspace first — the link agent reads neighboring notes." });
            return;
          }
          try {
            showAiToast(t("toast.scanningWorkspaceForLinkSuggestions"), "info");
            const { suggestLinks, applyLinkSuggestion } = await import("../agents/commands");
            const suggestions = await cancellable((signal) => suggestLinks(liveDoc().workspaceName!, liveDoc().content, signal));
            if (suggestions.length === 0) {
              showAiToast(t("toast.noLinkSuggestions"), "info");
              return;
            }
            const summary = suggestions
              .map((s, i) => `${i + 1}. "${s.phrase}" → [[${s.target}]] · ${s.reason}`)
              .join("\n");
            const accept = await uiPrompt({
              message: `Found ${suggestions.length} link suggestions:\n\n${summary}\n\nApply all? (Type 'no' to skip)`,
              defaultValue: "yes",
            });
            if (!accept || accept.toLowerCase().startsWith("n")) return;
            let next = liveDoc().content;
            let applied = 0;
            for (const s of suggestions) {
              const updated = applyLinkSuggestion(next, s);
              if (updated !== next) {
                applied++;
                next = updated;
              }
            }
            setContent(next);
            showAiToast(t("toast.appliedLink", { count: applied }), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "tools.suggestLinks")) return;
            showAiToast(t("toast.linkSuggestFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.productAgent",
        label: t("cmd.ai.productAgent", { defaultValue: "AI: Create Product" }),
        hint: t("cmd.ai.productAgent.hint", { defaultValue: "Generate a complete project from a description" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const idea = await uiPrompt({
            message: "Describe the product you want to create:\n(e.g., 'A todo app with drag-and-drop, dark mode, and local storage')",
          });
          if (!idea) return;
          try {
            showAiToast(t("toast.productAgentStarting"), "info");
            const { createProduct } = await import("../ai/productAgent");
            const result = await cancellable((signal) =>
              createProduct(
                idea,
                (progress) => {
                  showAiToast(`${progress.phase}: ${progress.message}`, "info");
                },
                signal,
              ),
            );
            if (result.success) {
              showAiToast(t("toast.productCreatedFilesGenerated", { count: result.files.size }), "success");
              const summary = `# Product Created\n\n${result.files.size} files generated:\n\n${[...result.files.keys()].map((f) => `- \`${f}\``).join("\n")}`;
              setContent(summary);
            } else {
              showAiToast(t("toast.productCreationFailed", { error: result.error ?? "" }), "error");
            }
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.productAgent")) return;
            showAiToast(t("toast.agentError", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.diagram",
        label: t("cmd.ai.diagram", { defaultValue: "AI: Diagram from Text" }),
        hint: t("cmd.ai.diagram.hint", { defaultValue: "Generate a Mermaid diagram from the document" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          try {
            showAiToast(t("toast.generatingDiagram"), "info");
            const { generateDiagram } = await import("../agents/commands");
            const block = await cancellable((signal) => generateDiagram(liveDoc().content, signal));
            setContent(`${liveDoc().content.trimEnd()}\n\n${block}\n`);
            showAiToast(t("toast.diagramInserted"), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.diagram")) return;
            showAiToast(t("toast.diagramFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.actionItems",
        label: t("cmd.ai.actionItems", { defaultValue: "AI: Extract Action Items" }),
        hint: t("cmd.ai.actionItems.hint", { defaultValue: "Pull a task list out of meeting notes" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          try {
            showAiToast(t("toast.extractingActionItems"), "info");
            const { extractActionItems } = await import("../agents/commands");
            const list = await cancellable((signal) => extractActionItems(liveDoc().content, signal));
            setContent(`${liveDoc().content.trimEnd()}\n\n## Action Items\n\n${list}\n`);
            showAiToast(t("toast.actionItemsAdded"), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.actionItems")) return;
            showAiToast(t("toast.actionItemsFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.translate",
        label: t("cmd.ai.translate", { defaultValue: "AI: Translate Document" }),
        hint: t("cmd.ai.translate.hint", { defaultValue: "Translate the whole document, preserving formatting" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const target = await uiPrompt({
            message: "Translate the document into which language?\n(e.g. Spanish, עברית, 日本語, Français)",
            defaultValue: "",
          });
          if (!target || !target.trim()) return;
          try {
            showAiToast(t("toast.translatingTo", { target }), "info");
            const { translateMarkdown } = await import("../agents/commands");
            const translated = await cancellable((signal) => translateMarkdown(liveDoc().content, target.trim(), signal));
            setContent(translated);
            showAiToast(t("toast.documentTranslated"), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.translate")) return;
            showAiToast(t("toast.translationFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.chart",
        label: t("cmd.ai.chart", { defaultValue: "AI: Chart from Data" }),
        hint: t("cmd.ai.chart.hint", { defaultValue: "Turn CSV or table data into an ECharts chart" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          try {
            showAiToast(t("toast.generatingChart"), "info");
            const { generateChart } = await import("../agents/commands");
            const block = await cancellable((signal) => generateChart(liveDoc().content, signal));
            setContent(`${liveDoc().content.trimEnd()}\n\n${block}\n`);
            showAiToast(t("toast.chartInserted"), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.chart")) return;
            showAiToast(t("toast.chartFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "ai.ollamaModels",
        label: t("cmd.ai.ollama", { defaultValue: "AI: Ollama Models" }),
        hint: t("cmd.ai.ollama.hint", { defaultValue: "Switch to a local Ollama model" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { listOllamaModels, isOllamaAvailable, setOllamaConfig } = await import("../ai/ollamaProvider");
          const { setActiveProvider } = await import("../ai/llm");
          if (!(await isOllamaAvailable())) {
            await uiAlert({ message: "Ollama is not running.\n\nStart it with: ollama serve\nThen try again." });
            return;
          }
          const models = await listOllamaModels();
          if (models.length === 0) {
            await uiAlert({ message: "No models found.\n\nPull a model with: ollama pull llama3.1" });
            return;
          }
          const modelList = models.map((m) => `${m.name} (${(m.size / 1e9).toFixed(1)}GB)`).join("\n");
          const choice = await uiPrompt({
            message: `Available Ollama models:\n\n${modelList}\n\nType the model name to use:`,
            defaultValue: models[0].name,
          });
          if (!choice) return;
          setOllamaConfig({ model: choice.trim() });
          setActiveProvider("ollama");
          showAiToast(t("toast.switchedToOllama", { model: choice.trim() }), "success");
        },
      },
      {
        id: "ai.usage",
        label: t("cmd.ai.usage"),
        hint: t("cmd.ai.usage.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { usageSummary, formatUsageReport } = await import("../ai/usage");
          await uiAlert({ title: t("ai.usage.title"), message: formatUsageReport(usageSummary()) });
        },
      },
      {
        id: "research.ask",
        label: t("cmd.research.ask"),
        hint: t("cmd.research.ask.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          const question = await uiPrompt({ message: t("research.question"), defaultValue: "" });
          if (!question?.trim()) return;
          try {
            const { runResearch, researchGoesOnline, hasWebConsent, grantWebConsent } = await import("../research/agent");
            // T34: the first web research asks once; only the query is sent.
            if (researchGoesOnline() && !hasWebConsent()) {
              const ok = await uiConfirm({ title: t("research.consent.title"), message: t("research.consent.body"), okLabel: t("research.consent.ok") });
              if (!ok) return;
              grantWebConsent();
            }
            const result = await cancellable((signal) => runResearch({ question: question.trim(), signal, onProgress: (m) => showAiToast(m, "info") }));
            openTemplateDoc(`Research — ${question.trim().slice(0, 60).replace(/[\\/:*?"<>|]+/g, " ")}`, result.markdown);
            showAiToast(t("research.done", { sources: result.sources }), "success");
            if (result.unverified) showAiToast(t("research.unverified", { count: result.unverified }), "error");
          } catch (e) {
            if (isAbort(e)) return;
            showAiToast(t("research.failed", { message: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "clip.url",
        label: t("cmd.clip.url"),
        hint: t("cmd.clip.url.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const url = await uiPrompt({ message: t("clip.url.prompt"), defaultValue: "https://" });
          if (!url || !/^https?:\/\/\S+$/.test(url.trim())) return;
          try {
            const { clipUrl } = await import("../research/clipper");
            await saveClip(await clipUrl(url.trim()));
          } catch (e) {
            if ((e as Error)?.name === "ResearchUnavailableError") showAiToast(t("clip.needsService"), "error");
            else showAiToast(t("clip.failed", { message: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "clip.clipboard",
        label: t("cmd.clip.clipboard"),
        hint: t("cmd.clip.clipboard.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          try {
            const { clipFromHtml } = await import("../research/clipper");
            let html = "";
            let text = "";
            for (const item of await navigator.clipboard.read()) {
              if (item.types.includes("text/html")) html = await (await item.getType("text/html")).text();
              else if (item.types.includes("text/plain")) text = await (await item.getType("text/plain")).text();
            }
            if (!html && !text) {
              showAiToast(t("clip.empty"), "info");
              return;
            }
            const source = (await uiPrompt({ message: t("clip.source.prompt"), defaultValue: "https://" }))?.trim() || t("clip.source.unknown");
            await saveClip(clipFromHtml(html || `<pre>${text.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</pre>`, source));
          } catch (e) {
            showAiToast(t("clip.failed", { message: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "research.verify",
        label: t("cmd.research.verify"),
        hint: t("cmd.research.verify.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          const { parseCitations, verifyCitations, formatCitationReport } = await import("../research/citations");
          const { extractPage, researchEndpoint } = await import("../research/client");
          const citations = parseCitations(liveDoc().content);
          if (!citations.length) {
            showAiToast(t("research.noCitations"), "info");
            return;
          }
          if (!researchEndpoint()) {
            showAiToast(t("research.noService"), "error");
            return;
          }
          const checks = await verifyCitations(citations, (u) => extractPage(u), {
            onProgress: (done, total) => {
              if (done === total || done % 5 === 0) showAiToast(t("research.checking", { done, total }), "info");
            },
          });
          // A tab name, not a path: the note's base name only.
          const base = (liveDoc().name.split("/").pop() ?? liveDoc().name).replace(/\.(md|markdown)$/i, "");
          openTemplateDoc(`Citation check — ${base}`, formatCitationReport(base, checks));
        },
      },
      {
        id: "research.settings",
        label: t("cmd.research.settings"),
        hint: t("cmd.research.settings.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          const { getResearchSettings, setResearchSettings, researchEndpoint } = await import("../research/client");
          const cur = getResearchSettings();
          const choice = await uiSelect({
            title: t("cmd.research.settings"),
            message: t("cmd.research.settings.hint"),
            defaultValue: cur.provider,
            choices: [
              { value: "claude", label: t("research.provider.claude") },
              { value: "brave", label: t("research.provider.brave") },
              { value: "tavily", label: t("research.provider.tavily") },
              { value: "searxng", label: t("research.provider.searxng") },
            ],
          });
          if (choice !== "claude" && choice !== "brave" && choice !== "tavily" && choice !== "searxng") return;
          if (choice === "searxng") {
            // Keyless: the research service on this machine queries a local SearXNG.
            const endpoint = await uiPrompt({ message: t("research.endpoint"), defaultValue: researchEndpoint() ?? "http://localhost:8787" });
            if (endpoint === null || !endpoint.trim()) return;
            // Checked before it is stored: a bad override would hide a
            // working build-time endpoint.
            const { usableResearchEndpoint } = await import("../research/client");
            const usable = usableResearchEndpoint(endpoint);
            if (!usable) {
              showAiToast(t("research.endpointInvalid", { url: endpoint.trim() }), "error");
              return;
            }
            try {
              localStorage.setItem("lumen.research.endpoint", usable);
            } catch {
              /* storage denied */
            }
            setResearchSettings({ provider: "searxng" });
          } else if (choice !== "claude") {
            // Brave / Tavily go through the research service: without it the
            // choice can't work, so keep the current setting.
            if (!researchEndpoint()) {
              showAiToast(t("research.noService"), "error");
              return;
            }
            const key = await uiPrompt({ message: t("research.key", { provider: choice === "brave" ? "Brave Search" : "Tavily" }), defaultValue: cur.provider === choice ? cur.key : "" });
            // Cancelled (or no key): keep the previous provider and key.
            if (key === null || !key.trim()) return;
            setResearchSettings({ provider: choice, key: key.trim() });
          } else setResearchSettings({ provider: choice });
          showAiToast(t(`research.provider.${choice}`), "success");
        },
      },
      {
        id: "ai.batch",
        label: t("cmd.ai.batch"),
        hint: t("cmd.ai.batch.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const batch = await import("../ai/batch");
          const { getActiveProvider, effectiveModel } = await import("../ai/llm");
          const provider = batch.batchProviderFor(getActiveProvider());
          if (!provider) {
            showAiToast(t("batch.provider"), "error");
            return;
          }
          const op = await uiSelect({
            title: t("cmd.ai.batch"),
            message: t("batch.op"),
            defaultValue: "tags",
            choices: [
              { value: "tags", label: t("batch.op.tags") },
              { value: "summary", label: t("batch.op.summary") },
              { value: "translate", label: t("batch.op.translate") },
            ],
          });
          if (op !== "tags" && op !== "summary" && op !== "translate") return;
          let lang: string | undefined;
          if (op === "translate") {
            lang = (await uiPrompt({ message: t("batch.lang"), defaultValue: "English" }))?.trim();
            if (!lang) return;
          }
          const folder = await uiPrompt({ message: t("batch.folder"), defaultValue: "" });
          if (folder === null) return;
          const prefix = folder.trim().replace(/^\/+|\/+$/g, "");
          const { readAllNotes } = await import("../storage/workspaceNotes");
          const all = await readAllNotes();
          // Skip translations earlier batches created (by their
          // `translatedFrom` marker, or the older recorded paths — not by
          // file-name shape) so a re-run doesn't translate them.
          const made = batch.knownTranslations();
          const notes = all.filter(
            (n) => (!prefix || n.path.startsWith(prefix + "/")) && !(op === "translate" && (made.has(n.path) || batch.isBatchTranslation(n.text))),
          );
          if (!notes.length) {
            showAiToast(t("batch.noNotes"), "error");
            return;
          }
          const { aiQuotaStatus, recordAiPrompt } = await import("../billing/aiQuota");
          const quota = aiQuotaStatus();
          if (Number.isFinite(quota.limit) && quota.remaining < notes.length) {
            showAiToast(t("batch.quota", { count: notes.length }), "error");
            return;
          }
          const { estimateTokens, costOf } = await import("../ai/usage");
          // A local job runs on Ollama or the in-browser model only; show the model that will actually answer.
          let model: string;
          if (provider === "local") {
            const route = await batch.localBatchRoute();
            if (!route) {
              showAiToast(new batch.NoLocalModelError().message, "error");
              return;
            }
            model = route.model;
          } else model = effectiveModel(provider);
          let input = 0;
          let output = 0;
          for (const n of notes) {
            const r = batch.requestFor(op, n.text, lang);
            input += estimateTokens(r.system + r.user);
            // A translation is about as long as the (possibly truncated) text sent.
            output += op === "translate" ? Math.min(r.maxTokens, estimateTokens(r.user)) : r.maxTokens / 2;
          }
          const usd = provider === "local" ? 0 : costOf({ provider, model, inputTokens: input, outputTokens: output, batch: true });
          const ok = await uiConfirm({
            message:
              provider === "local"
                ? t("batch.confirmLocal", { count: notes.length, model })
                : t("batch.confirm", { count: notes.length, provider, model, cost: usd === null ? "?" : `~$${usd.toFixed(2)}` }),
          });
          if (!ok) return;
          try {
            const job = await batch.submitBatch(op, notes, { lang });
            if (Number.isFinite(quota.limit)) for (let i = 0; i < notes.length; i++) recordAiPrompt();
            showAiToast(t("batch.submitted", { count: job.items.length }), "success");
          } catch (e) {
            showAiToast((e as Error).message, "error");
          }
        },
      },
      {
        id: "ai.batchCheck",
        label: t("cmd.ai.batchCheck"),
        hint: t("cmd.ai.batchCheck.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const batch = await import("../ai/batch");
          const jobs = batch.loadJobs();
          const pending = jobs.filter((j) => j.status === "submitted" || j.status === "ended");
          if (!pending.length) {
            showAiToast(t("batch.none"), "info");
            return;
          }
          const { writeWorkspaceFile } = await import("../storage/workspace");
          let processing = 0;
          let wroteAny = false;
          for (const job of pending) {
            let results;
            try {
              results = await batch.fetchBatchResults(job);
            } catch (e) {
              showAiToast((e as Error).message, "error");
              continue;
            }
            if (results.state === "processing") {
              processing++;
              continue;
            }
            if (results.state !== "ended") {
              // Tell the user before the job leaves the pending list.
              job.status = results.state;
              showAiToast(t("batch.terminal", { op: job.op, id: job.id, state: t(`batch.state.${results.state}`) }), "error");
              continue;
            }
            job.status = "ended";
            // Record the metering now: if the state can't be saved, stop
            // before writing anything (a later check would meter again).
            if (!batch.saveJobs(jobs)) {
              showAiToast(t("batch.saveFailed", { id: job.id }), "error");
              return;
            }
            const { readAllNotes } = await import("../storage/workspaceNotes");
            const notes = await readAllNotes();
            const open = new Set(useAppStore.getState().openTabs.map((tab) => tab.workspaceName).filter(Boolean));
            const current = useAppStore.getState().doc.workspaceName;
            if (current) open.add(current);
            const changed: string[] = [];
            const writes = batch
              .planWrites(
                job,
                results.answers,
                (p) => notes.find((n) => n.path === p)?.text ?? null,
                (p) => notes.some((n) => n.path.toLowerCase() === p.toLowerCase()),
                changed,
                notes.map((n) => n.path),
              )
              // A note open in a tab may have unsaved edits: skip it (and
              // translations made from it).
              .filter((w) => !open.has(w.path) && !open.has(w.source));
            const created = writes.filter((w) => w.created).length;
            const notes2 = [results.failed ? `${results.failed} failed` : "", changed.length ? `${changed.length} edited since — skipped` : ""].filter(Boolean).join(", ");
            const ok = await uiConfirm({
              message: t("batch.apply", { op: job.op, changes: writes.length - created, created, failed: notes2 ? ` (${notes2})` : "" }),
            });
            if (!ok) continue;
            // Write one by one; a failure keeps what was written and leaves
            // the job retryable without duplicating finished translations.
            const done: string[] = [];
            let failedWrites = 0;
            for (const w of writes) {
              try {
                await writeWorkspaceFile(w.path, w.content);
                done.push(w.path);
                job.done = [...(job.done ?? []), w.source];
              } catch {
                failedWrites++;
              }
            }
            if (done.length) wroteAny = true;
            job.status = failedWrites ? "ended" : "applied";
            // A retry after a failed save is safe (translations carry their
            // job's marker; tags merge; summaries replace), but say so.
            if (!batch.saveJobs(jobs)) {
              showAiToast(t("batch.saveFailed", { id: job.id }), "error");
              if (wroteAny) window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
              return;
            }
            // Saved as applied: a local job's stored answers are no longer needed.
            if (job.status === "applied" && job.provider === "local") void batch.clearLocalBatch(job.id);
            showAiToast(t("batch.applied", { count: done.length }), failedWrites ? "error" : "success");
          }
          if (!batch.saveJobs(jobs)) showAiToast(t("batch.saveFailed", { id: pending.map((j) => j.id).join(", ") }), "error");
          // File tree, tags, backlinks and database views refresh on this.
          if (wroteAny) window.dispatchEvent(new CustomEvent("lumen-workspace-changed"));
          if (processing) showAiToast(t("batch.processing", { count: processing }), "info");
        },
      },
      {
        id: "ai.mode",
        label: t("cmd.ai.mode"),
        hint: t("cmd.ai.mode.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { getAiMode, setAiMode } = await import("../ai/contextPacker");
          const choice = await uiSelect({
            title: t("ai.mode.title"),
            message: t("cmd.ai.mode.hint"),
            defaultValue: getAiMode(),
            choices: [
              { value: "economy", label: t("ai.mode.economy") },
              { value: "balanced", label: t("ai.mode.balanced") },
              { value: "quality", label: t("ai.mode.quality") },
            ],
          });
          if (choice !== "economy" && choice !== "balanced" && choice !== "quality") return;
          setAiMode(choice);
          showAiToast(t(`ai.mode.${choice}`), "success");
        },
      },
      {
        id: "ai.localModels",
        label: t("cmd.ai.localModels"),
        hint: t("cmd.ai.localModels.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { detectHardware, WEBLLM_CATALOG, webLlmModelId, vramBudgetMB, recommendWebLlmModel, selectedWebLlmModel, setWebLlmModel } = await import("../ai/modelManager");
          const { webLlmModelCached, loadWebLlmModel, onWebLlmProgress } = await import("../ai/webllmEngine");
          const hw = await detectHardware();
          if (!hw.webgpu) {
            showAiToast(t("ai.localModels.noWebgpu"), "error");
            return;
          }
          const budget = vramBudgetMB(hw);
          const recommended = recommendWebLlmModel("small", hw);
          const selected = selectedWebLlmModel();
          const cached = await Promise.all(WEBLLM_CATALOG.map((e) => webLlmModelCached(webLlmModelId(e, hw.f16))));
          const choices = WEBLLM_CATALOG.map((e, i) => {
            const id = webLlmModelId(e, hw.f16);
            const gb = Math.round(((hw.f16 ? e.vramMB.f16 : e.vramMB.f32) / 1024) * 10) / 10;
            const marks = [
              id === selected ? t("ai.localModels.selected") : "",
              id === recommended ? t("ai.localModels.recommended") : "",
              cached[i] ? t("ai.localModels.cached") : "",
              (hw.f16 ? e.vramMB.f16 : e.vramMB.f32) > budget ? t("ai.localModels.tooBig") : "",
            ].filter(Boolean);
            return { value: id, label: `${e.label} · ${gb} GB · ${e.tier}${marks.length ? " — " + marks.join(", ") : ""}` };
          });
          choices.push({ value: "__auto__", label: t("ai.localModels.auto") });
          const choice = await uiSelect({
            title: t("ai.localModels.title"),
            message: t("ai.localModels.message", { budget: Math.round(budget / 1024), f16: hw.f16 ? "q4f16" : "q4f32" }),
            defaultValue: selected ?? recommended,
            choices,
          });
          if (!choice) return;
          if (choice === "__auto__") {
            setWebLlmModel(null);
            showAiToast(t("ai.localModels.autoSet", { model: recommended }), "success");
            return;
          }
          setWebLlmModel(choice);
          const idx = choices.findIndex((c) => c.value === choice);
          if (idx >= 0 && cached[idx]) {
            showAiToast(t("ai.localModels.set", { model: choice }), "success");
            return;
          }
          const download = await uiConfirm({ message: t("ai.localModels.downloadNow", { model: choice }) });
          if (!download) {
            showAiToast(t("ai.localModels.set", { model: choice }), "success");
            return;
          }
          let lastPct = -1;
          const off = onWebLlmProgress(({ progress, text }) => {
            const pct = Math.round(progress * 100);
            if (pct >= lastPct + 5 || pct === 100) {
              lastPct = pct;
              showAiToast(t("ai.toast.localLoading.body", { pct, status: text || t("ai.toast.localLoading.preparing") }), "info");
            }
          });
          try {
            await loadWebLlmModel(choice);
            showAiToast(t("ai.localModels.ready", { model: choice }), "success");
          } catch (err) {
            showAiToast(t("ai.localModels.failed", { error: err instanceof Error ? err.message : String(err) }), "error");
          } finally {
            off();
          }
        },
      },
      {
        id: "ai.styleProfile",
        label: t("cmd.ai.styleProfile"),
        hint: t("cmd.ai.styleProfile.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          const sp = await import("../ai/styleProfiles");
          const current = sp.getStyleProfile();
          const choice = await uiSelect({
            title: t("ai.style.title"),
            message: current ? t("ai.style.current", { notes: current.notes, tone: current.tone }) : t("ai.style.none"),
            defaultValue: current ? (sp.styleProfileActive() ? "off" : "on") : "build",
            choices: [
              { value: "build", label: t("ai.style.build") },
              ...(current
                ? [
                    sp.styleProfileActive() ? { value: "off", label: t("ai.style.off") } : { value: "on", label: t("ai.style.on") },
                    { value: "show", label: t("ai.style.show") },
                    { value: "modelfile", label: t("ai.style.modelfile") },
                    { value: "clear", label: t("ai.style.clear") },
                  ]
                : []),
            ],
          });
          if (!choice) return;
          try {
            if (choice === "build") {
              const folder = await uiPrompt({ message: t("ai.style.folder"), defaultValue: "" });
              if (folder === null) return;
              showAiToast(t("ai.style.building"), "info");
              const p = await cancellable((signal) => sp.buildStyleProfile(folder.trim(), signal));
              showAiToast(t("ai.style.built", { notes: p.notes, rules: p.rules.length }), "success");
            } else if (choice === "on" || choice === "off") {
              sp.setStyleProfileActive(choice === "on");
              showAiToast(choice === "on" ? t("ai.style.on") : t("ai.style.off"), "success");
            } else if (choice === "show" && current) {
              await uiAlert({ title: t("ai.style.title"), message: sp.styleInstruction(current) });
            } else if (choice === "modelfile" && current) {
              const { getOllamaConfigModel } = await import("../ai/ollamaProvider");
              const { writeWorkspaceFile, workspaceHasFile } = await import("../storage/workspace");
              // Never overwrite: an earlier (maybe edited) export or another file keeps its name.
              let path = "lumen-style.Modelfile";
              for (let n = 2; await workspaceHasFile(path); n++) path = `lumen-style-${n}.Modelfile`;
              await writeWorkspaceFile(path, sp.styleModelfile(getOllamaConfigModel()));
              showAiToast(t("ai.style.modelfileSaved", { path }), "success");
            } else if (choice === "clear") {
              sp.clearStyleProfile();
              showAiToast(t("ai.style.cleared"), "success");
            }
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "ai.styleProfile")) return;
            showAiToast((e as Error).message, "error");
          }
        },
      },
      {
        id: "ai.agentSettings",
        label: t("cmd.ai.agentSettings"),
        hint: t("cmd.ai.agentSettings.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: () => {
          window.dispatchEvent(new CustomEvent("lumen-open-ai-settings"));
        },
      },
      {
        id: "spell.hebrewDictionary",
        label: t("cmd.spell.hebrewDictionary"),
        hint: t("cmd.spell.hebrewDictionary.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const svc = await import("../ai/hebrewSpellService");
          if (await svc.hebrewDictionaryInstalled()) {
            if (!(await uiConfirm({ message: t("spell.he.removeConfirm") }))) return;
            await svc.removeHebrewDictionary();
            showAiToast(t("spell.he.removed"), "info");
            return;
          }
          if (!(await uiConfirm({ message: t("spell.he.downloadConfirm") }))) return;
          try {
            const n = await svc.downloadHebrewDictionary();
            showAiToast(t("spell.he.installed", { n: n.toLocaleString() }), "info");
          } catch (e) {
            showAiToast(t("spell.he.failed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "vault.export",
        label: t("cmd.vault.export"),
        hint: t("cmd.vault.export.hint"),
        icon: cmdIcons.Save,
        group: t("group.file"),
        action: async () => {
          const { exportVaultZip, exportVaultToFolder } = await import("../storage/exportAll");
          const { flushActiveWorkspaceDoc } = await import("../store/openDocs");
          try {
            const picker = (window as unknown as { showDirectoryPicker?: (o?: object) => Promise<unknown> }).showDirectoryPicker;
            const choice = picker
              ? await uiSelect({ message: t("vault.export.where"), choices: [{ value: "zip", label: t("vault.export.zip") }, { value: "folder", label: t("vault.export.folder") }] })
              : "zip";
            if (!choice) return;
            // The export reads the vault from disk: include edits the
            // debounced autosave has not written yet.
            await flushActiveWorkspaceDoc();
            if (choice === "folder" && picker) {
              // A WebIDL method: it must be called on `window` (Illegal invocation otherwise).
              const dir = await picker.call(window, { mode: "readwrite" });
              const r = await exportVaultToFolder(dir as Parameters<typeof exportVaultToFolder>[0]);
              showAiToast(t("vault.export.doneFolder", { n: String(r.files), folder: r.folder }), "info");
              return;
            }
            const { bytes, files } = await exportVaultZip();
            const { downloadBytes } = await import("../storage/exportFormats");
            downloadBytes(`lumen-vault-${new Date().toISOString().slice(0, 10)}.zip`, bytes, "application/zip");
            showAiToast(t("vault.export.done", { n: String(files) }), "info");
          } catch (e) {
            if ((e as DOMException)?.name === "AbortError") return;
            showAiToast(t("vault.export.failed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "vault.import",
        label: t("cmd.vault.import"),
        hint: t("cmd.vault.import.hint"),
        icon: cmdIcons.Save,
        group: t("group.file"),
        action: async () => {
          const choice = await uiSelect({ message: t("vault.import.what"), choices: [{ value: "zip", label: t("vault.import.zip") }, { value: "folder", label: t("vault.import.folder") }] });
          if (!choice) return;
          const input = document.createElement("input");
          input.type = "file";
          if (choice === "zip") input.accept = ".zip,application/zip";
          else (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = true;
          input.onchange = async () => {
            const files = input.files;
            if (!files?.length) return;
            const { importZip, importFileList } = await import("../storage/exportAll");
            try {
              const r = choice === "zip" ? await importZip(await files[0].arrayBuffer(), files[0].name) : await importFileList(files);
              window.dispatchEvent(new Event("lumen-workspace-changed"));
              showAiToast(t("vault.import.done", { notes: String(r.notes), files: String(r.attachments), folder: r.folder, source: r.source }), "info");
            } catch (e) {
              showAiToast(t("vault.import.failed", { error: (e as Error).message }), "error");
            }
          };
          input.click();
        },
      },
      {
        id: "file.trash",
        label: t("cmd.file.trash"),
        hint: t("cmd.file.trash.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: () => {
          window.dispatchEvent(new CustomEvent("lumen-open-trash"));
        },
      },
      {
        id: "ai.cancel",
        label: t("cmd.ai.cancel"),
        hint: t("cmd.ai.cancel.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai", { defaultValue: "AI Copilot" }),
        action: () => {
          const n = cancelAllAi();
          showAiToast(n ? t("toast.aiCancelled", { count: n }) : t("toast.aiNothingRunning"), "info");
        },
      },
      {
        id: "note.read",
        label: t("cmd.note.read"),
        hint: t("cmd.note.read.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const tts = await import("../ai/tts");
          if (tts.isSpeaking()) {
            tts.stopSpeaking();
            return;
          }
          if (!tts.ttsAvailable()) {
            showAiToast(t("toast.tts.unavailable"), "error");
            return;
          }
          const content = useAppStore.getState().doc.content;
          const ok = await tts
            .speak(content, {
              uiLang: getLocale(),
              onSentence: (s) => window.dispatchEvent(new CustomEvent("lumen-speech-range", { detail: { from: s.from, to: s.to } })),
            })
            .finally(() => window.dispatchEvent(new CustomEvent("lumen-speech-range", { detail: null })));
          if (!ok) showAiToast(t("toast.tts.noHebrewVoice"), "info");
        },
      },
      {
        id: "vault.digest",
        label: t("cmd.vault.digest"),
        hint: t("cmd.vault.digest.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { listWorkspace, readWorkspaceFile, writeWorkspaceFile, isOPFSAvailable } = await import("../storage/workspace");
          if (!isOPFSAvailable()) return;
          const { writeDigest } = await import("../agents/defs/digester");
          const KEY = "lumen.digest.last";
          const now = Date.now();
          let since = now - 24 * 3600_000;
          try {
            since = Number(localStorage.getItem(KEY)) || since;
          } catch {
            /* default: last 24 h */
          }
          const lang = getLocale();
          const folder = lang === "he" ? "סיכומים" : "Digests";
          const fmtDate = (ms: number) => new Date(ms).toLocaleString(getLocale(), { dateStyle: "medium", timeStyle: "short" });
          const res = await writeDigest(
            { list: () => listWorkspace({ includeAssets: false }), read: readWorkspaceFile, write: writeWorkspaceFile },
            { since, now, lang, folder, formatDate: fmtDate },
          );
          if (!res.ok) {
            // The checkpoint stays, so these notes are in the next digest.
            showAiToast(t("toast.digest.readFailed", { count: res.failed.length }), "error");
            return;
          }
          const { path, body } = res;
          try {
            localStorage.setItem(KEY, String(now));
          } catch {
            /* next digest covers 24 h again */
          }
          window.dispatchEvent(new Event("lumen-workspace-changed"));
          useAppStore.getState().openTab({ name: path.split("/").pop()!, content: body, workspaceName: path });
        },
      },
      {
        id: "image.altText",
        label: t("cmd.image.altText"),
        hint: t("cmd.image.altText.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai", { defaultValue: "AI Copilot" }),
        action: async () => {
          const { imageText, withImageText, imagesNeedingAlt } = await import("../ai/vision");
          const { readWorkspaceBlob } = await import("../storage/workspace");
          const doc = useAppStore.getState().doc.content;
          // Images with no alt, or still named after their file — a real
          // one-word description ("logo") is kept.
          const targets = imagesNeedingAlt(doc);
          if (!targets.length) {
            showAiToast(t("toast.imageAlt.none"), "info");
            return;
          }
          showAiToast(t("toast.imageAlt.working", { count: targets.length }), "info");
          let next = doc;
          let done = 0;
          for (const m of targets) {
            const blob = await readWorkspaceBlob(m.url).catch(() => null);
            if (!blob) continue;
            const res = await imageText(blob, getLocale()).catch(() => null);
            if (!res || res.source === "none") continue;
            next = withImageText(next, m.url, m.alt, res);
            done++;
          }
          if (next !== useAppStore.getState().doc.content && useAppStore.getState().doc.content === doc) useAppStore.getState().setContent(next);
          showAiToast(t("toast.imageAlt.done", { done, count: targets.length }), done ? "success" : "info");
        },
      },
      {
        id: "ai.rerankModel",
        label: t("cmd.ai.rerankModel"),
        hint: t("cmd.ai.rerankModel.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai", { defaultValue: "AI Copilot" }),
        action: async () => {
          const { getRerankMode, setRerankMode } = await import("../ai/reranker");
          const next = getRerankMode() === "model" ? "lexical" : "model";
          setRerankMode(next);
          showAiToast(t(next === "model" ? "toast.rerankModelOn" : "toast.rerankModelOff"), "info");
        },
      },
      {
        id: "ai.privacyLedger",
        label: t("cmd.ai.privacyLedger"),
        hint: t("cmd.ai.privacyLedger.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.ai", { defaultValue: "AI Copilot" }),
        action: () => {
          window.dispatchEvent(new CustomEvent("lumen-open-privacy-ledger"));
        },
      },
      {
        id: "ai.doctor",
        label: t("cmd.ai.doctor"),
        hint: t("cmd.ai.doctor.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: () => {
          window.dispatchEvent(new CustomEvent("lumen-open-ai-doctor"));
        },
      },
      {
        id: "ai.policy",
        label: t("cmd.ai.policy"),
        hint: t("cmd.ai.policy.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { getAiPolicy, setAiPolicy } = await import("../ai/policy");
          const choice = await uiSelect({
            title: t("ai.policy.title"),
            message: t("cmd.ai.policy.hint"),
            defaultValue: getAiPolicy(),
            choices: [
              { value: "local-only", label: t("ai.policy.localOnly") },
              { value: "local-first", label: t("ai.policy.localFirst") },
              { value: "cloud", label: t("ai.policy.cloud") },
            ],
          });
          if (choice !== "local-only" && choice !== "local-first" && choice !== "cloud") return;
          setAiPolicy(choice);
          showAiToast(
            choice === "local-only" ? t("ai.policy.localOnly") : choice === "local-first" ? t("ai.policy.localFirst") : t("ai.policy.cloud"),
            "success",
          );
        },
      },
      {
        id: "ai.trace",
        label: t("cmd.ai.trace"),
        hint: t("cmd.ai.trace.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { loadTrace, listRuns, formatTraceReport } = await import("../agents/trace");
          await loadTrace();
          const runs = listRuns();
          await uiAlert({ title: t("ai.trace.title"), message: runs.length ? formatTraceReport(runs) : t("ai.trace.empty") });
        },
      },
      {
        id: "ai.cache",
        label: t("cmd.ai.cache"),
        hint: t("cmd.ai.cache.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { aiCacheEnabled, setAiCacheEnabled, clearAiCache } = await import("../ai/responseCache");
          const choice = await uiSelect({
            title: t("ai.cache.title"),
            message: t("cmd.ai.cache.hint"),
            defaultValue: aiCacheEnabled() ? "on" : "off",
            choices: [
              { value: "on", label: t("ai.cache.on") },
              { value: "off", label: t("ai.cache.off") },
              { value: "clear", label: t("ai.cache.clear") },
            ],
          });
          if (!choice) return;
          if (choice === "clear") {
            const count = await clearAiCache();
            showAiToast(t("ai.cache.cleared", { count }), "success");
            return;
          }
          setAiCacheEnabled(choice === "on");
          showAiToast(choice === "on" ? t("ai.cache.on") : t("ai.cache.off"), "success");
        },
      },
      {
        id: "ai.switchProvider",
        label: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
        hint: t("cmd.ai.provider.hint", { defaultValue: "Choose between OpenAI, Ollama, or local WebGPU" }),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { setActiveProvider, getActiveProvider } = await import("../ai/llm");
          const current = getActiveProvider();
          const choice = await uiSelect({
            title: t("cmd.ai.provider", { defaultValue: "AI: Switch Provider" }),
            message: "Choose your AI provider:",
            defaultValue: current,
            choices: [
              { value: "openai", label: "OpenAI \u2014 cloud (API key)" },
              { value: "anthropic", label: "Claude / Anthropic \u2014 cloud (API key)" },
              { value: "gemini", label: "Google Gemini \u2014 cloud (API key)" },
              { value: "mistral", label: "Mistral \u2014 cloud (API key)" },
              { value: "ollama", label: "Ollama \u2014 local server" },
              { value: "local-webgpu", label: "Local WebGPU \u2014 in-browser" },
            ],
          });
          if (!choice) return;
          const valid = choice.trim().toLowerCase();
          const known = ["openai", "anthropic", "gemini", "mistral", "ollama", "local-webgpu"];
          if (!known.includes(valid)) {
            await uiAlert({ message: `Invalid provider. Choose: ${known.join(", ")}` });
            return;
          }
          setActiveProvider(
            valid as "openai" | "anthropic" | "gemini" | "mistral" | "ollama" | "local-webgpu",
          );
          // Cloud providers other than OpenAI keep their key under
          // lumen.ai.key.<provider>; prompt for it if missing.
          if (valid === "anthropic" || valid === "gemini" || valid === "mistral") {
            const existing = getSecret(`lumen.ai.key.${valid}`);
            if (!existing) {
              const label =
                valid === "anthropic"
                  ? "Anthropic (Claude)"
                  : valid === "gemini"
                    ? "Google Gemini"
                    : "Mistral";
              const key = await uiPrompt({
                message: `Enter your ${label} API key:`,
                defaultValue: "",
              });
              if (key && key.trim()) setSecret(`lumen.ai.key.${valid}`, key.trim());
            }
          }
          showAiToast(t("toast.aiProviderSetTo", { valid }), "success");
        },
      },
      {
        id: "tools.checkGrammar",
        label: t("cmd.tools.grammar"),
        hint: t("cmd.tools.grammar.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { checkGrammar } = await import("../ai/grammar");
          try {
            showAiToast(t("toast.checkingGrammar"), "info");
            const text = liveDoc().content;
            const matches = await cancellable((signal) => checkGrammar(text, locale === "he" ? "he" : "en-US", { allowModel: true, signal }));
            if (matches.length === 0) {
              showAiToast(t("toast.noGrammarIssuesFound"), "success");
              return;
            }
            const top = matches.slice(0, 5).map((m, i) => `${i + 1}. ${m.message}`).join("\n");
            await uiAlert({ message: `Found ${matches.length} issue${matches.length === 1 ? "" : "s"}:\n\n${top}` });
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, "tools.checkGrammar")) return;
            showAiToast(t("toast.grammarCheckFailed", { error: (e as Error).message }), "error");
          }
        },
      },
      {
        id: "view.rtl",
        label: rtl ? t("cmd.view.rtl.off") : t("cmd.view.rtl.on"),
        hint: rtl ? "← LTR" : "→ RTL",
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleRtl,
      },
      ...SUPPORTED_LOCALES.map((l) => ({
        id: `lang.${l.code}`,
        label: t("cmd.view.language", { label: l.label }),
        hint:
          l.dir === "rtl"
            ? t("cmd.view.language.rtl")
            : t("cmd.view.language.ltr"),
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: () => setLocale(l.code),
      })),
      // ── New Features ──────────────────────────────────────────────────────
      {
        id: "view.findReplace",
        label: t("cmd.view.findReplace"),
        shortcut: "⌘H",
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: () => setFindReplaceOpen(true),
      },
      {
        id: "view.graphView",
        label: t("cmd.view.graphView"),
        hint: t("cmd.view.graphView.hint"),
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: () => {
          setGraphOpen(true);
        },
      },
      {
        id: "view.versionHistory",
        label: t("cmd.view.versionHistory"),
        hint: t("cmd.view.versionHistory.hint"),
        icon: cmdIcons.PanelRightOpen,
        group: t("group.view"),
        action: () => setHistoryOpen(true),
      },
      {
        id: "insert.table",
        label: t("cmd.insert.table"),
        hint: t("cmd.insert.table.hint"),
        icon: cmdIcons.Pencil,
        group: t("group.insert"),
        action: () => setTableEditorOpen(true),
      },
      {
        id: "view.autoSave",
        label: autoSave ? t("cmd.view.autoSave.off") : t("cmd.view.autoSave.on"),
        hint: autoSave ? t("cmd.view.autoSave.hint", { interval: autoSaveInterval / 1000 }) : "off",
        icon: cmdIcons.Pencil,
        group: t("group.view"),
        action: toggleAutoSave,
      },
      {
        id: "view.canvas",
        label: t("cmd.view.canvas"),
        hint: t("cmd.view.canvas.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.view"),
        action: () => setCanvasOpen(true),
      },
      {
        id: "view.plugins",
        label: t("cmd.view.plugins"),
        hint: t("cmd.view.plugins.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.view"),
        action: () => setGalleryOpen(true),
      },
      ...(setTemplateGalleryOpen
        ? [
            {
              id: "templates.open",
              label: t("cmd.templates.open"),
              hint: t("cmd.templates.open.hint"),
              icon: cmdIcons.Sparkles,
              group: t("group.view"),
              action: () => setTemplateGalleryOpen(true),
            },
          ]
        : []),
      ...(setAuditLogOpen
        ? [
            {
              id: "audit.open",
              label: t("cmd.audit.open"),
              hint: t("cmd.audit.open.hint"),
              icon: cmdIcons.Sparkles,
              group: t("group.security"),
              action: () => setAuditLogOpen(true),
            },
          ]
        : []),
      ...(setOrgSettingsOpen
        ? [
            {
              id: "settings.organization",
              label: t("cmd.settings.organization"),
              hint: t("cmd.settings.organization.hint"),
              icon: cmdIcons.Sparkles,
              group: t("group.security"),
              action: () => setOrgSettingsOpen(true),
            },
          ]
        : []),
      ...(setTrustedKeysOpen
        ? [
            {
              id: "settings.trustedKeys",
              label: t("cmd.settings.trustedKeys"),
              hint: t("cmd.settings.trustedKeys.hint"),
              icon: cmdIcons.Sparkles,
              group: t("group.security"),
              action: () => setTrustedKeysOpen(true),
            },
          ]
        : []),
      ...(setThemeSettingsOpen
        ? [
            {
              id: "settings.theme",
              label: t("cmd.settings.theme"),
              hint: t("cmd.settings.theme.hint"),
              icon: theme === "dark" ? cmdIcons.Moon : cmdIcons.Sun,
              group: t("group.view"),
              action: () => setThemeSettingsOpen(true),
            },
          ]
        : []),
      ...(setFineTuneOpen
        ? [
            {
              id: "ai.fineTune",
              label: t("cmd.fineTune.open"),
              hint: t("cmd.fineTune.open.hint"),
              icon: cmdIcons.Sparkles,
              group: t("group.ai"),
              action: () => setFineTuneOpen(true),
            },
          ]
        : []),
      ...(setTagsPanelOpen
        ? [
            {
              id: "view.tags",
              label: t("cmd.view.tags"),
              hint: t("cmd.view.tags.hint"),
              icon: cmdIcons.Link,
              group: t("group.view"),
              action: () => setTagsPanelOpen(true),
            },
          ]
        : []),
      ...(collab && setCommentsPanelOpen
        ? [
            {
              id: "collab.viewComments",
              label: t("cmd.collab.viewComments"),
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: () => setCommentsPanelOpen(true),
            },
          ]
        : []),
      ...(collab && onAddComment
        ? [
            {
              id: "collab.addComment",
              label: t("cmd.collab.addComment"),
              hint: t("cmd.collab.addComment.hint"),
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: onAddComment,
            },
          ]
        : []),
      ...TEMPLATES.map((tpl) => ({
        id: `template.${tpl.id}`,
        label: `${t("group.templates")}: ${tpl.name}`,
        hint: tpl.category,
        icon: cmdIcons.FileText,
        group: t("group.templates"),
        action: () => openTemplateDoc(tpl.name, tpl.content),
      })),
      // Marketplace templates installed into the workspace (templates/<id>.md).
      ...buildInstalledTemplateCommands(installedTemplates, {
        groupLabel: t("group.templates"),
        hint: t("templates.installed.button"),
        apply: (name, content) => openTemplateDoc(name, content),
        onError: (e) => showAiToast(t("templates.loadFailed", { error: e.message }), "error"),
      }),
      // ── Voice-to-Markdown ─────────────────────────────────────────────────
      {
        id: "voice.memo",
        label: t("cmd.tools.voiceMemo"),
        hint: t("cmd.tools.voiceMemo.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          const { startVoiceMemo } = await import("../ui/VoiceDictation");
          await startVoiceMemo();
        },
      },
      {
        id: "voice.dictate",
        label: t("cmd.tools.voice"),
        hint: t("cmd.tools.voice.hint"),
        icon: cmdIcons.Sparkles,
        group: t("group.tools"),
        action: async () => {
          // Language selector
          const langMap: Record<string, string> = {
            "English": "en-US", "Hebrew (עברית)": "he-IL", "Arabic (العربية)": "ar-SA",
            "Russian (Русский)": "ru-RU", "Spanish": "es-ES", "French": "fr-FR",
            "German": "de-DE", "Chinese (中文)": "zh-CN", "Japanese (日本語)": "ja-JP",
          };
          const langChoice = await uiPrompt({
            message: "Select language for voice recognition:",
            placeholder: "English",
          });
          const lang = langMap[langChoice ?? ""] ?? (useAppStore.getState().locale === "he" ? "he-IL" : "en-US");

          startVoiceRecording(lang);
        },
      },
      // ── Plugin Commands ──────────────────────────────────────────────────
      ...getPluginCommands().map((cmd) => ({
        id: cmd.id,
        label: cmd.label,
        hint: cmd.hint ?? t("group.plugins"),
        icon: cmdIcons.Sparkles,
        group: t("group.plugins"),
        action: cmd.action,
      })),
      // ── Encryption ────────────────────────────────────────────────────────
      {
        id: "vault.encrypt",
        label: t("cmd.security.encrypt"),
        hint: t("cmd.security.encrypt.hint"),
        icon: cmdIcons.Save,
        group: t("group.security"),
        action: async () => {
          const password = await uiPrompt({ message: "Enter encryption password:" });
          if (!password) return;
          const encrypted = await encryptDocument(liveDoc().content, password);
          setContent(encrypted);
          showAiToast(t("toast.documentEncrypted"), "info");
        },
      },
      {
        id: "vault.decrypt",
        label: t("cmd.security.decrypt"),
        hint: t("cmd.security.decrypt.hint"),
        icon: cmdIcons.Save,
        group: t("group.security"),
        action: async () => {
          if (!isEncrypted(liveDoc().content)) {
            showAiToast(t("toast.documentIsNotEncrypted"), "error");
            return;
          }
          const password = await uiPrompt({ message: "Enter decryption password:" });
          if (!password) return;
          try {
            const decrypted = await decryptDocument(liveDoc().content, password);
            setContent(decrypted);
            showAiToast(t("toast.documentDecrypted"), "info");
          } catch {
            showAiToast(t("toast.wrongPassword"), "error");
          }
        },
      },
      // ── Multi-Language AI Prompts (filtered by user locale) ───────────────
      ...AI_PROMPT_TEMPLATES.filter((tpl) => tpl.lang === locale).map((tpl) => ({
        id: `ai.prompt.${tpl.id}`,
        label: tpl.label,
        hint: tpl.category,
        icon: cmdIcons.Sparkles,
        group: t("group.ai"),
        action: async () => {
          const prompt = applyTemplate(tpl, liveDoc().content);
          try {
            showAiToast(t("toast.processing", { name: tpl.label }), "info");
            const { runAgentOrThrow } = await import("../agents/runtime");
            const { templaterAgent } = await import("../agents/defs");
            const result = await cancellable((signal) => runAgentOrThrow(templaterAgent, { text: prompt, extra: { templateId: tpl.id } }, { document: liveDoc().content, signal }));
            setContent(liveDoc().content + "\n\n---\n\n" + result);
            showAiToast(t("toast.completed", { name: tpl.label }), "success");
          } catch (e) {
            if (isAbort(e)) return;
            if ((await import("../agents/suggestions")).reportAgentFailure(e, `ai.prompt.${tpl.id}`)) return;
            showAiToast(t("toast.aiError", { error: (e as Error).message }), "error");
          }
        },
      })),
      // ── Formatting (Prettier, lazy) ───────────────────────────────────
      ...buildFormatCommands(
        {
          getView: () => getEditorView?.() ?? null,
          getContent: () => useAppStore.getState().doc.content,
          setContent: (s: string) => useAppStore.getState().setContent(s),
        },
        detectIsMac(),
      ).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
      // ── Suggesting mode (track changes, CriticMarkup) ─────────────────
      ...buildSuggestingCommands({
        getView: () => getEditorView?.() ?? null,
        getContent: () => useAppStore.getState().doc.content,
        setContent: (s: string) => useAppStore.getState().setContent(s),
        suggesting: suggestingMode,
        toggle: toggleSuggestingMode,
      }).map((c) => ({ ...c, icon: cmdIcons.Pencil })),
      // ── Plans (billing builds only) ─────────────────────────────────────
      ...(canPurchasePlans()
        ? [
            { id: "billing.upgradePro", label: t("cmd.billing.upgradePro"), action: () => void upgradeTo("pro") },
            { id: "billing.upgradeTeam", label: t("cmd.billing.upgradeTeam"), action: () => void upgradeTo("team") },
            { id: "billing.manage", label: t("cmd.billing.manage"), action: () => void manageBilling() },
            {
              id: "billing.managePersonal",
              label: t("cmd.billing.managePersonal"),
              action: () => void manageBilling("personal"),
            },
          ].map((c) => ({ ...c, icon: cmdIcons.Sparkles, group: t("group.tools") }))
        : []),
      // ── AI Capabilities ──────────────────────────────────────────────────
      buildAiSettingsCommand(),
      buildAiOutlineCommand(
        () => useAppStore.getState().doc.content,
        (s: string) => useAppStore.getState().setContent(s),
      ),
      // ── Git ─────────────────────────────────────────────────────────────
      {
        id: "git.clone",
        label: t("cmd.git.clone"),
        hint: t("cmd.git.clone.hint"),
        icon: cmdIcons.Download,
        group: t("group.git"),
        action: async () => {
          const url = await uiPrompt({ message: t("git.prompt.url"), placeholder: "https://github.com/..." });
          if (!url) return;
          if (!showWorkspace) toggleWorkspace();
          try {
            const result = await cloneRepo(url.trim());
            window.dispatchEvent(new Event("lumen-workspace-changed"));
            await uiAlert({
              message: t("git.alert.cloned", {
                folder: result.workspaceFolder,
                count: result.fileCount,
              }),
            });
          } catch (e) {
            await uiAlert({
              message: t("git.alert.cloneFailed", { error: (e as Error).message }),
            });
          }
        },
      },
      {
        id: "git.commit",
        label: t("cmd.git.commit", { defaultValue: "Commit & Push" }),
        hint: t("cmd.git.commit.hint", { defaultValue: "AI Auto-Pilot Enabled" }),
        icon: cmdIcons.Save,
        group: t("group.git"),
        action: async () => {
          if (!liveDoc().workspaceName) {
            await uiAlert({ message: t("git.prompt.openFileFirst") });
            return;
          }
          const repoFolder = liveDoc().workspaceName!.split("/")[0];
          
          let aiSuggestion = "";
          
          try {
            aiSuggestion = await cancellable((signal) => generateAiCommitMessage(repoFolder, signal));
          } catch (e) {
            log.warn("AI commit generation skipped", e);
          }

          const message = (await uiPrompt({ 
            message: "Commit Message" + (aiSuggestion ? " (AI Suggested):" : ":"),
             defaultValue: aiSuggestion 
          }))?.trim();
          if (!message) return;
          const identity = await getGitIdentity();
          try {
            await commitAndPush(repoFolder, message, identity);
            await uiAlert({ message: t("git.alert.pushed") });
          } catch (e) {
            await uiAlert({
              message: t("git.alert.commitFailed", { error: (e as Error).message }),
            });
          }
        },
      },
      {
        id: "git.pull",
        label: t("cmd.git.pull"),
        hint: t("cmd.git.pull.hint"),
        icon: cmdIcons.Download,
        group: t("group.git"),
        action: async () => {
          if (!liveDoc().workspaceName) {
            await uiAlert({ message: t("git.prompt.openFileFirst") });
            return;
          }
          const repoFolder = liveDoc().workspaceName!.split("/")[0];
          try {
            const result = await pullRepo(repoFolder);
            window.dispatchEvent(new Event("lumen-workspace-changed"));
            await uiAlert({
              message: t("git.alert.pulled", { changed: result.changedFiles }),
            });
            // If the active file's content changed on disk, reload it.
            if (liveDoc().workspaceName) {
              try {
                const fresh = await readWorkspaceFile(liveDoc().workspaceName!);
                if (fresh !== liveDoc().content) {
                  setDoc({ content: fresh, dirty: false });
                }
              } catch {
                /* file may have been deleted upstream; ignore */
              }
            }
          } catch (e) {
            await uiAlert({
              message: t("git.alert.pullFailed", { error: (e as Error).message }),
            });
          }
        },
      },
      {
        id: "git.status",
        label: t("cmd.git.status"),
        icon: cmdIcons.Link,
        group: t("group.git"),
        action: async () => {
          if (!liveDoc().workspaceName) {
            await uiAlert({ message: t("git.prompt.openFileFirst") });
            return;
          }
          const repoFolder = liveDoc().workspaceName!.split("/")[0];
          try {
            const summary = await gitStatusSummary(repoFolder);
            const total = summary.added + summary.modified + summary.deleted;
            await uiAlert({
              message: total === 0
                ? t("git.status.clean")
                : t("git.status.summary", {
                    added: summary.added,
                    modified: summary.modified,
                    deleted: summary.deleted,
                  }),
            });
          } catch (e) {
            await uiAlert({ message: (e as Error).message });
          }
        },
      },
      {
        id: "git.watch",
        label: t("cmd.git.watch"),
        hint: t("cmd.git.watch.hint"),
        icon: cmdIcons.Download,
        group: t("group.git"),
        action: async () => {
          const { isWatching, setWatching, startGitWatch, stopGitWatch } = await import("../sync/gitWatch");
          if (isWatching()) {
            stopGitWatch();
            setWatching(false);
            showAiToast(t("toast.gitWatchPaused"), "info");
            return;
          }
          if (!liveDoc().workspaceName) {
            await uiAlert({ message: t("git.prompt.openFileFirst") });
            return;
          }
          const repoFolder = liveDoc().workspaceName!.split("/")[0];
          setWatching(true);
          startGitWatch({
            repoFolder,
            onPulled: ({ changedFiles }) =>
              showAiToast(t("toast.pulledFile", { count: changedFiles }), "success"),
          });
          showAiToast(t("toast.gitWatchOnPullingEvery"), "info");
        },
      },
      {
        id: "git.token",
        label: t("cmd.git.token"),
        hint: t("cmd.git.token.hint"),
        icon: cmdIcons.Link,
        group: t("group.git"),
        action: async () => {
          const token = await uiPrompt({ message: t("git.prompt.token") });
          if (token === null) return;
          await setGitToken(token.trim() || null);
          await uiAlert({
            message: token.trim()
              ? t("git.alert.tokenSaved")
              : t("git.alert.tokenCleared"),
          });
        },
      },
      {
        id: "git.identity",
        label: t("cmd.git.identity"),
        icon: cmdIcons.Link,
        group: t("group.git"),
        action: async () => {
          const current = await getGitIdentity();
          const name = (await uiPrompt({
            message: t("git.prompt.identityName"),
            defaultValue: current.name,
          }))?.trim();
          if (!name) return;
          const email = (await uiPrompt({
            message: t("git.prompt.identityEmail"),
            defaultValue: current.email,
          }))?.trim();
          if (!email) return;
          await setGitIdentity({ name, email });
          await uiAlert({ message: t("git.alert.identitySaved") });
        },
      },
      ...(collab
        ? [
            {
              id: "collab.copy",
              label: t("cmd.collab.copy"),
              hint: collab.roomName,
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: () => {
                const link = roomShareLink(collab.roomName, collab.sharePassword);
                navigator.clipboard?.writeText(link).catch(() => {});
              },
            },
            {
              id: "collab.leave",
              label: t("cmd.collab.leave"),
              hint: collab.roomName,
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: handleStopCollab,
            },
          ]
        : [
            {
              id: "collab.start",
              label: t("cmd.collab.start"),
              hint: t("cmd.collab.start.hint"),
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: () => handleStartCollab(),
            },
            {
              id: "collab.join",
              label: t("cmd.collab.join"),
              hint: t("cmd.collab.join.hint"),
              icon: cmdIcons.Link,
              group: t("group.collab"),
              action: async () => {
                const name = await uiPrompt({ message: t("collab.prompt.room") });
                if (name) handleStartCollab(name.trim());
              },
            },
          ]),
      {
        id: "file.openSampleWorkspace",
        label: t("cmd.file.openSampleWorkspace"),
        hint: t("cmd.file.openSampleWorkspace.hint"),
        icon: cmdIcons.FolderOpen,
        group: t("group.file"),
        action: async () => {
          if (!isOPFSAvailable()) {
            await uiAlert({ message: t("doc.alert.workspaceUnavailable") });
            return;
          }
          try {
            const { createSampleWorkspace } = await import("../storage/sampleWorkspace");
            const result = await createSampleWorkspace();
            window.dispatchEvent(new Event("lumen-workspace-changed"));
            if (!useAppStore.getState().showWorkspace) toggleWorkspace();
            const content = await readWorkspaceFile(result.entry);
            useAppStore.getState().openTab({
              name: result.entry,
              content,
              workspaceName: result.entry,
            });
            showAiToast(
              result.created.length > 0
                ? t("sample.toast.created", { count: result.created.length, folder: result.root })
                : t("sample.toast.exists", { folder: result.root }),
              "info",
            );
          } catch (e) {
            await uiAlert({
              message: t("sample.alert.failed", { error: (e as Error).message }),
            });
          }
        },
      },
      {
        id: "file.saveToWorkspace",
        label: t("cmd.file.saveToWorkspace"),
        hint: t("cmd.file.saveToWorkspace.hint"),
        icon: cmdIcons.Save,
        group: t("group.file"),
        action: handleSaveToWorkspace,
      },
      {
        id: "theme.toggle",
        label: isDark ? t("cmd.view.theme.toLight") : t("cmd.view.theme.toDark"),
        icon: isDark ? cmdIcons.Sun : cmdIcons.Moon,
        group: t("group.view"),
        action: () => setTheme(isDark ? "light" : "dark"),
      },
      {
        id: "insert.chart",
        label: t("cmd.insert.chart"),
        hint: t("cmd.insert.chart.hint"),
        icon: cmdIcons.BarChart3,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.chart),
      },
      {
        id: "insert.csv",
        label: t("cmd.insert.csv"),
        hint: t("cmd.insert.csv.hint"),
        icon: cmdIcons.Table,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.csv),
      },
      {
        id: "insert.json",
        label: t("cmd.insert.json"),
        hint: t("cmd.insert.csv.hint"),
        icon: cmdIcons.Table,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.jsonTable),
      },
      {
        id: "insert.mermaid",
        label: t("cmd.insert.mermaid"),
        icon: cmdIcons.Network,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.mermaid),
      },
      {
        id: "insert.map",
        label: t("cmd.insert.map"),
        icon: cmdIcons.Map,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.map),
      },
      {
        id: "insert.math",
        label: t("cmd.insert.math"),
        icon: cmdIcons.Calculator,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.math),
      },
      {
        id: "insert.callout",
        label: t("cmd.insert.callout"),
        hint: t("cmd.insert.callout.hint"),
        icon: cmdIcons.Quote,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.note),
      },
      {
        id: "insert.graphviz",
        label: t("cmd.insert.graphviz"),
        icon: cmdIcons.Workflow,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.graphviz),
      },
      {
        id: "insert.plantuml",
        label: t("cmd.insert.plantuml"),
        hint: t("cmd.insert.plantuml.hint"),
        icon: cmdIcons.Workflow,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.plantuml),
      },
      {
        id: "insert.abc",
        label: t("cmd.insert.abc"),
        icon: cmdIcons.Music2,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.abc),
      },
      {
        id: "insert.model",
        label: t("cmd.insert.model"),
        hint: t("cmd.insert.model.hint"),
        icon: cmdIcons.Box,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.model),
      },
      {
        id: "insert.embed",
        label: t("cmd.insert.embed"),
        hint: t("cmd.insert.embed.hint"),
        icon: cmdIcons.Youtube,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.embed),
      },
      {
        id: "insert.htmlpreview",
        label: t("cmd.insert.htmlpreview"),
        hint: t("cmd.insert.htmlpreview.hint"),
        icon: cmdIcons.Box,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.htmlpreview),
      },
      {
        id: "insert.bibtex",
        label: t("cmd.insert.bibtex"),
        hint: t("cmd.insert.bibtex.hint"),
        icon: cmdIcons.Quote,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.bibtex),
      },
      {
        id: "insert.wikilink",
        label: t("cmd.insert.wikilink"),
        hint: "[[Page|label]]",
        icon: cmdIcons.Link,
        group: t("group.insert"),
        action: () => insertSnippet(BLOCK_SNIPPETS.wikilink),
      },
    ]);
  }, [
    handleNew,
    handleOpen,
    handleSave,
    handleExportHtml,
    handleSaveToWorkspace,
    insertSnippet,
    recents,
    handleReopenRecent,
    toggleBacklinks,
    toggleVim,
    vimEnabled,
    collab,
    handleStartCollab,
    handleStopCollab,
    setLocale,
    locale,
    showWorkspace,
    toggleWorkspace,
    setDoc,
    doc.workspaceName,
    theme,
    setRuntimeMetricsOpen,
    installedTemplates,
    suggestingMode,
    toggleSuggestingMode,
  ]);
}
