/**
 * Note names after `[[` in the source editor (plan W1.25): type a few
 * letters of a note's name, in any script, and pick it from the list — on
 * a phone that is one tap after the toolbar's [[ button.
 *
 * Offered as language data, so it joins any other completion source
 * instead of replacing it.
 */

import { autocompletion, type CompletionContext, type CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";
import { listWorkspace } from "../storage/workspace";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { noteOptions, wikiQueryAt } from "./wikiLinkQuery";

let cache: { at: number; paths: string[] } | null = null;
let unsubscribe: (() => void) | null = null;

async function vaultPaths(): Promise<string[]> {
  if (cache && Date.now() - cache.at < 30_000) return cache.paths;
  unsubscribe ??= onWorkspaceChanged(() => {
    cache = null;
  });
  try {
    cache = { at: Date.now(), paths: (await listWorkspace()).map((e) => e.path) };
  } catch {
    cache = { at: Date.now(), paths: [] };
  }
  return cache.paths;
}

async function source(ctx: CompletionContext): Promise<CompletionResult | null> {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const q = wikiQueryAt(line.text.slice(0, ctx.pos - line.from));
  if (!q) return null;
  const options = noteOptions(await vaultPaths()).map((o) => ({
    label: o.label,
    detail: o.detail,
    type: "text",
    // Close the link when the user has not typed "]]" yet.
    apply: (view: import("@codemirror/view").EditorView, _c: unknown, from: number, to: number) => {
      const after = view.state.sliceDoc(to, to + 2);
      const insert = after === "]]" ? o.label : `${o.label}]]`;
      view.dispatch({ changes: { from, to, insert }, selection: { anchor: from + o.label.length + 2 } });
    },
  }));
  return { from: line.from + q.offset, options, validFor: /^[^\]|#]*$/ };
}

export function wikiLinkCompletion(): Extension {
  return [autocompletion({ activateOnTyping: true }), EditorState.languageData.of(() => [{ autocomplete: source }])];
}
