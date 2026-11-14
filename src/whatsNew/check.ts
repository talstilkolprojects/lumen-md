/**
 * "What's new" (plan 14.6): after an update the app shows that version's
 * notes once, in the interface's language. A fresh install shows nothing
 * (there is nothing "new" to someone who just arrived); it only remembers
 * the version. "Help: What's new" opens the notes any time.
 */
import "./strings";

export const SEEN_KEY = "lumen.whatsNew.seen";

export interface Storage {
  getItem(k: string): string | null;
  setItem(k: string, v: string): void;
}

/** Is this an existing install? (The app's persisted state or the tour mark is there.) */
const usedBefore = (s: Storage) => s.getItem("lumen-md") !== null || s.getItem("lumen-tour-done") !== null;

/**
 * What to do at start: "show" (an update: the notes of `version`, once), or
 * "skip" (seen already, a fresh install, or no notes). Records the version
 * whenever it decides, so the notes come once per version.
 */
export function decide(version: string, s: Storage, hasNotes: boolean): "show" | "skip" {
  let seen: string | null = null;
  try {
    seen = s.getItem(SEEN_KEY);
  } catch {
    return "skip";
  }
  if (seen === version) return "skip";
  const fresh = seen === null && !usedBefore(s);
  try {
    s.setItem(SEEN_KEY, version);
  } catch {
    // why: storage is blocked or full (private mode, quota): the notes show again next launch
    /* private mode: shown again next time is better than never */
  }
  return !fresh && hasNotes ? "show" : "skip";
}

/** The notes in `locale` (its region-less form too), else English. */
export function notesFor(notes: import("../../scripts/lib/whats-new.mjs").WhatsNew | null, locale: string) {
  if (!notes) return null;
  const n = notes.notes[locale] ?? notes.notes[locale.split("-")[0]] ?? notes.notes.en;
  return n ? { version: notes.version, date: notes.date, ...n } : null;
}

export async function loadNotes(): Promise<import("../../scripts/lib/whats-new.mjs").WhatsNew | null> {
  return (await import("virtual:lumen-whats-new")).default;
}

/** At start (called once, when the app is idle). */
export async function checkWhatsNew(): Promise<void> {
  const notes = await loadNotes().catch(() => null);
  if (decide(__LUMEN_VERSION__, localStorage, !!notes?.notes.en?.markdown) === "show") await openWhatsNew(notes);
}

/** "Help: What's new". */
export async function openWhatsNew(preloaded?: Awaited<ReturnType<typeof loadNotes>>): Promise<void> {
  const notes = preloaded ?? (await loadNotes().catch(() => null));
  const { getLocale } = await import("../i18n");
  const { showWhatsNew } = await import("./WhatsNewDialog");
  showWhatsNew(notesFor(notes, getLocale()), __LUMEN_VERSION__);
}
