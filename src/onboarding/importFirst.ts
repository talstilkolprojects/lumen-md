/**
 * Import-first onboarding (plan W11.P6, research R6.7): someone leaving
 * another app looks for their old notes first. The first run's last step
 * offers three ways in, next to the sample vault: an empty note, "bring
 * your notes" (six sources, into the import wizard of W1.26), and opening an
 * existing Obsidian folder as the vault (nothing copied).
 *
 * After an import, the wizard shows its report, a sample search over the
 * notes just imported, and Undo.
 */

export { FIRST_RUN_SOURCES, OPEN_IMPORT_EVENT, openImportWizard, readOpenImport, type OpenImportDetail, type StartPath } from "./importEvent";

/** Words too common to make a useful sample search (English and Hebrew). */
const STOP = new Set(
  "the and for with that this from have are was were you your not but all can will one our out into about what when then them they their there here just also more some than only very http https www com html note notes untitled image images file files png jpg pdf todo done של את על עם זה זו גם לא כן אני הוא היא הם הן אנחנו אתה את יש אין כל מה מי איך כמו אבל או אם כי רק עוד לפני אחרי בין היה היתה הייתה להיות שלי שלך פתק פתקים".split(" "),
);
/** A word: letters (any script) and marks, at least 3 of them, no digits. */
const WORD = /[\p{L}\p{M}]{3,}/gu;

/**
 * A word to search for in the notes just imported: the one found in the
 * most notes (then the most often, then the first in sort order), at least
 * 3 letters and not a stop word. Markdown syntax, links and front matter keys
 * count like text; HTML tags and URLs are dropped first. Null when the
 * import has no such word.
 */
export function sampleSearchQuery(notes: ReadonlyMap<string, string> | Iterable<[string, string]>): string | null {
  const inNotes = new Map<string, number>();
  const total = new Map<string, number>();
  for (const [path, text] of notes instanceof Map ? notes.entries() : notes) {
    if (!/\.(md|markdown)$/i.test(path)) continue;
    const clean = text.normalize("NFC").replace(/<[^>]*>/g, " ").replace(/\bhttps?:\/\/\S+/g, " ").toLocaleLowerCase();
    const seen = new Set<string>();
    for (const m of clean.matchAll(WORD)) {
      const w = m[0];
      if (STOP.has(w)) continue;
      total.set(w, (total.get(w) ?? 0) + 1);
      if (!seen.has(w)) {
        seen.add(w);
        inNotes.set(w, (inNotes.get(w) ?? 0) + 1);
      }
    }
  }
  let best: string | null = null;
  for (const w of inNotes.keys()) {
    if (best === null) {
      best = w;
      continue;
    }
    const a = [inNotes.get(w)!, total.get(w)!];
    const b = [inNotes.get(best)!, total.get(best)!];
    if (a[0] > b[0] || (a[0] === b[0] && (a[1] > b[1] || (a[1] === b[1] && w < best)))) best = w;
  }
  return best;
}

/** Open the app's search dialog on `query` (the event a saved search uses, plan W2.12). */
export function runSampleSearch(query: string): void {
  window.dispatchEvent(new CustomEvent("lumen-open-search", { detail: { query } }));
}
