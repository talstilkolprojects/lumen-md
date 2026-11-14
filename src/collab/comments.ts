/**
 * Inline comments on text ranges (P3-13 collab polish).
 *
 * Each comment lives inside a shared `Y.Map` so it syncs across peers
 * over the same WebRTC / WebSocket transport as the doc itself. Anchors
 * use `Y.RelativePosition` so they survive arbitrary edits — if Alice
 * inserts a paragraph above Bob's comment, the comment stays attached
 * to the same words rather than the same byte offsets.
 *
 * Wire shape (`Y.Map<string, Comment>` keyed by uuid):
 *
 *   {
 *     id: string,
 *     authorName: string,
 *     authorColor: string,
 *     createdAt: number,
 *     resolvedAt: number | null,
 *     body: string,
 *     anchorStart: Uint8Array,  // Y.encodeRelativePosition(...)
 *     anchorEnd:   Uint8Array,
 *     replies: Reply[],
 *   }
 *
 * The store API is intentionally narrow — `addComment` / `resolve` /
 * `reply` / `subscribe`. UI lives in a separate `CommentsPanel.tsx`
 * (sidebar + per-comment thread expansion).
 *
 * Plan W1.19: comments and replies carry the @mentions in their text
 * (`mentions`), and in a room with share links the map lives in the room's
 * comments document (`CollabSession.commentsDoc`) while the anchors still
 * point into the note's text — so every function takes the document that
 * holds the map, and `resolveAnchor` the note's.
 */

import * as Y from "yjs";
import { randomId } from "../lib/cryptoRandom";

export interface Reply {
  id: string;
  authorName: string;
  authorColor: string;
  createdAt: number;
  body: string;
  /** @mentions in `body` (plan W1.19); absent on replies written before. */
  mentions?: string[];
}

export interface Comment {
  id: string;
  authorName: string;
  authorColor: string;
  createdAt: number;
  resolvedAt: number | null;
  body: string;
  /** base64 of `Y.encodeRelativePosition(...)`. */
  anchorStart: string;
  anchorEnd: string;
  replies: Reply[];
  /** @mentions in `body` (plan W1.19); absent on comments written before. */
  mentions?: string[];
}

/**
 * The names mentioned in a text: `@` followed by letters (Hebrew included,
 * niqqud too), digits, `_`, `.` or `-`, at the start or after a space or an
 * opening bracket — so an e-mail address is not a mention. Unique, in order.
 */
