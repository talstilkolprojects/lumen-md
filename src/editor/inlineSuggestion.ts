/**
 * Inline AI suggestion — ghost text that appears after the cursor
 * when the user pauses typing. Accept with Tab, dismiss with Escape.
 *
 * Implementation: CodeMirror 6 Decoration.widget that renders grey
 * text at the cursor position. The suggestion text is fetched from
 * the local LLM (or cloud fallback) with a short context window.
 */

import { EditorView, Decoration, WidgetType, ViewPlugin, ViewUpdate, keymap } from "@codemirror/view";
import { StateField, StateEffect, type Extension } from "@codemirror/state";
import { log } from "../lib/logger";
import { aiAuthored } from "./aiAuthorship";
import { announce } from "../a11y/announce";
import { t } from "../i18n";

const setSuggestion = StateEffect.define<string | null>();

/**
 * Plan 6.9: local fill-in-the-middle autocomplete, on when the user turned
 * it on ("AI: Local Autocomplete"). Read here without importing the lazy
 * module, so the startup bundle carries only this check.
 */
function fimOn(): boolean {
  try {
    return localStorage.getItem("lumen.fim.enabled") === "1";
  } catch {
    return false;
  }
}

/** Quiet time after a keystroke before asking the local model. */
const FIM_DEBOUNCE_MS = 150;

const suggestionField = StateField.define<string | null>({
  create() {
    return null;
  },
  update(value, tr) {
    for (const e of tr.effects) {
      if (e.is(setSuggestion)) return e.value;
    }
    if (tr.selection) return null; // dismiss on cursor move
    return value;
  },
});

class SuggestionWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }

  eq(other: SuggestionWidget): boolean {
    return other.text === this.text;
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.style.opacity = "0.45";
    span.style.pointerEvents = "none";
    span.style.userSelect = "none";
    // A FIM completion can be two lines (plan 6.9).
    span.style.whiteSpace = "pre-wrap";
    span.className = "cm-ai-suggestion";
    return span;
  }

  ignoreEvent(): boolean {
    return true;
  }
}

