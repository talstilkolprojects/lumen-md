/**
 * Bodies of palette commands that load on use (perf, plan W4.9): the palette
 * lists the commands from the domain file; a body arrives when its command
 * runs, so none of this code is in the startup bundle.
 */
import { uiPrompt, uiAlert } from "../../ui/PromptDialog";
import { t } from "../../i18n";
import { cancellable } from "./context";
import { generateAiCommitMessage } from "../../ai/commands";
import { log } from "../../lib/logger";
import { explainError } from "../../lib/userError";
import { showAiToast } from "../../ui/AiToast";
import type { CommandContext } from "./context";
import { gitApi, describeNetError } from "./git";

/** `git.clone` (moved from git.ts, which loads this module when the command runs). */
export const gitClone = async ({ showWorkspace, toggleWorkspace }: Pick<CommandContext, "showWorkspace" | "toggleWorkspace">) => {
  const url = await uiPrompt({ message: t("git.prompt.url"), placeholder: "https://github.com/..." });
  if (!url) return;
  if (!showWorkspace) toggleWorkspace();
  try {
    const { cloneRepo } = await gitApi();
    const result = await cloneRepo(url.trim());
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    const lines = [t("git.alert.cloned", { folder: result.workspaceFolder, count: result.fileCount })];
    if (result.kept.length) lines.push(t("git.clone.kept", { count: result.kept.length }));
    if (result.lfsPointers.length) lines.push(t("git.lfs.unsupported", { files: result.lfsPointers.slice(0, 5).join(", ") }));
    await uiAlert({ message: lines.join("\n\n") });
  } catch (e) {
    await uiAlert({
      message: t("git.alert.cloneFailed", { error: await describeNetError(e) }),
    });
  }
};

/** `git.commit` (moved from git.ts, which loads this module when the command runs). */
export const gitCommit = async ({ liveDoc }: Pick<CommandContext, "liveDoc">) => {
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
    message: aiSuggestion ? t("git.prompt.commitMessageAi") : t("git.prompt.commitMessage"),
     defaultValue: aiSuggestion 
  }))?.trim();
  if (!message) return;
  const { getGitIdentity, commitAndPush, UnresolvedConflictsError } = await gitApi();
  const identity = await getGitIdentity();
  try {
    const { skipped, lfsKept, unsaved } = await commitAndPush(repoFolder, message, identity);
    const notes = [t("git.alert.pushed")];
    if (skipped.length) notes.push(t("git.commit.skipped", { files: skipped.slice(0, 5).join(", ") }));
    if (lfsKept.length) notes.push(t("git.commit.lfsKept", { files: lfsKept.slice(0, 5).join(", ") }));
    if (unsaved.length) notes.push(t("git.commit.unsaved", { files: unsaved.slice(0, 5).join(", ") }));
    await uiAlert({ message: notes.join("\n\n") });
  } catch (e) {
    if (e instanceof UnresolvedConflictsError) {
      await uiAlert({ message: t("git.commit.unresolved", { files: e.paths.join(", ") }) });
      return;
    }
    await uiAlert({
      message: t("git.alert.commitFailed", { error: explainError(e) }),
    });
  }
};

/** `git.status` (moved from git.ts, which loads this module when the command runs). */
export const gitStatus = async ({ liveDoc }: Pick<CommandContext, "liveDoc">) => {
  if (!liveDoc().workspaceName) {
    await uiAlert({ message: t("git.prompt.openFileFirst") });
    return;
  }
  const repoFolder = liveDoc().workspaceName!.split("/")[0];
  try {
    const { gitStatusSummary } = await gitApi();
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
    await uiAlert({ message: explainError(e) });
  }
};

/** `git.watch` (moved from git.ts, which loads this module when the command runs). */
export const gitWatch = async ({ liveDoc }: Pick<CommandContext, "liveDoc">) => {
  const { isWatching, setWatching, startGitWatch, stopGitWatch } = await import("../../sync/gitWatch");
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
    onConflicts: (count) => showAiToast(t("git.watch.conflicts", { count }), "info"),
  });
  showAiToast(t("toast.gitWatchOnPullingEvery"), "info");
};

/** `git.token` (moved from git.ts, which loads this module when the command runs). */
export const gitToken = async () => {
  const token = await uiPrompt({ message: t("git.prompt.token") });
  if (token === null) return;
  const { setGitToken } = await gitApi();
  await setGitToken(token.trim() || null);
  await uiAlert({
    message: token.trim()
      ? t("git.alert.tokenSaved")
      : t("git.alert.tokenCleared"),
  });
};

/** `git.identity` (moved from git.ts, which loads this module when the command runs). */
export const gitIdentity = async () => {
  const { getGitIdentity, setGitIdentity } = await gitApi();
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
};
