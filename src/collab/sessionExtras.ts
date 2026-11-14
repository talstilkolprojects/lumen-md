/**
 * What a collab session does besides syncing (plan W1.19), loaded with the
 * session (never on the startup path):
 *   • a session opened from a share link is remembered in "Shared with me",
 *     with the role the server granted;
 *   • the participant hears once what their role allows;
 *   • the owner's / an editor's threads are kept in the note's sidecar file
 *     (`commentsSidecar.ts`), and brought back from it.
 */

import type { CollabSession } from "./yjs";
import { rememberShared, type Role } from "./sharing";
import { bindCommentsSidecar } from "./commentsSidecar";
import { t } from "../i18n";
import "./sharingStrings";
import { toast } from "../store/useToastStore";

export interface SessionExtrasDeps {
  /** The note's path in the workspace, when the session edits a saved note. */
  notePath: string | null;
  /** The note's title, for "Shared with me". */
  title: string;
  read?: (path: string) => Promise<string | null>;
  write?: (path: string, text: string) => Promise<void>;
  notify?: (message: string) => void;
}

async function workspaceIo() {
  const ws = await import("../storage/workspace");
  return {
    read: async (path: string) => ((await ws.workspaceHasFile(path)) ? ws.readWorkspaceFile(path) : null),
    write: (path: string, text: string) => ws.writeWorkspaceFile(path, text),
  };
}

const ROLE_NOTICE: Record<Role, string | null> = { edit: null, comment: "collab.role.comment", view: "collab.role.view" };

/** Start the extras for `session`; returns the stop function. */
export function attachSessionExtras(session: CollabSession, deps: SessionExtrasDeps): () => void {
  const stops: Array<() => void> = [];
  const notify = deps.notify ?? ((m: string) => toast.info(m));

  if (session.share) {
    const share = session.share;
    const remember = (role: Role) =>
      rememberShared({ room: session.roomName, share, role, expiresAt: null, link: typeof location !== "undefined" ? location.href : "", title: deps.title });
    remember(session.role());
    let told: Role | null = null;
    stops.push(
      session.onRoleChange((role) => {
        remember(role);
        const key = ROLE_NOTICE[role];
        if (key && told !== role) notify(t(key));
        told = role;
      }),
    );
  }

  if (deps.notePath && !session.share) {
    const notePath = deps.notePath;
    let stop: (() => void) | null = null;
    let stopped = false;
    void (async () => {
      const io = deps.read && deps.write ? { read: deps.read, write: deps.write } : await workspaceIo();
      if (stopped) return;
      stop = bindCommentsSidecar(session.commentsDoc, session.ytext, notePath, io, { canWrite: () => session.canEdit() });
    })();
    stops.push(() => {
      stopped = true;
      stop?.();
    });
  }

  return () => {
    for (const s of stops.splice(0)) s();
  };
}
