/**
 * Ghost text (Copilot-style inline completion) for the source editor:
 * Ctrl+Space asks the `completer` agent, Tab accepts, Escape dismisses.
 * Moved out of Editor.tsx, which must not grow past its max-lines baseline
 * (W6.25); only the callbacks' parameter types are now written out.
 */
import { Decoration, EditorView, keymap, WidgetType, type DecorationSet } from "@codemirror/view";
import { StateEffect, StateField, type Extension, type Transaction } from "@codemirror/state";
import { aiOperation } from "../ai/aiAbort";
import { announce } from "../a11y/announce";
import { t as i18nT } from "../i18n";
import { aiAuthored } from "./aiAuthorship";

class GhostWidget extends WidgetType {
  constructor(readonly text: string) { super(); }
  toDOM() {
    const span = document.createElement("span");
    span.textContent = this.text;
    span.style.opacity = "0.4";
    span.style.fontStyle = "italic";
    span.style.pointerEvents = "none";
    span.className = "cm-ghost-text";
    return span;
  }
  eq(other: GhostWidget) { return this.text === other.text; }
}

const setGhostText = StateEffect.define<{ pos: number; text: string } | null>();

interface GhostState {
  pos: number;
  text: string;
  decorations: DecorationSet;
}

const ghostField = StateField.define<GhostState | null>({
  create() { return null; },
  update(value: GhostState | null, tr: Transaction) {
    for (const e of tr.effects) {
      if (e.is(setGhostText)) {
        if (!e.value) return null;
        const deco = Decoration.set([
          Decoration.widget({
            widget: new GhostWidget(e.value.text),
            side: 1,
          }).range(e.value.pos),
        ]);
        return { pos: e.value.pos, text: e.value.text, decorations: deco };
      }
    }
    // Clear ghost on any doc change or selection move
    if (value && (tr.docChanged || tr.selection)) return null;
    return value;
  },
  provide(f: StateField<GhostState | null>) {
    return EditorView.decorations.from(f, (v: GhostState | null) => v?.decorations ?? Decoration.none);
  },
});

export function ghostTextExtension(): Extension {
  let controller: AbortController | null = null;
  let debounceTimer: ReturnType<typeof setTimeout> | null = null;

  return [
    ghostField,
    keymap.of([
      {
        // Ctrl+Space → fetch AI ghost text
        key: "Ctrl-Space",
        run(view: EditorView) {
          controller?.abort();
          if (debounceTimer) clearTimeout(debounceTimer);

          const pos = view.state.selection.main.head;
          const textBefore = view.state.doc.sliceString(
            Math.max(0, pos - 500), pos,
          );
          if (!textBefore.trim()) return false;

          debounceTimer = setTimeout(async () => {
            // Explicit Ctrl-Space request: counts against the AI quota when
            // it is actually sent (ownPrompt), not before chat()'s checks.
            // T55: registered, so Esc / "AI: Cancel" stop it too.
            const op = aiOperation();
            try {
              const c = (controller = new AbortController());
              op.signal.addEventListener("abort", () => c.abort(op.signal.reason), { once: true });
              // Plan 5.5: the `completer` agent, through the runtime (local first, traced).
              const [{ runAgentOrThrow }, { completerAgent }] = await Promise.all([import("../agents/runtime"), import("../agents/defs")]);
              const text = await runAgentOrThrow(completerAgent, { text: textBefore, extra: { mode: "ghost" } }, { signal: controller.signal, ownPrompt: true });
              if (text && view.state.selection.main.head === pos) {
                view.dispatch({ effects: setGhostText.of({ pos, text }) });
                announce(i18nT("sr.suggestion", { text: text.trim() }));
              }
            } catch {
              // why: Silently ignore abort / API errors for completions
            } finally {
              op.end();
            }
          }, 150);
          return true;
        },
      },
      {
        // Tab → accept ghost text
        key: "Tab",
        run(view: EditorView) {
          const ghost = view.state.field(ghostField);
          if (!ghost) return false;
          view.dispatch({
            changes: { from: ghost.pos, insert: ghost.text },
            selection: { anchor: ghost.pos + ghost.text.length },
            effects: setGhostText.of(null),
            annotations: aiAuthored.of(true),
          });
          return true;
        },
      },
      {
        // Escape → dismiss ghost text
        key: "Escape",
        run(view: EditorView) {
          const ghost = view.state.field(ghostField);
          if (!ghost) return false;
          view.dispatch({ effects: setGhostText.of(null) });
          return true;
        },
      },
    ]),
  ];
}
