/**
 * Collaborative version history (plan 3.2): while a collab session runs,
 * the shared text is recorded every five minutes — and once more when the
 * session ends — into the one history store (src/storage/history.ts), under
 * the open note's history key, with reason "collab" and the local user as
 * author. The Version History panel shows them next to the note's other
 * versions. (It used to write a separate `LumenVersionHistory` database
 * that nothing read.)
 */

import { log } from "../lib/logger";
import { historyKey, recordSnapshot } from "../storage/history";
import { useAppStore } from "../store/useStore";

/** The history key collab snapshots of the open note are filed under. */
export function collabHistoryKey(roomId: string): string {
  const doc = useAppStore.getState().doc;
  return doc.name || doc.workspaceName ? historyKey(doc) : `collab:${roomId}`;
}

/** Record the shared text now under `key` (skipped when unchanged). Empty text counts: collaborators clearing a note is a version. */
export async function recordCollabSnapshot(key: string, text: string, author: string, now = Date.now()): Promise<boolean> {
  try {
    return await recordSnapshot(key, text, "collab", now, author);
  } catch (e) {
    log.warn("[collab] snapshot failed", e);
    return false;
  }
}

/**
 * Background snapshots for a collab session; call once when it starts.
 * Returns a stop function, which also records the final text.
 */
export function startSnapshotInterval(
  roomId: string,
  getText: () => string,
  getAuthor: () => { name: string; clientId: number },
  intervalMs = 300_000, // 5 minutes
): () => void {
  // The note the session belongs to, fixed now: switching tabs during the
  // session must not file its text under another note.
  const key = collabHistoryKey(roomId);
  // Before anything was recorded, an empty text is the not-yet-synced doc, not a deletion.
  let recorded = false;
  const tick = () => {
    const text = getText();
    if (!text && !recorded) return;
    recorded = true;
    void recordCollabSnapshot(key, text, getAuthor().name);
  };
  const timer = setInterval(tick, intervalMs);
  return () => {
    clearInterval(timer);
    tick();
  };
}
