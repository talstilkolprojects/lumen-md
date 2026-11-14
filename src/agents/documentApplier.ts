/**
 * The editor's side of approving an agent's change (plan 5.11).
 *
 * A change to a document that is open — the active one, or another tab —
 * goes to its live text, unsaved edits included, instead of the file
 * underneath it (writing the file would be clobbered by the next save of
 * the open buffer). On the active document it goes through the editor
 * when CodeMirror shows it, so Undo takes it back; otherwise (Preview,
 * WYSIWYG) it has no undo history, and the result says so (`undoable`).
 * The document becomes unsaved like after any edit. With suggesting mode on, it is
 * recorded as a tracked change (CriticMarkup) attributed to the agent, so
 * it can still be accepted or rejected in place.
 *
 * A range change is placed by staging's `locateRange`, the same rule the
 * workspace-file path uses: exact offsets while the text is the one it was
 * computed on (approved changes in between are recorded with `recordEdit`
 * and mapped through, so several changes from one run can be approved in
 * any order), otherwise the replaced text with its surroundings, found
 * again exactly once, or a refusal.
 *
 * Which document: a change with a workspace path goes to the open
 * document with that path. One without (an untitled or imported
 * document) goes only to the document the run worked on, by the key the
 * runtime recorded (`docKey`) — the active one or another tab; when that
 * document is no longer open, or the change carries no key, it is refused
 * (`not-open`), never applied to whichever document happens to be active.
 *
 * Pure logic over a `DocumentHost` (App wires it to the store and the
 * CodeMirror view), so it is tested without a browser.
 */

import { editKindFor, sanitizeAuthor, transformEdit } from "../editor/suggesting";
import { locateRange, recordEdit, type DocumentApplier, type DocumentApplyResult } from "./staging";
import type { StagedChange } from "./types";

export interface TextEdit {
  from: number;
  to: number;
  insert: string;
}

export interface LiveDocument {
  /** Workspace path, or null for a document that is not in the workspace. */
  path: string | null;
  /** The text as the editor holds it (unsaved edits included). */
  text: string;
  /** The document's key while it is open (`docKey.ts`), when known. */
  key?: string;
}

export interface DocumentHost {
  /** The document in the editor, or null when none is open. */
  active(): LiveDocument | null;
  /** The other open tabs. */
  tabs(): Array<LiveDocument & { id: string }>;
  /**
   * Apply an edit to the active document's live text (through the editor
   * when it is mounted). True when an undo history took it (Undo reverts it).
   */
  editActive(edit: TextEdit): boolean;
  /** Replace a background tab's text (it becomes unsaved). */
  setTab(id: string, text: string): void;
  /** Suggesting mode: record approved changes as tracked changes. */
  suggesting(): boolean;
}

const isHigh = (c: number) => c >= 0xd800 && c <= 0xdbff;
const isLow = (c: number) => c >= 0xdc00 && c <= 0xdfff;

/** The smallest single edit turning `a` into `b` (never splitting a surrogate pair). */
export function minimalEdit(a: string, b: string): TextEdit {
  const max = Math.min(a.length, b.length);
  let p = 0;
  while (p < max && a.charCodeAt(p) === b.charCodeAt(p)) p++;
  if (p > 0 && isHigh(a.charCodeAt(p - 1))) p--;
  let s = 0;
  while (s < max - p && a.charCodeAt(a.length - 1 - s) === b.charCodeAt(b.length - 1 - s)) s++;
  if (s > 0 && isLow(a.charCodeAt(a.length - s))) s--;
  return { from: p, to: a.length - s, insert: b.slice(p, b.length - s) };
}

/** Who a tracked change is attributed to: the agent that proposed it. */
export function agentAuthor(change: Pick<StagedChange, "agentId">): string {
  return sanitizeAuthor(change.agentId ? `AI ${change.agentId}` : "AI") ?? "AI";
}

export function createDocumentApplier(host: DocumentHost): DocumentApplier {
  /** The open document the change is for; null: none is (the change goes to its workspace file); "gone": refused. */
  function target(change: StagedChange): { doc: LiveDocument; tab?: string } | null | "gone" {
    const active = host.active();
    if (change.path === null) {
      // No path: only the document the run worked on (it may have been
      // saved into the workspace since; its key stays the same).
      const key = change.kind === "range" ? change.docKey : undefined;
      if (!key) return "gone";
      if (active && active.key === key) return { doc: active };
      const tab = host.tabs().find((t) => t.key === key);
      return tab ? { doc: tab, tab: tab.id } : "gone";
    }
    if (active && active.path === change.path) return { doc: active };
    const tab = host.tabs().find((t) => t.path === change.path);
    return tab ? { doc: tab, tab: tab.id } : null;
  }

  function apply(doc: LiveDocument, tab: string | undefined, plain: TextEdit, change: StagedChange): DocumentApplyResult {
    let edit = plain;
    let asSuggestion = false;
    if (host.suggesting()) {
      const kind = editKindFor(plain.insert ? "input" : "delete.selection", plain.from, plain.to, plain.insert);
      // Null: inside a code block, where CriticMarkup is literal text;
      // untrackable: the text itself holds CriticMarkup delimiters. Both
      // are applied as a plain edit (the user approved the change itself).
      const res = kind ? transformEdit(doc.text, { ...plain, kind, author: agentAuthor(change) }) : null;
      if (res?.change && !res.untrackable) {
        edit = res.change;
        asSuggestion = true;
      }
    }
    const next = doc.text.slice(0, edit.from) + edit.insert + doc.text.slice(edit.to);
    let undoable: boolean | undefined;
    if (tab === undefined) undoable = host.editActive(edit);
    else host.setTab(tab, next);
    recordEdit(doc.text, next, edit);
    return { ok: true, to: tab === undefined ? "document" : "tab", ...(asSuggestion ? { asSuggestion: true } : {}), ...(undoable === false ? { undoable } : {}) };
  }

  return (change) => {
    const t = target(change);
    if (t === "gone") return { ok: false, conflict: "not-open" };
    if (!t) return null;
    if (change.kind === "file") {
      // The file is open: its live text must be what the change was computed from.
      if (t.doc.text !== (change.before ?? "")) return { ok: false, conflict: "open-unsaved" };
      return apply(t.doc, t.tab, minimalEdit(t.doc.text, change.after), change);
    }
    const at = locateRange(t.doc.text, change);
    if (!at) return { ok: false, conflict: "doc-changed" };
    if (at === "overlap") return { ok: false, conflict: "overlap" };
    return apply(t.doc, t.tab, { from: at.from, to: at.to, insert: change.after }, change);
  };
}
