/**
 * Right-side panel that lists every comment on the active collab doc.
 *
 * Layout mirrors the Tags / Backlinks panels for consistency:
 *   • Header with comment count + filter toggle (all / unresolved).
 *   • A vertical list of cards. Each card shows the author chip, the
 *     anchored text excerpt (resolved through Y.RelativePosition), the
 *     comment body, and any replies.
 *   • Click a card → scrolls the editor + selects the anchored range.
 *   • Per-card actions: ✓ resolve, ✕ delete, ↩ reply.
 *
 * The panel only mounts when a CollabSession is active (no point
 * showing comments on a local-only doc).
 */

import { useEffect, useState } from "react";
import { Check, MessageSquare, Reply, Trash2, X } from "lucide-react";
import {
  addComment as addCommentApi,
  deleteComment,
  listComments,
  onCommentsChanged,
  replyToComment,
  resolveAnchor,
  toggleResolved,
  type Comment,
} from "../collab/comments";
import type { CollabSession } from "../collab/yjs";
import { t, getLocale } from "../i18n";
import { scrollBehavior } from "../lib/motion";

interface Props {
  open: boolean;
  onClose: () => void;
  collab: CollabSession;
  /** Editor handle so the panel can scroll/select to the anchored range. */
  onJump?: (from: number, to: number) => void;
}

