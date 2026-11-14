/**
 * The Hebrew word under the pointer or the cursor (plan W5.26): small, so
 * the editor can decide on right-click whether to open the lexicon before
 * any of it loads.
 */
import type { EditorView } from "@codemirror/view";

/** The Hebrew word at `pos` in the editor: [from, to) or null. */
export function wordAt(view: EditorView, pos: number): { from: number; to: number; word: string } | null {
  const line = view.state.doc.lineAt(pos);
  const text = line.text;
  const at = pos - line.from;
  const isWord = (c: string) => /[\u05D0-\u05EA\u0591-\u05BD\u05BF-\u05C7'"׳״]/.test(c);
  let a = at;
  let b = at;
  while (a > 0 && isWord(text[a - 1])) a--;
  while (b < text.length && isWord(text[b])) b++;
  const word = text.slice(a, b).replace(/^["'׳״]+|["'׳״]+$/g, "");
  if (!/[א-ת]/.test(word)) return null;
  const lead = text.slice(a, b).indexOf(word);
  return { from: line.from + a + lead, to: line.from + a + lead + word.length, word };
}