const suggestionPlugin = ViewPlugin.fromClass(
  class {
    private timeout: ReturnType<typeof setTimeout> | null = null;
    private abort: AbortController | null = null;
    /** The FIM request scheduler (debounce + cancel per keystroke), made on first use. */
    private fim: { request(): Promise<{ text: string } | null>; cancel(): void } | null = null;
    private fimLoading = false;

    constructor(readonly view: EditorView) {
      // no-op
    }

    update(update: ViewUpdate) {
      if (!update.docChanged && !update.selectionSet) return;

      // Cancel any pending request
      if (this.timeout) {
        clearTimeout(this.timeout);
        this.timeout = null;
      }
      if (this.abort) {
        this.abort.abort();
        this.abort = null;
      }
      // Every keystroke and cursor move cancels the FIM request in flight.
      this.fim?.cancel();
      if (update.docChanged && fimOn()) {
        void this.requestFim();
        return;
      }

      // A selection change dismisses the suggestion in the state field
      // itself (`tr.selection` → null). Dispatching from here, inside a
      // view update, threw "Calls to EditorView.update are not allowed
      // while an update is in progress" on every cursor move. Behaviour is
      // otherwise unchanged: typing also sets the selection, so ghost-text
      // fetches stay off here, as before (turning them on is a product
      // decision — an LLM call per pause — tracked in MASTER_PLAN §11).
      if (update.selectionSet) return;

      // Schedule new suggestion after 600 ms of idle typing
      this.timeout = setTimeout(() => this.fetchSuggestion(), 600);
    }

    /** Plan 6.9: ask the local FIM model for the text between the cursor's two sides. */
    private async requestFim() {
      if (!this.fim) {
        if (this.fimLoading) return;
        this.fimLoading = true;
        try {
          const [{ FimScheduler }, { completeFim }] = await Promise.all([import("../ai/fimCore"), import("../ai/fim")]);
          this.fim = new FimScheduler((signal) => {
            const { state } = this.view;
            const sel = state.selection.main;
            if (!sel.empty) return Promise.resolve(null);
            const prefix = state.doc.sliceString(Math.max(0, sel.head - 1500), sel.head);
            const suffix = state.doc.sliceString(sel.head, Math.min(state.doc.length, sel.head + 500));
            return completeFim(prefix, suffix, { signal });
          }, FIM_DEBOUNCE_MS);
        } catch (err) {
          log.debug("fim", err);
          return;
        } finally {
          this.fimLoading = false;
        }
      }
      const fim = this.fim;
      if (!fim) return;
      const head = this.view.state.selection.main.head;
      const doc = this.view.state.doc;
      const r = await fim.request();
      // Only if nothing moved while the model answered.
      if (!r || !r.text || this.view.state.doc !== doc || this.view.state.selection.main.head !== head) return;
      this.view.dispatch({ effects: setSuggestion.of(r.text) });
    }

    private async fetchSuggestion() {
      const pos = this.view.state.selection.main.head;
      const line = this.view.state.doc.lineAt(pos);
      const context = line.text.slice(0, pos - line.from);

      // Don't suggest on empty lines or very short context
      if (context.trim().length < 3) return;

      // Automatic suggestions are real LLM calls too: they count when sent
      // (ownPrompt), and once the monthly quota is spent they just stop
      // (no toast per keystroke).

      const ctrl = (this.abort = new AbortController());
      const signal = ctrl.signal;
      // T55: registered, so Esc / "AI: Cancel" stop it too.
      const { aiOperation } = await import("../ai/aiAbort");
      const op = aiOperation();
      op.signal.addEventListener("abort", () => ctrl.abort(op.signal.reason), { once: true });

      try {
        // Plan 5.5: the `completer` agent, through the runtime (local first, traced).
        const [{ runAgentOrThrow }, { completerAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
        const suggestion = await runAgentOrThrow(completerAgent, { text: context, extra: { mode: "inline" } }, { signal, ownPrompt: "silent" });

        if (signal.aborted) return;
        const trimmed = suggestion.trim();
        if (!trimmed || trimmed === context.trim()) return;

        this.view.dispatch({ effects: setSuggestion.of(trimmed) });
        announce(t("sr.suggestion", { text: trimmed }));
      } catch (err) {
        log.debug("inline-suggestion", err);
      } finally {
        op.end();
      }
    }

    destroy() {
      if (this.timeout) clearTimeout(this.timeout);
      if (this.abort) this.abort.abort();
      this.fim?.cancel();
    }
  },
);

/**
 * Keymap: Tab accepts the suggestion, Escape rejects it.
 */
const acceptKeymap = {
  key: "Tab",
  run(view: EditorView) {
    const suggestion = view.state.field(suggestionField, false);
    if (!suggestion) return false;
    const pos = view.state.selection.main.head;
    view.dispatch({
      changes: { from: pos, to: pos, insert: suggestion },
      effects: setSuggestion.of(null),
      selection: { anchor: pos + suggestion.length },
      annotations: aiAuthored.of(true),
    });
    return true;
  },
};

const rejectKeymap = {
  key: "Escape",
  run(view: EditorView) {
    const suggestion = view.state.field(suggestionField, false);
    if (!suggestion) return false;
    view.dispatch({ effects: setSuggestion.of(null) });
    return true;
  },
};

/**
 * CodeMirror extension that enables inline AI ghost text.
 */
export function inlineSuggestion(): Extension[] {
  return [
    suggestionField,
    suggestionPlugin,
    EditorView.decorations.compute([suggestionField], (state) => {
      const text = state.field(suggestionField);
      if (!text) return Decoration.none;
      const pos = state.selection.main.head;
      const widget = new SuggestionWidget(text);
      return Decoration.set([Decoration.widget({ widget, side: 1 }).range(pos)]);
    }),
    keymap.of([acceptKeymap, rejectKeymap]),
  ];
}
