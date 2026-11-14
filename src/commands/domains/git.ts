/** Git commands for a repository cloned into the workspace. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { uiAlert, uiConfirm } from "../../ui/PromptDialog";
import { type CommandContext } from "./context";

// The git modules (and isomorphic-git behind them) load on first use: the
// palette lists these commands at start-up, so nothing here may pull them
// into the startup bundle.
export const gitApi = () => import("../../sync/git");

/** A failed clone / pull, with a hint when it looks like CORS (loaded on use). */
export const describeNetError = async (e: unknown) => (await import("../../store/gitPullDocs")).describeNetError(e);

/** Clone, commit & push, pull, status, watch, token, identity. */
export function buildGitCommands({ showWorkspace, toggleWorkspace, liveDoc }: CommandContext): Command[] {
  return [
    {
      id: "git.clone",
      label: t("cmd.git.clone"),
      hint: t("cmd.git.clone.hint"),
      icon: cmdIcons.Download,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitClone({ showWorkspace, toggleWorkspace })),
    },
    {
      id: "git.commit",
      label: t("cmd.git.commit", { defaultValue: "Commit & Push" }),
      hint: t("cmd.git.commit.hint", { defaultValue: "AI Auto-Pilot Enabled" }),
      icon: cmdIcons.Save,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitCommit({ liveDoc })),
    },
    {
      id: "git.pull",
      destructive: "confirm",
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
        if (!(await uiConfirm({ message: t("git.pull.confirm", { folder: repoFolder }) }))) return;
        try {
          // Safe pull (plan 3.3): merges into the vault, never deletes, never
          // overwrites a note with unsaved edits; the open notes are updated by it.
          const { pullRepo } = await gitApi();
          const result = await pullRepo(repoFolder);
          window.dispatchEvent(new Event("lumen-workspace-changed"));
          const { reportPull } = await import("../../store/gitPullDocs");
          await reportPull(result);
        } catch (e) {
          await uiAlert({
            message: t("git.alert.pullFailed", { error: await describeNetError(e) }),
          });
        }
      },
    },
    {
      id: "git.status",
      label: t("cmd.git.status"),
      icon: cmdIcons.Link,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitStatus({ liveDoc })),
    },
    {
      id: "git.watch",
      label: t("cmd.git.watch"),
      hint: t("cmd.git.watch.hint"),
      icon: cmdIcons.Download,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitWatch({ liveDoc })),
    },
    {
      id: "git.token",
      label: t("cmd.git.token"),
      hint: t("cmd.git.token.hint"),
      icon: cmdIcons.Link,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitToken()),
    },
    {
      id: "git.corsProxy",
      label: t("cmd.git.corsProxy"),
      hint: t("cmd.git.corsProxy.hint"),
      icon: cmdIcons.Link,
      group: t("group.git"),
      action: async () => (await import("../../store/gitPullDocs")).promptCorsProxy(),
    },
    {
      id: "git.identity",
      label: t("cmd.git.identity"),
      icon: cmdIcons.Link,
      group: t("group.git"),
      action: () => import("./gitActions").then((m) => m.gitIdentity()),
    },
  ];
}
