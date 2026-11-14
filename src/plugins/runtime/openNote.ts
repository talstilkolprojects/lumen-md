/** Open the note a plugin's `noteLink` names, the way a [[wiki link]] does. */
import { resolveWikiTarget, splitWikiTarget } from "../../renderer/wikiLinks";

export async function openPluginNoteLink(target: string): Promise<boolean> {
  const { note } = splitWikiTarget(target);
  if (!note) return false;
  const { listWorkspace } = await import("../../storage/workspace");
  const path = resolveWikiTarget(note, (await listWorkspace()).map((f) => f.path));
  if (!path) return false;
  window.dispatchEvent(new CustomEvent("lumen-open-file", { detail: { path } }));
  return true;
}
