/**
 * `[[` link completion in the source editor (4.5) — the always-loaded part.
 *
 * Registers a completion source that does nothing until the text before
 * the caret is an open `[[`; then it imports the real source
 * (`wikiLinkCompletion`, with the matching code and the note index glue),
 * so none of that is in the startup bundle.
 *
 * The source is language data, not an `autocompletion({ override })`: two
 * overrides can't be combined, and the TypeScript checks register theirs
 * the same way, so both work at once.
 */

import { autocompletion, completionKeymap, startCompletion, type CompletionSource } from "@codemirror/autocomplete";
import { EditorState, Prec, type Extension } from "@codemirror/state";
import { EditorView, keymap } from "@codemirror/view";

const OPEN_LINK = /\[\[[^[\]|\n]*$/;

let loaded: Promise<typeof import("./wikiLinkCompletion")> | null = null;

export const wikiLinkSource: CompletionSource = async (ctx) => {
  if (!ctx.matchBefore(OPEN_LINK)) return null;
  loaded ??= import("./wikiLinkCompletion");
  const { wikiLinkCompletions } = await loaded;
  return ctx.aborted ? null : wikiLinkCompletions(ctx);
};

const theme = EditorView.baseTheme({
  // Hebrew names read right to left inside an English UI, and vice versa.
  ".cm-tooltip-autocomplete .cm-completionLabel, .cm-tooltip-autocomplete .cm-completionDetail": { unicodeBidi: "plaintext" },
  ".cm-completionIcon-wiki-note:after": { content: "'▤'" },
  ".cm-completionIcon-wiki-alias:after": { content: "'≈'" },
  ".cm-completionIcon-wiki-heading:after": { content: "'#'" },
  ".cm-completionIcon-wiki-block:after": { content: "'^'" },
  ".cm-completionIcon-wiki-create:after": { content: "'+'" },
});

/**
 * The list's keys (↑ ↓ PageUp PageDown Enter Esc — each passes when no list
 * is open) without the default Ctrl-Space: that is the AI ghost text's
 * (Editor.tsx). Here it only reopens the list inside `[[`; the TypeScript
 * checks bind it inside ts blocks.
 */
const keys = Prec.highest(
  keymap.of([
    {
      key: "Ctrl-Space",
      run: (view) => {
        const { head } = view.state.selection.main;
        const line = view.state.doc.lineAt(head);
        return OPEN_LINK.test(line.text.slice(0, head - line.from)) && startCompletion(view);
      },
    },
    ...completionKeymap.filter((b) => b.run !== startCompletion),
  ]),
);

export function wikiLinkAutocomplete(): Extension {
  return [autocompletion({ defaultKeymap: false }), keys, EditorState.languageData.of(() => [{ autocomplete: wikiLinkSource }]), theme];
}
