/**
 * Writes from the database view (plan 4.10): a cell edit or a kanban move
 * changes one frontmatter value of one note, through the properties API
 * (4.9) — `setProperty` / `removeProperty` splice only that value's source,
 * so the rest of the file stays byte for byte.
 *
 * The open note is edited through its editor (one change: cursor, undo,
 * autosave and collab see it), any other note in the vault directly. Writes
 * to one note are queued, so two quick edits can't read the same old text.
 */

import { inferType, removeProperty, setProperty, type PropertyType, type PropertyValue } from "../properties/frontmatter";
import { readWorkspaceFile, writeWorkspaceFile } from "../storage/workspace";
import { notifyWorkspaceChanged } from "../storage/workspaceEvents";
import { useAppStore } from "../store/useStore";

/** Asks the app to apply `edit` to the open note (App.tsx); `done` reports whether it was. */
export const NOTE_EDIT_EVENT = "lumen-note-edit";

export interface NoteEditDetail {
  path: string;
  edit: (text: string) => string;
  done: (changed: boolean) => void;
}

const queues = new Map<string, Promise<unknown>>();

function queued<T>(path: string, job: () => Promise<T>): Promise<T> {
  const prev = queues.get(path) ?? Promise.resolve();
  const next = prev.catch(() => undefined).then(job);
  queues.set(path, next);
  void next.finally(() => {
    if (queues.get(path) === next) queues.delete(path);
  }).catch(() => undefined);
  return next;
}

/** Apply `edit` to a note's text. Resolves to whether the text changed; throws what `edit` throws (`FrontmatterError`). */
export function editNote(path: string, edit: (text: string) => string): Promise<boolean> {
  return queued(path, async () => {
    if (useAppStore.getState().doc.workspaceName === path) {
      let answer: boolean | null = null;
      let failure: unknown = null;
      const guarded = (text: string) => {
        try {
          return edit(text);
        } catch (e) {
          failure = e;
          return text;
        }
      };
      window.dispatchEvent(new CustomEvent<NoteEditDetail>(NOTE_EDIT_EVENT, { detail: { path, edit: guarded, done: (c) => (answer = c) } }));
      if (failure) throw failure;
      if (answer !== null) return answer;
      // No app to take it (tests, a page without the editor): the file it is.
    }
    // The note may also be open in a tab that isn't active: its copy (and
    // any unsaved edits in it) takes the change too, or switching back to it
    // would restore the old value and its next save would undo this one.
    // Computed first, so a frontmatter that doesn't parse there writes nothing.
    const { openTabs, doc } = useAppStore.getState();
    const activeTab = openTabs.find((t) => t.workspaceName === doc.workspaceName && t.workspaceName !== null)?.id;
    const tabEdits = openTabs.filter((t) => t.workspaceName === path && t.id !== activeTab).map((t) => ({ id: t.id, from: t.content, to: edit(t.content) }));
    const tabsChange = tabEdits.some((e) => e.to !== e.from);
    // Tabs take the change only once the file has it: a failed write leaves them as they were.
    const updateTabs = () =>
      tabsChange &&
      useAppStore.setState((st) => ({
        openTabs: st.openTabs.map((t) => {
          const e = tabEdits.find((x) => x.id === t.id);
          // Only if the tab still holds what the edit was made from.
          return e && t.content === e.from ? { ...t, content: e.to } : t;
        }),
      }));
    const text = await readWorkspaceFile(path);
    const next = edit(text);
    if (next === text) {
      updateTabs();
      return tabsChange;
    }
    await writeWorkspaceFile(path, next);
    updateTabs();
    notifyWorkspaceChanged({ kind: "content", paths: [path] });
    return true;
  });
}

/** Write one property of one note; `undefined` removes it. */
export function writeCell(path: string, key: string, value: PropertyValue | undefined): Promise<boolean> {
  return editNote(path, (text) => (value === undefined ? removeProperty(text, key) : setProperty(text, key, value)));
}

/** The type a column holds: its first value's, else what its name suggests. */
export function columnType(values: Iterable<unknown>, key: string): PropertyType {
  for (const v of values) if (v !== null && v !== undefined && v !== "") return inferType(v, key);
  return inferType(null, key);
}

/** A cell's typed text as the value to write (`null`: an empty value). */
export function parseCellInput(input: string, type: PropertyType): PropertyValue {
  const s = input.trim();
  switch (type) {
    case "number": {
      if (!s) return null;
      const n = Number(s);
      return Number.isFinite(n) ? n : s;
    }
    case "list":
      return s.split(",").map((x) => x.trim()).filter(Boolean);
    case "checkbox":
      return /^(true|yes|1|on|✓)$/i.test(s);
    default:
      return s || null;
  }
}

/** A value as the text of its cell editor. */
export function cellInputText(value: unknown): string {
  if (value === null || value === undefined) return "";
  if (Array.isArray(value)) return value.map(String).join(", ");
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  return String(value);
}