export function CommentsPanel({ open, onClose, collab, onJump }: Props) {
  const [comments, setComments] = useState<Comment[]>([]);
  const [showResolved, setShowResolved] = useState(false);
  const [replyingTo, setReplyingTo] = useState<string | null>(null);
  const [replyBody, setReplyBody] = useState("");
  const [focusedId, setFocusedId] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    const refresh = () =>
      setComments(listComments(collab.doc, { onlyOpen: !showResolved }));
    refresh();
    return onCommentsChanged(collab.doc, refresh);
  }, [open, collab.doc, showResolved]);

  // Listen for `lumen-comment-focus` events fired when the user clicks
  // a comment decoration in the editor — scroll the matching thread
  // into view + highlight it briefly.
  useEffect(() => {
    if (!open) return;
    const handler = (e: Event) => {
      const id = (e as CustomEvent<{ id: string }>).detail?.id;
      if (!id) return;
      setFocusedId(id);
      // Defer the scroll until after React has flushed the focused-row
      // class so the highlight is visible at scroll target time.
      setTimeout(() => {
        const el = document.querySelector(
          `[data-comment-row-id="${id}"]`,
        ) as HTMLElement | null;
        el?.scrollIntoView({ behavior: scrollBehavior(), block: "center" });
      }, 16);
      // Clear the focus halo after 1.5s.
      const t = window.setTimeout(() => setFocusedId(null), 1500);
      return () => window.clearTimeout(t);
    };
    window.addEventListener("lumen-comment-focus", handler);
    return () => window.removeEventListener("lumen-comment-focus", handler);
  }, [open]);

  if (!open) return null;

  const total = comments.length;
  const unresolvedCount = listComments(collab.doc, { onlyOpen: true }).length;

  return (
    <aside
      role="complementary"
      aria-label={t("commentsPanel.title")}
      style={{
        position: "fixed",
        insetInlineEnd: 0,
        top: 48,
        bottom: 0,
        width: 320,
        background: "hsl(var(--bg))",
        borderInlineStart: "1px solid hsl(var(--border))",
        zIndex: 70,
        display: "flex",
        flexDirection: "column",
      }}
    >
      <header
        style={{
          display: "flex",
          alignItems: "center",
          gap: 8,
          padding: "10px 14px",
          borderBottom: "1px solid hsl(var(--border))",
        }}
      >
        <MessageSquare size={14} aria-hidden />
        <span style={{ fontWeight: 600, fontSize: 13 }}>
          {t("commentsPanel.title")}
        </span>
        <span style={{ marginInlineStart: 6, fontSize: 11, color: "hsl(var(--fg-muted))" }}>
          {t("commentsPanel.summary", {
            unresolved: String(unresolvedCount),
            total: String(comments.length + (showResolved ? 0 : 0)),
          })}
        </span>
        <button
          type="button"
          onClick={() => setShowResolved((v) => !v)}
          aria-pressed={showResolved}
          title={t(showResolved ? "commentsPanel.hideResolved" : "commentsPanel.showResolved")}
          style={{
            marginInlineStart: "auto",
            padding: "3px 9px",
            fontSize: 10,
            border: "1px solid hsl(var(--border))",
            borderRadius: 999,
            background: showResolved ? "hsl(var(--accent) / 0.18)" : "hsl(var(--bg-subtle))",
            color: showResolved ? "hsl(var(--accent))" : "hsl(var(--fg))",
            cursor: "pointer",
          }}
        >
          {showResolved ? t("commentsPanel.viewAll") : t("commentsPanel.viewOpen")}
        </button>
        <button
          type="button"
          onClick={onClose}
          aria-label={t("commentsPanel.close")}
          style={{
            border: "none",
            background: "transparent",
            color: "hsl(var(--fg-muted))",
            cursor: "pointer",
            padding: 4,
          }}
        >
          <X size={14} />
        </button>
      </header>

      <div style={{ flex: 1, overflowY: "auto", padding: "8px 12px 24px" }}>
        {total === 0 && (
          <div style={{ padding: 16, fontSize: 12, color: "hsl(var(--fg-muted))", lineHeight: 1.5 }}>
            {t("commentsPanel.empty")}
          </div>
        )}

        {comments.map((c) => {
          const anchor = resolveAnchor(collab.doc, c);
          const excerpt = anchor
            ? collab.ytext.toString().slice(anchor.from, Math.min(anchor.to, anchor.from + 80))
            : "";
          return (
            <article
              key={c.id}
              data-comment-row-id={c.id}
              style={{
                marginBottom: 10,
                padding: 10,
                background: c.resolvedAt
                  ? "hsl(140 60% 50% / 0.08)"
                  : "hsl(var(--bg-subtle))",
                border: `1px solid ${
                  c.resolvedAt ? "hsl(140 60% 50% / 0.30)" : "hsl(var(--border))"
                }`,
                borderRadius: 8,
                fontSize: 12.5,
                lineHeight: 1.5,
                outline:
                  focusedId === c.id
                    ? "2px solid hsl(var(--accent))"
                    : "2px solid transparent",
                outlineOffset: 2,
                boxShadow:
                  focusedId === c.id
                    ? "0 0 0 4px hsl(var(--accent) / 0.18)"
                    : "none",
                transition: "outline-color 200ms ease, box-shadow 200ms ease",
              }}
            >
              <header style={{ display: "flex", alignItems: "center", gap: 6, marginBottom: 6 }}>
                <span
                  aria-hidden
                  style={{
                    width: 14,
                    height: 14,
                    borderRadius: 999,
                    background: c.authorColor,
                    flexShrink: 0,
                  }}
                />
                <span style={{ fontWeight: 600 }}>{c.authorName}</span>
                <span style={{ fontSize: 10, color: "hsl(var(--fg-muted))" }}>
                  {new Date(c.createdAt).toLocaleString(getLocale())}
                </span>
                <button
                  type="button"
                  onClick={() => toggleResolved(collab.doc, c.id)}
                  aria-label={t(c.resolvedAt ? "commentsPanel.reopen" : "commentsPanel.resolve")}
                  title={t(c.resolvedAt ? "commentsPanel.reopen" : "commentsPanel.resolve")}
                  style={iconBtn(c.resolvedAt ? "hsl(140 60% 60%)" : "hsl(var(--fg-muted))")}
                >
                  <Check size={11} />
                </button>
                <button
                  type="button"
                  onClick={() => deleteComment(collab.doc, c.id)}
                  aria-label={t("commentsPanel.delete")}
                  title={t("commentsPanel.delete")}
                  style={iconBtn("hsl(0 80% 65%)")}
                >
                  <Trash2 size={11} />
                </button>
              </header>

              {excerpt && (
                <button
                  type="button"
                  onClick={() => anchor && onJump?.(anchor.from, anchor.to)}
                  title={t("commentsPanel.jump")}
                  style={{
                    width: "100%",
                    border: "none",
                    background: "hsl(var(--accent) / 0.10)",
                    color: "hsl(var(--accent))",
                    padding: "5px 7px",
                    borderRadius: 4,
                    fontSize: 11,
                    textAlign: "start",
                    cursor: "pointer",
                    marginBottom: 6,
                    fontFamily: "JetBrains Mono, ui-monospace, monospace",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                    whiteSpace: "nowrap",
                  }}
                >
                  "{excerpt}"
                </button>
              )}

              <div>{c.body}</div>

              {c.replies.length > 0 && (
                <ul style={{ margin: "8px 0 0", padding: 0, listStyle: "none", borderInlineStart: "2px solid hsl(var(--border))" }}>
                  {c.replies.map((r) => (
                    <li key={r.id} style={{ paddingInlineStart: 10, marginTop: 6, fontSize: 12 }}>
                      <strong style={{ color: r.authorColor }}>{r.authorName}</strong>{" "}
                      <span style={{ color: "hsl(var(--fg-muted))", fontSize: 10 }}>
                        {new Date(r.createdAt).toLocaleTimeString(getLocale())}
                      </span>
                      <div>{r.body}</div>
                    </li>
                  ))}
                </ul>
              )}

              {replyingTo === c.id ? (
                <form
                  onSubmit={(e) => {
                    e.preventDefault();
                    if (!replyBody.trim()) return;
                    replyToComment(collab.doc, c.id, replyBody, collab.user);
                    setReplyBody("");
                    setReplyingTo(null);
                  }}
                  style={{ marginTop: 8 }}
                >
                  <input
                    autoFocus
                    value={replyBody}
                    onChange={(e) => setReplyBody(e.target.value)}
                    placeholder={t("commentsPanel.replyPlaceholder")}
                    aria-label={t("commentsPanel.replyPlaceholder")}
                    style={{
                      width: "100%",
                      padding: "5px 8px",
                      fontSize: 12,
                      border: "1px solid hsl(var(--border))",
                      borderRadius: 4,
                      background: "hsl(var(--bg))",
                      color: "hsl(var(--fg))",
                    }}
                  />
                </form>
              ) : (
                <button
                  type="button"
                  onClick={() => setReplyingTo(c.id)}
                  style={{
                    marginTop: 6,
                    padding: 0,
                    border: "none",
                    background: "transparent",
                    color: "hsl(var(--accent))",
                    fontSize: 11,
                    cursor: "pointer",
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 4,
                  }}
                >
                  <Reply size={11} />
                  {t("commentsPanel.reply")}
                </button>
              )}
            </article>
          );
        })}
      </div>
    </aside>
  );
}

const iconBtn = (color: string): React.CSSProperties => ({
  marginInlineStart: "auto",
  padding: 3,
  border: "none",
  background: "transparent",
  color,
  cursor: "pointer",
  borderRadius: 4,
});

/** Convenience: add a comment from the editor's current selection. Returns
 *  the new comment id, or null when no selection / no collab. */
export function addCommentFromSelection(
  collab: CollabSession,
  body: string,
  from: number,
  to: number,
): string | null {
  if (!body.trim() || from === to) return null;
  const c = addCommentApi(collab.doc, collab.ytext, body, from, to, collab.user);
  return c.id;
}
