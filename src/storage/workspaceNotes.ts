/** Every Markdown note in the workspace with its text (unreadable files skipped). */
import { isOPFSAvailable, listWorkspace, readWorkspaceFile } from "./workspace";

export async function readAllNotes(): Promise<Array<{ path: string; text: string }>> {
  if (!isOPFSAvailable()) return [];
  const notes: Array<{ path: string; text: string }> = [];
  for (const f of await listWorkspace({ includeAssets: false })) {
    if (!/\.(md|markdown)$/i.test(f.path)) continue;
    try {
      notes.push({ path: f.path, text: await readWorkspaceFile(f.path) });
    } catch {
      /* why: unreadable: skip */
    }
  }
  return notes;
}
