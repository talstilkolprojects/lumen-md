/**
 * Load a note's language tag and its font on demand (plan W7.9), for the
 * editor and the preview: nothing of text/noteLanguage.ts (its Yiddish and
 * Ladino tables) is in the startup bundle, and a note with no front matter
 * `lang:` and no Hebrew letter never loads it.
 */
/** Worth loading the language module for: a front matter `lang:` or any Hebrew letter. */
export function mayHaveLanguage(head: string): boolean {
  return /^---[\s\S]*?^(?:lang|language):/m.test(head) || /[א-ת]/.test(head);
}

/** Load the reading face a language wants (once; the face is same-origin, never a CDN). */
export async function ensureLanguageFont(tag: string | null): Promise<void> {
  const { wantsHebrewFont } = await import("./noteLanguage");
  if (!wantsHebrewFont(tag)) return;
  const { loadReadingFont, readingFont } = await import("../reading/fonts");
  const face = readingFont("notoSans");
  if (face) await loadReadingFont(face);
}

/** The tag for a document's first 4000 characters, or null. */
export async function documentLanguage(doc: string): Promise<string | null> {
  const head = doc.slice(0, 4000);
  if (!mayHaveLanguage(head)) return null;
  const { noteLanguage } = await import("./noteLanguage");
  return noteLanguage(head)?.tag ?? null;
}

