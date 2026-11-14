/** Collaboration: the live room and its comments. */
import { cmdIcons, type Command } from "../../ui/CommandPalette";
import { t } from "../../i18n";
import { uiPrompt } from "../../ui/PromptDialog";
import { roomShareLink } from "../../collab/roomUrl";
import type { CommandContext } from "./context";

/** Comments, in a live room. */
export function buildCommentCommands({ collab, setCommentsPanelOpen, onAddComment }: CommandContext): Command[] {
  return [
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
  ];
}

/** Start or join a room; copy its link or leave it. */
export function buildCollabCommands({ collab, handleStartCollab, handleStopCollab }: CommandContext): Command[] {
  return [
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
              navigator.clipboard?.writeText(link).catch(() => { /* why: clipboard denied: the room name is shown in the palette hint to copy by hand */ });
            },
          },
          {
            id: "collab.share",
            label: t("cmd.collab.share"),
            hint: t("cmd.collab.share.hint"),
            icon: cmdIcons.Link,
            group: t("group.collab"),
            action: async () => (await import("../../ui/ShareDialog")).openShareDialog({ session: collab }),
          },
          {
            // W3.11 — named versions of the shared note, compared word by word.
            id: "collab.namedVersions",
            label: t("cmd.collab.namedVersions"),
            hint: t("cmd.collab.namedVersions.hint"),
            icon: cmdIcons.Link,
            group: t("group.collab"),
            action: async () => {
              const [{ openNamedVersionsDialog }, { useAuth }] = await Promise.all([import("../../ui/NamedVersionsDialog"), import("../../auth/useAuth")]);
              const user = useAuth.getState().user;
              openNamedVersionsDialog({ session: collab, author: user?.name?.trim() || user?.email?.split("@")[0] || null });
            },
          },
          {
            id: "collab.sharedWithMe",
            label: t("cmd.collab.sharedWithMe"),
            icon: cmdIcons.Link,
            group: t("group.collab"),
            action: async () => (await import("../../ui/ShareDialog")).openShareDialog({ session: collab, tab: "shared" }),
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
            id: "collab.sharedWithMe",
            label: t("cmd.collab.sharedWithMe"),
            icon: cmdIcons.Link,
            group: t("group.collab"),
            action: async () => (await import("../../ui/ShareDialog")).openShareDialog({ session: null, tab: "shared" }),
          },
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
  ];
}
