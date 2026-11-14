/**
 * "Delete attachments too" (plan W7.3): before notes go to the trash, find
 * the attachments that only they link to and, as the setting says, ask or
 * add them to the same delete, so one Undo / Ctrl+Z brings back all of it.
 * Loaded with a dynamic import by the file tree.
 */

import { t } from "../i18n";
import "./attachmentCleanupStrings";
import { orphanAttachments } from "./attachmentRefs";
import { attachmentPolicy, setAttachmentPolicy } from "./attachmentPolicy";
import { indexedNotes, workspaceTree } from "./workspaceIndex";
import { readWorkspaceFile, type WorkspaceNode } from "./workspace";
import { uiSelect } from "../ui/PromptDialog";
import { log } from "../lib/logger";

function filesOf(nodes: readonly WorkspaceNode[], out: string[] = []): string[] {
  for (const n of nodes) {
    if (n.kind === "file") out.push(n.path);
    else if (n.children) filesOf(n.children, out);
  }
  return out;
}

/** The attachments only `paths` link to (nothing is asked). */
export async function orphansOf(paths: readonly string[]): Promise<string[]> {
  const files = filesOf(await workspaceTree());
  const notes: Array<{ path: string; content: string }> = (await indexedNotes()).map((n) => ({ path: n.path, content: n.content }));
  const indexed = new Set(notes.map((n) => n.path));
  // Canvas and base files are not in the note index, and they can link to images too.
  for (const f of files) {
    if (indexed.has(f) || !/\.(canvas|base)$/i.test(f)) continue;
    try {
      notes.push({ path: f, content: await readWorkspaceFile(f) });
    } catch (e) {
      // Unreadable: its links are unknown, so nothing it could name is offered.
      log.warn("attachments: could not read", f, e);
      notes.push({ path: f, content: files.join("\n") });
    }
  }
  return orphanAttachments({ deleted: paths, notes, files });
}

/** The extra paths to move to the trash with `paths`, after asking when the setting says so. */
export async function attachmentsToTrash(paths: readonly string[]): Promise<string[]> {
  const policy = attachmentPolicy();
  if (policy === "never" || !paths.some((p) => !/\.[^/]+$/.test(p) || /\.(md|markdown|canvas|base)$/i.test(p))) return [];
  const orphans = await orphansOf(paths);
  if (!orphans.length || policy === "always") return orphans;
  const shown = orphans.slice(0, 8).join("\n") + (orphans.length > 8 ? "\n…" : "");
  const choice = await uiSelect({
    title: t("attachCleanup.ask.title"),
    message: t("attachCleanup.ask.message", { n: String(orphans.length), list: shown }),
    choices: [
      { value: "trash", label: t("attachCleanup.ask.trash") },
      { value: "keep", label: t("attachCleanup.ask.keep") },
      { value: "always", label: t("attachCleanup.ask.always") },
      { value: "never", label: t("attachCleanup.ask.never") },
    ],
  });
  if (choice === "always") setAttachmentPolicy("always");
  if (choice === "never") setAttachmentPolicy("never");
  return choice === "trash" || choice === "always" ? orphans : [];
}
