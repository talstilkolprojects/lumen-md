/**
 * How a Properties-panel edit reaches the note (plan 4.10): as one minimal
 * change, and — while suggesting mode is on — as a tracked change
 * (CriticMarkup), like typing, never applied directly.
 */
import type { TransactionSpec } from "@codemirror/state";
import { applyChange, editKindFor, transformEdit, type PlainChange } from "./suggesting";

/** The one change that turns `cur` into `next` (common prefix and suffix kept), or null when equal. */
export function minimalChange(cur: string, next: string): PlainChange | null {
  if (next === cur) return null;
  let from = 0;
  while (from < cur.length && from < next.length && cur[from] === next[from]) from++;
  let end = 0;
  while (end < cur.length - from && end < next.length - from && cur[cur.length - 1 - end] === next[next.length - 1 - end]) end++;
  return { from, to: cur.length - end, insert: next.slice(from, next.length - end) };
}

/**
 * The source editor transaction for the edit. It is tagged as user input,
 * so the suggesting filter (which only rewrites `input` / `delete` events)
 * records it as a suggestion while suggesting mode is on.
 */
export function propertiesTransaction(change: PlainChange): TransactionSpec {
  return { changes: change, userEvent: "input.properties" };
}

/**
 * The note's new text when no source editor is mounted (WYSIWYG, Preview):
 * the edit as the suggesting filter would record it, or `null` when it
 * can't be tracked unambiguously (the caller says so instead of applying it).
 */
export function trackedPropertiesText(cur: string, change: PlainChange, author: string | null): string | null {
  const kind = editKindFor("input.properties", change.from, change.to, change.insert);
  const res = kind ? transformEdit(cur, { ...change, kind, author }) : null;
  if (!res) return applyChange(cur, change);
  if (res.untrackable) return null;
  return applyChange(cur, res.change);
}
