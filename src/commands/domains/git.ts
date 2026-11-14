/** Git commands for a repository cloned into the workspace. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { getGitIdentity, setGitIdentity, setGitToken, cloneRepo, pullRepo, commitAndPush, gitStatusSummary } from "../../sync/git";
import { uiAlert, uiPrompt } from "../../ui/PromptDialog";
import { generateAiCommitMessage } from "../../ai/commands";
import { log } from "../../lib/logger";
import { showAiToast } from "../../ui/AiToast";
import { readWorkspaceFile } from "../../storage/workspace";
import { cancellable, type CommandContext } from "./context";

/** Clone, commit & push, pull, status, watch, token, identity. */
export function buildGitCommands({ showWorkspace, setDoc, toggleWorkspace, liveDoc }: CommandContext): Command[] {
  return [
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
  ];
}
