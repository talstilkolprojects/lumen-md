/**
 * `[[` completion in the source editor (4.5): the CodeMirror completion
 * source. Loaded on the first `[[` by `wikiLinkAutocomplete` — neither it
 * nor the matching code is in the startup bundle.
 */

import { pickedCompletion, type Completion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { syntaxTree } from "@codemirror/language";
import type { EditorView } from "@codemirror/view";
import { parseWikiQuery, wikiEdit, wikiSuggestions, type WikiSuggestion } from "./wikiComplete";
import { canCreateNotes, createLinkedNote, currentNote, displayOf, linkCatalog } from "./wikiLinkData";

/** Code is literal: no link completion inside it. */
const CODE = new Set(["InlineCode", "FencedCode", "CodeBlock", "CodeText", "HTMLBlock", "CommentBlock"]);

function inCode(ctx: CompletionContext): boolean {
  for (let n: { name: string; parent: unknown } | null = syntaxTree(ctx.state).resolveInner(ctx.pos, -1); n; n = n.parent as typeof n) {
    if (CODE.has(n.name)) return true;
  }
  return false;
}

/** Apply a picked suggestion where the caret is now (the typed text may have grown since it was offered). */
function apply(view: EditorView, completion: Completion, s: WikiSuggestion): void {
  const pos = view.state.selection.main.head;
  const line = view.state.doc.lineAt(pos);
  const before = line.text.slice(0, pos - line.from);
  const q = parseWikiQuery(before);
  if (!q) return;
  const e = wikiEdit(q, before, line.text.slice(pos - line.from), s);
  view.dispatch({
    changes: { from: line.from + e.from, to: line.from + e.to, insert: e.insert },
    selection: { anchor: line.from + e.caret },
    annotations: pickedCompletion.of(completion),
    userEvent: "input.complete",
    scrollIntoView: true,
  });
  if (s.kind === "create" && s.createPath) void createLinkedNote(s.createPath);
}

export async function wikiLinkCompletions(ctx: CompletionContext): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const q = parseWikiQuery(line.text.slice(0, ctx.pos - line.from));
  if (!q || inCode(ctx)) return null;
  const catalog = await linkCatalog();
  if (ctx.aborted) return null;
  const items = wikiSuggestions(q, catalog, currentNote(ctx.state.doc.toString()), { create: canCreateNotes() });
  if (!items.length) return null;
  return {
    from: line.from + q.from,
    // Matched and ordered by noteKey already: CodeMirror's own filter
    // would drop niqqud and final-letter matches.
    filter: false,
    options: items.map((s): Completion => {
      const shown = displayOf(s);
      const option: Completion = {
        label: shown.label,
        detail: shown.detail,
        type: `wiki-${s.kind}`,
        apply: (view, completion) => apply(view, completion, s),
      };
      return option;
    }),
  };
}
