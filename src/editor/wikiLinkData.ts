/**
 * Where `[[` completion (4.5) gets its notes, and how it creates one.
 *
 * The notes come from the shared workspace index (`workspaceIndex`) — the
 * one backlinks, search and tags read — never from an index of its own.
 */

import { ensureIndex, indexVersion, indexedFiles, indexedNoteText } from "../storage/workspaceIndex";
import { basename, createWorkspaceFile, isOPFSAvailable } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import { findNote, noteCatalog, type CurrentNote, type NoteCatalog, type WikiQuery, type WikiSuggestion } from "./wikiComplete";
import { explainError } from "../lib/userError";

/**
 * The notes to complete. Once the index is built, answers from it at once
 * and lets the refresh (re-reading files that changed) run behind; only
 * the very first use waits for the build.
 *
 * W6.36: the catalog is made from the index summaries (name, path, aliases),
 * not from every note's text. A `[[Note#` or `[[Note^` completion needs one
 * note's headings or blocks: pass the `query`, and that note's text alone is
 * read from the index.
 */
export async function linkCatalog(query?: WikiQuery | null, current?: CurrentNote): Promise<NoteCatalog> {
  if (!isOPFSAvailable()) return noteCatalog([]);
  const refresh = ensureIndex().catch(() => undefined);
  if (!indexedFiles().length) await refresh;
  // Rebuilt only when the index changed — not on every keystroke.
  const version = indexVersion();
  if (memo?.version !== version) memo = { version, catalog: noteCatalog(indexedFiles()) };
  const catalog = memo.catalog;
  if (!query || query.kind === "note" || !query.note.trim()) return catalog;
  const e = findNote(catalog, query.note);
  if (!e || e.path === current?.path) return catalog;
  const content = await indexedNoteText(e.path);
  if (content === null) return catalog;
  const filled = { ...e, content };
  return { ...catalog, notes: catalog.notes.map((n) => (n === e ? filled : n)) };
}

let memo: { version: number; catalog: NoteCatalog } | null = null;

/** A new note can be created only in a workspace. */
export const canCreateNotes = (): boolean => isOPFSAvailable();

/** The open note: its path in the workspace (if any) and its current text. */
export function currentNote(content?: string): CurrentNote {
  const doc = useAppStore.getState().doc;
  return { path: doc.workspaceName ?? null, content: content ?? doc.content };
}

/**
 * Create the note a just-inserted link points at: `# Name` and a blank
 * line, like a new note from the file tree. Never overwrites — when the
 * path exists already (the index hadn't seen it yet, or another tab / sync /
 * agent created it a moment ago), the link resolves to it. The check and the
 * write are one locked step (`createWorkspaceFile`), not check-then-write.
 */
export async function createLinkedNote(path: string): Promise<boolean> {
  const name = basename(path).replace(/\.(md|markdown)$/i, "");
  try {
    if (!(await createWorkspaceFile(path, `# ${name}\n\n`))) return false;
    notifyWorkspaceChanged({ kind: "structure", paths: [path] });
    showAiToast(t("wikiComplete.created", { name }), "success");
    return true;
  } catch (e) {
    showAiToast(t("wikiComplete.createFailed", { name, error: explainError(e) }), "error");
    return false;
  }
}

/** The option's label and detail as shown (UI strings live here, not in the shared core). */
export function displayOf(s: WikiSuggestion): { label: string; detail?: string } {
  switch (s.kind) {
    case "create":
      return { label: t("wikiComplete.create", { name: s.label }) };
    case "alias":
      return { label: s.label, detail: t("wikiComplete.aliasOf", { name: s.detail ?? "" }) };
    case "block":
      return { label: `^${s.label}`, detail: s.detail };
    default:
      return { label: s.label, detail: s.detail };
  }
}
