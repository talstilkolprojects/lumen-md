/**
 * When the vault is replaced by a different one without copying (plan 4.2:
 * "Open a folder as the vault", "Use browser storage"), the open notes
 * belong to the old vault. Their paths may exist in the new one with other
 * content, so autosaving them there would overwrite a file. They are
 * detached instead: kept open with their text, marked unsaved, and no
 * longer tied to a vault path — the user can save them on purpose.
 */
import { flushPendingEdits, tabIdOf, useAppStore } from "./useStore";

/** `name`, or `name (2)`, `name (3)`… before the extension: the first one not in `taken`. */
function uniqueName(name: string, taken: Set<string>): string {
  if (!taken.has(name)) return name;
  const ext = /\.[^./]+$/.exec(name)?.[0] ?? "";
  const stem = name.slice(0, name.length - ext.length);
  for (let i = 2; ; i++) {
    const candidate = `${stem} (${i})${ext}`;
    if (!taken.has(candidate)) return candidate;
  }
}

export function detachWorkspaceDocs(): void {
  flushPendingEdits();
  useAppStore.setState((state) => {
    // A detached note is identified by its name (tabIdOf), so two notes
    // with one name (Clips/a.md, Notes/a.md) or an unsaved tab of that name
    // would share an id: each detached note gets a name no other tab has.
    const taken = new Set(state.openTabs.filter((t) => !t.workspaceName).map((t) => t.id));
    const renamed = new Map<string, string>();
    const openTabs = state.openTabs.map((t) => {
      if (!t.workspaceName) return t;
      const name = uniqueName(tabIdOf({ workspaceName: null, name: t.name }), taken);
      taken.add(name);
      renamed.set(t.workspaceName, name);
      return { ...t, id: name, name, workspaceName: null, dirty: true };
    });
    const d = state.doc;
    let doc = d;
    if (d.workspaceName) {
      // The open note follows its own tab (or, without one, gets a free name).
      const name = renamed.get(d.workspaceName) ?? uniqueName(tabIdOf({ workspaceName: null, name: d.name }), taken);
      doc = { ...d, name, workspaceName: null, dirty: true };
    }
    return { doc, openTabs };
  });
}
