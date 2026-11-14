/**
 * Notes locked with their own password that are open right now (plan W5.11,
 * part 3). Tiny on purpose: the startup code (workspace writes, the store's
 * persistence, history) asks it two questions, and the crypto loads only when
 * a note is locked or unlocked (./lockedNote.ts).
 *
 * For each unlocked note it holds the latest sealed file text, so anything
 * that keeps note text at rest (localStorage, history) keeps the sealed text
 * instead of the plain one.
 */

/** First line of a note locked with its own password. */
export const LOCKED_NOTE_MAGIC = "<!-- lumen-locked-note v1 -->";

/** Is this file text a sealed (locked) note? */
export function isSealedNote(text: string): boolean {
  return text.startsWith(LOCKED_NOTE_MAGIC);
}

/** Per open locked note: its sealed text, and the key (opaque here; ./lockedNote.ts owns it). */
const open = new Map<string, { sealed: string; key: unknown }>();

/** The workspace write hook: plain text in, what goes on disk out. */
export type NoteSealer = (path: string, content: string) => Promise<string>;
let sealer: NoteSealer | null = null;

export const lockedNotes = {
  /** Is `path` a locked note that is open (unlocked) in this session? */
  has: (path: string): boolean => open.has(path),
  /** The sealed text of an unlocked note (what is on disk). */
  sealed: (path: string): string | undefined => open.get(path)?.sealed,
  key: (path: string): unknown => open.get(path)?.key,
  set: (path: string, sealed: string, key: unknown): void => void open.set(path, { sealed, key }),
  delete: (path: string): boolean => open.delete(path),
  /** Follow a rename, so the new name is sealed too. */
  rename: (from: string, to: string): void => {
    const s = open.get(from);
    if (s === undefined || from === to) return;
    open.delete(from);
    open.set(to, s);
  },
  paths: (): string[] => [...open.keys()],
  /** Text safe to keep at rest for `path`: the sealed file when it is a locked note. */
  atRest: (path: string | null | undefined, content: string): string => (path && open.has(path) ? (open.get(path) as { sealed: string }).sealed : content),
};

export function setNoteSealer(s: NoteSealer | null): void {
  sealer = s;
}

export function noteSealer(): NoteSealer | null {
  return sealer;
}
