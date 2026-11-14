/**
 * The command palette's list (⌘K), assembled from per-domain builders in
 * ./domains. Each builder turns the shared context (App's options plus the
 * store values below) into its commands; domains/index.ts lists them in
 * palette order.
 */
import { useMemo } from "react";
import type { Command } from "../ui/CommandPalette";
import { useAppStore } from "../store/useStore";
import { withAiQuota } from "../billing/aiQuota";
import { useInstalledTemplates } from "./installedTemplates";
import { COMMAND_SECTIONS } from "./domains";
import { useCommandStore, type CommandContext, type UseCommandsOptions } from "./domains/context";

export type { UseCommandsOptions } from "./domains/context";
export { openNewDoc, openTemplateDoc } from "./openDoc";
export { saveClip } from "./domains/research";

export function useCommands(options: UseCommandsOptions) {
  const store = useCommandStore();
  const installedTemplates = useInstalledTemplates();
  const o = options;

  return useMemo<Command[]>(() => {
    // Actions read the document when they run, not when the list was built:
    // the command list no longer rebuilds on every keystroke (C5).
    const { setMode, setTheme, toggleOutline } = useAppStore.getState();
    const ctx: CommandContext = {
      ...options,
      ...store,
      installedTemplates,
      liveDoc: () => useAppStore.getState().doc,
      setMode,
      setTheme,
      toggleOutline,
    };
    // AI-prompt commands are wrapped with the monthly quota check.
    return withAiQuota(COMMAND_SECTIONS.flatMap((build) => build(ctx)));
    // Every store value a label or an action reads is listed, so a toggle's
    // label never goes stale. The document itself is not: actions read it
    // through liveDoc(), so typing does not rebuild the list (C5).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    o.handleNew,
    o.handleOpen,
    o.handleSave,
    o.handleExportHtml,
    o.handleSaveToWorkspace,
    o.insertSnippet,
    o.recents,
    o.handleReopenRecent,
    store.toggleBacklinks,
    store.toggleVim,
    store.vimEnabled,
    o.collab,
    o.handleStartCollab,
    o.handleStopCollab,
    store.setLocale,
    store.locale,
    store.showWorkspace,
    store.toggleWorkspace,
    store.setDoc,
    store.doc.workspaceName,
    store.theme,
    o.setRuntimeMetricsOpen,
    installedTemplates,
    store.suggestingMode,
    store.toggleSuggestingMode,
    store.rtl,
    store.autoSave,
    store.autoSaveInterval,
    store.spellCheck,
    store.useLocalAi,
    store.typewriterMode,
    store.writingGoalWords,
    store.pageView,
    store.tsChecks,
    store.grammarCheck,
  ]);
}
