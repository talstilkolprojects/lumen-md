/** Open content as a new note in its own tab (templates, shared notes, reports). */
import { tabIdOf, useAppStore } from "../store/useStore";

/**
 * Open a template as a NEW unsaved tab. Never writes into the active
 * document (that would overwrite its unsaved content), and never reuses an
 * open tab of the same name (that would ignore the template body):
 * "Meeting notes.md" → "Meeting notes 2.md" → …
 */
export function openTemplateDoc(base: string, content: string): void {
  openNewDoc(base, content, true);
}

/**
 * Open `content` as a new note in its own tab, under a name no open tab
 * uses ("Shared.md" → "Shared 2.md"), so it never lands on — and later
 * overwrites — an existing tab of that name. `dirty`: it holds unsaved
 * content (a template, a shared note), unlike an empty new document.
 */
export function openNewDoc(base: string, content: string, dirty: boolean): void {
  const st = useAppStore.getState();
  const currentId = tabIdOf(st.doc);
  if (st.doc.content && !st.openTabs.some((tab) => tab.id === currentId)) {
    // The active doc has no tab (e.g. after a rename): give it one first so
    // switching to the template can't drop it.
    useAppStore.setState((s) => ({
      openTabs: [
        ...s.openTabs,
        {
          id: currentId,
          name: s.doc.name,
          content: s.doc.content,
          workspaceName: s.doc.workspaceName ?? null,
          dirty: s.doc.dirty,
        },
      ],
    }));
  }
  const taken = new Set(useAppStore.getState().openTabs.map((tab) => tab.id));
  taken.add(currentId);
  let name = `${base}.md`;
  for (let i = 2; taken.has(tabIdOf({ workspaceName: null, name })); i++) name = `${base} ${i}.md`;
  useAppStore.getState().openTab({ name, content, workspaceName: null });
  if (dirty) useAppStore.getState().setDoc({ dirty: true });
}
