/**
 * useGit – encapsulates Git clone/commit/push/pull operations.
 *
 * Extracted from useCommands.ts to keep Git-specific logic in a single
 * reusable hook. All commands still appear in the command palette via
 * the registry.
 */
import { useCallback } from "react";
import type { DocFile } from "../store/useStore";
import {
  cloneRepo,
  commitAndPush,
  getGitIdentity,
  gitStatusSummary,
  pullRepo,
  setGitIdentity,
  setGitToken,
} from "../sync/git";
import { generateAiCommitMessage } from "../ai/commands";
import { uiAlert, uiConfirm, uiPrompt } from "../ui/PromptDialog";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import { explainError } from "../lib/userError";
import "./useGitStrings";

export interface UseGitOptions {
  setDoc: (d: Partial<DocFile>) => void;
  showWorkspace: boolean;
  toggleWorkspace: () => void;
  activeFile: string | null;
}

export interface UseGitReturn {
  handleClone: () => Promise<void>;
  handleCommitAndPush: () => Promise<void>;
  handlePull: () => Promise<void>;
  handleSetGitIdentity: () => Promise<void>;
  handleSetGitToken: () => Promise<void>;
  handleGitStatus: () => Promise<void>;
}

export function useGit({ setDoc: _setDoc, showWorkspace, toggleWorkspace, activeFile }: UseGitOptions): UseGitReturn {
  const handleClone = useCallback(async () => {
    const url = await uiPrompt({ message: t("git.prompt.cloneUrl"), placeholder: "https://github.com/user/repo" });
    if (!url) return;
    try {
      showAiToast(t("toast.cloningRepository"), "info");
      const result = await cloneRepo(url);
      showAiToast(t("toast.clonedFilesIntoWorkspace", { count: result.fileCount }), "info");
      if (!showWorkspace) toggleWorkspace();
      window.dispatchEvent(new Event("lumen-workspace-changed"));
    } catch (e) {
      await uiAlert({ message: t("git.alert.cloneFailed", { error: explainError(e) }) });
    }
  }, [showWorkspace, toggleWorkspace]);

  const handleCommitAndPush = useCallback(async () => {
    const repoFolder = activeFile?.split("/")[0];
    if (!repoFolder) {
      await uiAlert({ message: t("git.alert.noRepo") });
      return;
    }
    const identity = await getGitIdentity();
    let message = await uiPrompt({ message: t("git.prompt.commitMessage"), placeholder: t("git.defaultCommitMessage") });
    if (!message) {
      try {
        showAiToast(t("toast.generatingCommitMessage"), "info");
        message = await generateAiCommitMessage(repoFolder);
      } catch {
        message = t("git.defaultCommitMessage");
      }
    }
    try {
      showAiToast(t("toast.pushing"), "info");
      await commitAndPush(repoFolder, message, identity);
      showAiToast(t("toast.pushedToRemote"), "info");
    } catch (e) {
      await uiAlert({ message: t("git.alert.pushFailed", { error: explainError(e) }) });
    }
  }, [activeFile]);

  const handlePull = useCallback(async () => {
    const repoFolder = activeFile?.split("/")[0];
    if (!repoFolder) {
      await uiAlert({ message: t("git.alert.noRepo") });
      return;
    }
    if (!(await uiConfirm({ message: t("git.pull.confirm", { folder: repoFolder }) }))) return;
    try {
      showAiToast(t("toast.pulling"), "info");
      const result = await pullRepo(repoFolder);
      showAiToast(t("toast.pulledChangedFiles", { count: result.changedFiles }), "info");
      window.dispatchEvent(new Event("lumen-workspace-changed"));
    } catch (e) {
      await uiAlert({ message: t("git.alert.pullFailed", { error: explainError(e) }) });
    }
  }, [activeFile]);

  const handleSetGitIdentity = useCallback(async () => {
    const current = await getGitIdentity();
    const name = await uiPrompt({ message: t("git.prompt.name"), placeholder: current.name || t("git.placeholder.name") });
    if (!name) return;
    const email = await uiPrompt({ message: t("git.prompt.email"), placeholder: current.email || "you@example.com" });
    if (!email) return;
    await setGitIdentity({ name, email });
    showAiToast(t("toast.gitIdentitySet", { name, email }), "info");
  }, []);

  const handleSetGitToken = useCallback(async () => {
    const token = await uiPrompt({ message: t("git.prompt.token"), placeholder: "ghp_xxxxxxxxxxxx" });
    if (token === null) return;
    await setGitToken(token || null);
    showAiToast(token ? t("git.alert.tokenSaved") : t("git.alert.tokenCleared"), "info");
  }, []);

  const handleGitStatus = useCallback(async () => {
    const repoFolder = activeFile?.split("/")[0];
    if (!repoFolder) {
      await uiAlert({ message: t("git.alert.noRepo") });
      return;
    }
    try {
      const summary = await gitStatusSummary(repoFolder);
      const msg = `Added: ${summary.added}, Modified: ${summary.modified}, Deleted: ${summary.deleted}`;
      showAiToast(msg, "info");
    } catch (e) {
      await uiAlert({ message: t("git.alert.statusFailed", { error: explainError(e) }) });
    }
  }, [activeFile]);

  return {
    handleClone,
    handleCommitAndPush,
    handlePull,
    handleSetGitIdentity,
    handleSetGitToken,
    handleGitStatus,
  };
}
