/**
 * Saving a clip into the library (T34), loaded on use: the palette's
 * startup code only holds a call to it.
 */
import { getLocale, t } from "../i18n";
import { useAppStore } from "../store/useStore";
import { showAiToast } from "../ui/AiToast";

/** Save into the library folder and open it; without OPFS, open it as an unsaved document (`openDoc`). */
export async function saveClipToLibrary(clip: { title: string; markdown: string }, openDoc: (base: string, content: string) => void): Promise<void> {
  const { clipFileName, libraryDir } = await import("./clipper");
  const { writeWorkspaceFile, workspaceHasEntry, isOPFSAvailable } = await import("../storage/workspace");
  const name = clipFileName(clip.title);
  if (!isOPFSAvailable()) {
    // Nothing was written: open it as an unsaved (dirty) document in its own
    // tab, so closing the tab or the page warns instead of losing the clip.
    openDoc(name.replace(/\.md$/, ""), clip.markdown);
    return;
  }
  const dir = libraryDir(getLocale());
  let path = `${dir}/${name}`;
  for (let i = 2; await workspaceHasEntry(path); i++) path = `${dir}/${name.replace(/\.md$/, "")} (${i}).md`;
  await writeWorkspaceFile(path, clip.markdown);
  window.dispatchEvent(new Event("lumen-workspace-changed"));
  useAppStore.getState().openTab({ name: path.split("/").pop()!, content: clip.markdown, workspaceName: path });
  showAiToast(t("clip.saved", { path }), "success");
}
