/**
 * Comment threads in a sidecar file next to the note (plan W1.19):
 * `notes/plan.md` → `notes/plan.comments.json`. The room keeps them in Yjs
 * while it is open; the sidecar keeps them with the note when the room is
 * gone, travels with the vault (git, sync, export), and brings them back
 * when the note is shared again.
 *
 * Each thread is stored with its Yjs anchor and with the quoted text and
 * its offsets at save time. On import into a new room (a new Y.Doc, where
 * the old anchors mean nothing) a thread is re-anchored on its quote — the
 * occurrence nearest the saved offset — or, when the quote is gone, on the
 * saved offsets, clamped.
 */

import * as Y from "yjs";
import { decodeRel, encodeRel, getCommentsMap, listComments, resolveAnchor, type Comment } from "./comments";

export const SIDECAR_VERSION = 1;

export interface SidecarThread extends Comment {
  /** The commented text when the sidecar was written. */
  quote: string;
  from: number;
  to: number;
}

export interface CommentsSidecar {
  version: number;
  threads: SidecarThread[];
}

/** `dir/note.md` → `dir/note.comments.json`. */
export function sidecarPath(notePath: string): string {
  return notePath.replace(/\.(md|markdown|mdx|txt)$/i, "") + ".comments.json";
}

/** The threads of `commentsDoc`, anchored in `ytext`, as a sidecar. Threads whose text was deleted are kept with their last quote. */
export function exportComments(commentsDoc: Y.Doc, ytext: Y.Text, previous?: CommentsSidecar | null): CommentsSidecar {
  const text = ytext.toString();
  const before = new Map((previous?.threads ?? []).map((t) => [t.id, t]));
  const threads = listComments(commentsDoc)
    .slice()
    .sort((a, b) => a.createdAt - b.createdAt)
    .map((c) => {
      const at = resolveAnchor(ytext.doc as Y.Doc, c);
      const old = before.get(c.id);
      // A range whose text was all deleted keeps the last quote it had.
      const live = at !== null && at.to > at.from;
      if (!live && old) return { ...c, quote: old.quote, from: old.from, to: old.to };
      const from = at?.from ?? 0;
      const to = at?.to ?? from;
      return { ...c, quote: text.slice(from, to), from, to };
    });
  return { version: SIDECAR_VERSION, threads };
}

export function serializeSidecar(s: CommentsSidecar): string {
  return JSON.stringify(s, null, 2) + "\n";
}

/** Parse a sidecar; null when it isn't one (a hand-edited or foreign file is never trusted blindly). */
export function parseSidecar(text: string): CommentsSidecar | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  const s = v as Partial<CommentsSidecar>;
  if (!s || typeof s !== "object" || s.version !== SIDECAR_VERSION || !Array.isArray(s.threads)) return null;
  const str = (x: unknown) => typeof x === "string";
  const num = (x: unknown) => typeof x === "number" && Number.isFinite(x);
  const threads = s.threads.filter(
    (t): t is SidecarThread =>
      !!t && str(t.id) && str(t.body) && str(t.authorName) && str(t.authorColor) && num(t.createdAt) && str(t.quote) && num(t.from) && num(t.to) && Array.isArray(t.replies) && str(t.anchorStart) && str(t.anchorEnd),
  );
  return { version: SIDECAR_VERSION, threads };
}

/** The occurrence of `quote` nearest `near`, or -1. */
function nearestOccurrence(text: string, quote: string, near: number): number {
  if (!quote) return -1;
  let best = -1;
  for (let i = text.indexOf(quote); i >= 0; i = text.indexOf(quote, i + 1)) {
    if (best < 0 || Math.abs(i - near) < Math.abs(best - near)) best = i;
  }
  return best;
}

/**
 * Bring a sidecar's threads into `commentsDoc`, anchored in `ytext`.
 * Threads already there (same id) are left alone. Returns how many were added.
 */
export function importComments(commentsDoc: Y.Doc, ytext: Y.Text, sidecar: CommentsSidecar): number {
  const map = getCommentsMap(commentsDoc);
  const text = ytext.toString();
  const textDoc = ytext.doc as Y.Doc;
  let added = 0;
  commentsDoc.transact(() => {
    for (const t of sidecar.threads) {
      if (map.has(t.id)) continue;
      const { quote, from, to, ...comment } = t;
      // The stored anchor still works when this is the same document.
      const a = decodeRel(comment.anchorStart);
      const b = decodeRel(comment.anchorEnd);
      const pa = a && Y.createAbsolutePositionFromRelativePosition(a, textDoc);
      const pb = b && Y.createAbsolutePositionFromRelativePosition(b, textDoc);
      let anchored: Comment = comment;
      if (!(pa && pb && pa.type === ytext && text.slice(Math.min(pa.index, pb.index), Math.max(pa.index, pb.index)) === quote)) {
        const at = nearestOccurrence(text, quote, from);
        const start = at >= 0 ? at : Math.min(from, text.length);
        const end = at >= 0 ? at + quote.length : Math.min(Math.max(to, start), text.length);
        anchored = {
          ...comment,
          anchorStart: encodeRel(Y.createRelativePositionFromTypeIndex(ytext, start)),
          anchorEnd: encodeRel(Y.createRelativePositionFromTypeIndex(ytext, end, -1)),
        };
      }
      map.set(anchored.id, anchored);
      added++;
    }
  });
  return added;
}

/**
 * Keep `notePath`'s sidecar in step with the room's threads: written a
 * second after the last change (and once on start when the room has
 * threads), read on start to bring back threads from an earlier session.
 * Returns the stop function.
 */
export function bindCommentsSidecar(
  commentsDoc: Y.Doc,
  ytext: Y.Text,
  notePath: string,
  io: { read: (path: string) => Promise<string | null>; write: (path: string, text: string) => Promise<void> },
  opts: { canWrite: () => boolean; delayMs?: number } = { canWrite: () => true },
): () => void {
  const path = sidecarPath(notePath);
  let last: CommentsSidecar | null = null;
  let lastText = "";
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;
  const save = async (final = false) => {
    timer = null;
    if ((stopped && !final) || !opts.canWrite()) return;
    const next = exportComments(commentsDoc, ytext, last);
    const text = serializeSidecar(next);
    if (text === lastText || (next.threads.length === 0 && !last)) return;
    last = next;
    lastText = text;
    await io.write(path, text).catch(() => undefined);
  };
  const schedule = () => {
    if (timer) clearTimeout(timer);
    timer = setTimeout(() => void save(), opts.delayMs ?? 1000);
  };
  const map = getCommentsMap(commentsDoc);
  const observer = () => schedule();
  map.observeDeep(observer);
  void io
    .read(path)
    .then((raw) => {
      if (stopped || raw === null) return;
      const parsed = parseSidecar(raw);
      if (!parsed) return;
      last = parsed;
      lastText = serializeSidecar(parsed);
      if (opts.canWrite()) importComments(commentsDoc, ytext, parsed);
    })
    .catch(() => undefined);
  return () => {
    stopped = true;
    map.unobserveDeep(observer);
    if (timer) {
      clearTimeout(timer);
      void save(true); // the last change before the room closed
    }
  };
}
