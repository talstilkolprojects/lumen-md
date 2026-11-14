/**
 * What the per-domain command builders share: the options App passes to
 * useCommands, the store values the list was built from, and helpers.
 *
 * Builders are plain functions of this context, called inside useCommands'
 * useMemo, so a command sees exactly the values it did when the list lived
 * in one closure: state read at build time is the build-time value, and
 * actions that need the current note read it through `liveDoc()`.
 */
import type { RecentFile } from "../../storage/recent";
import type { CollabSession } from "../../collab/yjs";
import type { InstalledTemplate } from "../../storage/templateMarketplace";
import { useAppStore } from "../../store/useStore";
import { aiOperation } from "../../ai/aiAbort";

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

type AppState = ReturnType<typeof useAppStore.getState>;

/** The store values and actions the commands use, subscribed to by useCommands. */
export function useCommandStore() {
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
  return {
    doc, theme, showWorkspace, locale, rtl, autoSave, autoSaveInterval, vimEnabled, spellCheck, useLocalAi,
    typewriterMode, writingGoalWords, pageView, toggleRtl, setContent, setDoc, setLocale, toggleWorkspace,
    toggleBacklinks, toggleVim, toggleSpellCheck, toggleLocalAi, toggleTypewriter, tsChecks, toggleTsChecks,
    grammarCheck, toggleGrammarCheck, suggestingMode, toggleSuggestingMode, setWritingGoal, toggleAutoSave,
  };
}

export type CommandStore = ReturnType<typeof useCommandStore>;

export interface CommandContext extends UseCommandsOptions, Omit<CommandStore, "doc"> {
  installedTemplates: InstalledTemplate[];
  /** The active note when an action runs, not when the list was built (C5). */
  liveDoc: () => AppState["doc"];
  setMode: AppState["setMode"];
  setTheme: AppState["setTheme"];
  toggleOutline: AppState["toggleOutline"];
}

/** Run an AI call as a cancellable operation (Esc / "Cancel AI", T55). */
export async function cancellable<T>(fn: (signal: AbortSignal) => Promise<T>): Promise<T> {
  const op = aiOperation();
  try {
    return await fn(op.signal);
  } finally {
    op.end();
  }
}
