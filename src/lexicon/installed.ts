/**
 * Is the Hebrew lexicon pack (plan W5.26) on this device? A synchronous flag
 * the editor reads on right-click, so nothing of the lexicon loads until it
 * is installed. Set and cleared by ./store.ts.
 */
export const LEXICON_FLAG = "lumen.lexicon.he";

export function lexiconInstalled(): boolean {
  try {
    return localStorage.getItem(LEXICON_FLAG) === "1";
  } catch {
    return false;
  }
}
