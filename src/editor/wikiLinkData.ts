/**
 * Where `[[` completion (4.5) gets its notes, and how it creates one.
 *
 * The notes come from the shared workspace index (`workspaceIndex`) — the
 * one backlinks, search and tags read — never from an index of its own.
 */

import { ensureIndex, indexVersion, indexedFiles } from "../storage/workspaceIndex";
import { basename, createWorkspaceFile, isOPFSAvailable } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "../ui/AiToast";
import { t } from "../i18n";
import { noteCatalog, type CurrentNote, type NoteCatalog, type WikiSuggestion } from "./wikiComplete";

/**
 * The notes to complete. Once the index is built, answers from it at once
 * and lets the refresh (re-reading files that changed) run behind; only
 * the very first use waits for the build.
 */
export async function linkCatalog(): Promise<NoteCatalog> {
  if (!isOPFSAvailable()) return noteCatalog([]);
  const refresh = ensureIndex().catch(() => undefined);
  if (!indexedFiles().length) await refresh;
  // Rebuilt only when the index changed — not on every keystroke.
  const version = indexVersion();
  if (memo?.version !== version) memo = { version, catalog: noteCatalog(indexedFiles()) };
  return memo.catalog;
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
    showAiToast(t("wikiComplete.createFailed", { name, error: (e as Error)?.message ?? String(e) }), "error");
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