export function extractMentions(body: string): string[] {
  const out: string[] = [];
  // After a space, an opening bracket or quote, or a Hebrew prefix ("ו-@דנה", maqaf too).
  for (const m of body.matchAll(/(?:^|[\s(\[{"'״׳\-־])@([\p{L}\p{M}\p{N}_.-]{1,40})/gu)) {
    const name = m[1].replace(/[.-]+$/, "");
    if (name && !out.includes(name)) out.push(name);
  }
  return out;
}

/** Everyone mentioned in a thread (the comment and its replies). */
export function threadMentions(c: Comment): string[] {
  const out: string[] = [];
  for (const n of [...(c.mentions ?? extractMentions(c.body)), ...c.replies.flatMap((r) => r.mentions ?? extractMentions(r.body))]) if (!out.includes(n)) out.push(n);
  return out;
}

/** Threads that mention `name` (case-insensitive), newest first. */
export function commentsMentioning(doc: Y.Doc, name: string): Comment[] {
  const n = name.toLocaleLowerCase();
  return listComments(doc).filter((c) => threadMentions(c).some((m) => m.toLocaleLowerCase() === n));
}

const MAP_KEY = "lumen-comments";

export function encodeRel(rel: Y.RelativePosition): string {
  const bytes = Y.encodeRelativePosition(rel);
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin);
}

export function decodeRel(s: string): Y.RelativePosition | null {
  try {
    const bin = atob(s);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    return Y.decodeRelativePosition(bytes);
  } catch {
    return null;
  }
}

/** Get (or lazily create) the shared comments map for a Y.Doc. */
export function getCommentsMap(doc: Y.Doc): Y.Map<Comment> {
  return doc.getMap<Comment>(MAP_KEY);
}

/**
 * Add a new comment. `from` / `to` are absolute Yjs positions in the
 * tracked text — we convert to RelativePosition so the anchor follows
 * concurrent edits.
 */
export function addComment(
  doc: Y.Doc,
  ytext: Y.Text,
  body: string,
  from: number,
  to: number,
  author: { name: string; color: string },
): Comment {
  const map = getCommentsMap(doc);
  // The start sticks to the first commented character and the end to the
  // last one (assoc -1), so text typed right before or right after the
  // range stays outside it (plan W1.19).
  const relStart = Y.createRelativePositionFromTypeIndex(ytext, from);
  const relEnd = Y.createRelativePositionFromTypeIndex(ytext, to, -1);
  const comment: Comment = {
    id: randomId(8),
    authorName: author.name,
    authorColor: author.color,
    createdAt: Date.now(),
    resolvedAt: null,
    body,
    anchorStart: encodeRel(relStart),
    anchorEnd: encodeRel(relEnd),
    replies: [],
    mentions: extractMentions(body),
  };
  map.set(comment.id, comment);
  return comment;
}

/** Reply to an existing comment. The whole comment is replaced (Y.Map
 *  set overwrites) so the deep-merge stays in one transaction. */
export function replyToComment(
  doc: Y.Doc,
  commentId: string,
  body: string,
  author: { name: string; color: string },
): void {
  const map = getCommentsMap(doc);
  const c = map.get(commentId);
  if (!c) return;
  const reply: Reply = {
    id: randomId(8),
    authorName: author.name,
    authorColor: author.color,
    createdAt: Date.now(),
    body,
    mentions: extractMentions(body),
  };
  map.set(commentId, { ...c, replies: [...c.replies, reply] });
}

/** Mark a comment resolved (toggleable). */
export function toggleResolved(doc: Y.Doc, commentId: string): void {
  const map = getCommentsMap(doc);
  const c = map.get(commentId);
  if (!c) return;
  map.set(commentId, {
    ...c,
    resolvedAt: c.resolvedAt ? null : Date.now(),
  });
}

/** Hard-delete a comment (and all replies). */
export function deleteComment(doc: Y.Doc, commentId: string): void {
  getCommentsMap(doc).delete(commentId);
}

/** Resolve the absolute (current) text positions for a comment.
 *  Returns null when the anchor no longer maps anywhere — happens when
 *  the entire commented range was deleted by another peer. */
export function resolveAnchor(
  doc: Y.Doc,
  comment: Comment,
): { from: number; to: number } | null {
  const start = decodeRel(comment.anchorStart);
  const end = decodeRel(comment.anchorEnd);
  if (!start || !end) return null;
  const a = Y.createAbsolutePositionFromRelativePosition(start, doc);
  const b = Y.createAbsolutePositionFromRelativePosition(end, doc);
  if (!a || !b) return null;
  return { from: Math.min(a.index, b.index), to: Math.max(a.index, b.index) };
}

/** All comments, newest first; optionally filtered to unresolved. */
export function listComments(
  doc: Y.Doc,
  opts: { onlyOpen?: boolean } = {},
): Comment[] {
  const map = getCommentsMap(doc);
  const all = [...map.values()] as Comment[];
  const filtered = opts.onlyOpen ? all.filter((c) => !c.resolvedAt) : all;
  return filtered.sort((a, b) => b.createdAt - a.createdAt);
}

/** Subscribe to comment-map changes. Returns an unsubscribe fn. */
export function onCommentsChanged(doc: Y.Doc, cb: () => void): () => void {
  const map = getCommentsMap(doc);
  map.observeDeep(cb);
  return () => map.unobserveDeep(cb);
}
