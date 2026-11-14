/**
 * useCollab – encapsulates Yjs WebRTC collaboration state.
 *
 * Extracted from App.tsx to prevent connection leaks and keep the
 * collaboration lifecycle in a single, testable unit.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import type { CollabPeer, CollabSession } from "../collab/yjs";
// URL helpers are yjs-free and safe on the boot path.
import { readRoomFromHash, roomShareLink, setRoomInHash } from "../collab/roomUrl";

// The collab module pulls the whole yjs + y-webrtc stack (~60KB gz) — load it
// only when a session actually starts, never on the boot path. Memoized so
// repeated start/stop doesn't re-import.
let collabModPromise: Promise<typeof import("../collab/yjs")> | null = null;
const loadCollab = () => (collabModPromise ??= import("../collab/yjs"));
import { log } from "../lib/logger";
import { recordAudit } from "../lib/audit";

type CollabSessionWithCleanup = CollabSession & { __cleanup?: () => void };
import { useAppStore } from "../store/useStore";
import { uiConfirm } from "../ui/PromptDialog";
import { t } from "../i18n";
import { toast, useToastStore } from "../store/useToastStore";

export interface UseCollabReturn {
  collab: CollabSession | null;
  collabPeers: CollabPeer[];
  handleStartCollab: (roomOverride?: string) => void;
  handleStopCollab: () => void;
}

export function useCollab(docContent: string): UseCollabReturn {
  const [collab, setCollab] = useState<CollabSession | null>(null);
  const [collabPeers, setCollabPeers] = useState<CollabPeer[]>([]);

  // Keep docContent fresh for the start handler without re-creating
  // the callback on every keystroke.
  const contentRef = useRef(docContent);
  contentRef.current = docContent;

  const handleStartCollab = useCallback(
    (joinName?: string) => {
      if (collab) return;
      // Fire-and-forget async: the yjs stack is loaded on demand here, the
      // first time a session starts (it is deliberately NOT in the boot path).
      void (async () => {
      let mod: Awaited<ReturnType<typeof loadCollab>>;
      try {
        mod = await loadCollab();
      } catch (err) {
        log.error("collab module load failed", err);
        return;
      }
      const { connectCollab, makeRoomName, makeRoomPassword, snapshotPeers } = mod;
      const name = joinName ?? makeRoomName();
      // T49: every new room is end-to-end encrypted with its own random
      // password, carried in the share link's #fragment (never sent to a
      // server). Joining uses the password from the link.
      const password = joinName ? null : makeRoomPassword();
      try {
        const session = connectCollab(name, contentRef.current, {
          isNewRoom: !joinName,
          ...(password ? { password } : {}),
          // Wrong room password (or tampered ciphertext): nothing is
          // applied to the doc — tell the user why it isn't syncing.
          onE2EError: () =>
            toast.error(t("collab.e2e.decryptFailed"), t("collab.e2e.decryptFailed.body")),
          onEncryptedRoomEmpty: (share) =>
            useToastStore.getState().push({
              kind: "warning",
              ttlMs: 0,
              title: t("collab.e2e.emptyRoom"),
              body: t("collab.e2e.emptyRoom.body"),
              action: { label: t("collab.e2e.emptyRoom.share"), run: share },
            }),
        });
        setCollab(session);
        setRoomInHash(name, password);

        // Mirror Yjs text changes back into the doc store so the preview pane
        // stays current.
        const observer = () => {
          try {
            const text = session.ytext.toString();
            useAppStore.getState().setContent(text);
            useAppStore.getState().markSaved();
          } catch (err) {
            log.warn("collab observer error", err);
          }
        };
        session.ytext.observe(observer);

        const awarenessTick = () => {
          try {
            setCollabPeers(snapshotPeers(session));
          } catch {
            /* why: awareness snapshot failed — non-fatal */
          }
        };
        session.awareness.on("change", awarenessTick);
        awarenessTick();

        // Stash cleanup on the session for handleStopCollab to use.
        (session as CollabSessionWithCleanup).__cleanup = () => {
          session.ytext.unobserve(observer);
          session.awareness.off("change", awarenessTick);
        };

        if (!joinName) {
          const link = roomShareLink(name, password);
          navigator.clipboard?.writeText(link).catch(() => { /* why: clipboard denied: the share dialog shows the link to copy by hand */ });
        }
        // ε.2 — record start/join. Counts-only payload so the audit
        // log doesn't leak the room name (which can be brand-named).
        const userId = (useAppStore.getState() as { user?: { id?: string } }).user?.id;
        if (userId) {
          recordAudit(userId, joinName ? "collab.join" : "collab.start", {
            payload: { roomNameLength: name.length },
          });
        }
      } catch (err) {
        log.error("collab init failed", err);
        // Reset state so user can retry
        setCollab(null);
        setCollabPeers([]);
        setRoomInHash(null);
      }
      })();
    },
    [collab],
  );

  const handleStopCollab = useCallback(() => {
    if (!collab) return;
    (collab as CollabSessionWithCleanup).__cleanup?.();
    collab.destroy();
    setCollab(null);
    setCollabPeers([]);
    setRoomInHash(null);
    const userId = (useAppStore.getState() as { user?: { id?: string } }).user?.id;
    if (userId) {
      recordAudit(userId, "collab.stop", { payload: {} });
    }
  }, [collab]);

  // On first load, if the URL contains #room=, offer to join.
  useEffect(() => {
    const hashRoom = readRoomFromHash();
    if (hashRoom && !collab) {
      const timer = setTimeout(async () => {
        const ok = await uiConfirm({ message: t("collab.prompt.join", { room: hashRoom }) });
        if (ok) handleStartCollab(hashRoom);
      }, 600);
      return () => clearTimeout(timer);
    }
    // run once
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Strict cleanup on unmount to prevent WebRTC leaks.
  useEffect(() => {
    return () => {
      if (collab) {
        (collab as CollabSessionWithCleanup).__cleanup?.();
        collab.destroy();
      }
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [collab]);

  return { collab, collabPeers, handleStartCollab, handleStopCollab };
}
