/**
 * Direction controls in the source editor (plan W5.4).
 *
 *  - "Show direction marks": every LRM, RLM, ALM, embedding, override and
 *    isolate gets a small tag in front of it. The character itself stays
 *    in place, so the line still lays out exactly as it will everywhere
 *    else — the tag only says why.
 *  - Risky controls (an override, or an embedding / isolate left open at
 *    the end of its line: Trojan Source) are tagged in red even when the
 *    switch is off.
 *  - Pasting or dropping text with a risky control shows a warning with a
 *    one-click "Remove" (one undoable change).
 *
 * The rules live in lib/bidiMarks; this file only draws them.
 */

import { Decoration, EditorView, ViewPlugin, WidgetType, type DecorationSet, type ViewUpdate } from "@codemirror/view";
import { StateEffect, type Range } from "@codemirror/state";
import { BIDI_CONTROLS, bidiRisks, hasBidiRisk, removeRiskyEdits, type BidiControl } from "../lib/bidiMarks";
import { t } from "../i18n";
import { useToastStore } from "../store/useToastStore";
import { bidiMarksShown, onBidiMarksChange } from "./bidiMarksSetting";

const refresh = StateEffect.define<null>();

/** The tag's accessible name: "RLM — right-to-left mark". */
export function bidiTagLabel(control: BidiControl, risky: boolean): string {
  const name = `${control.name} — ${t(`bidi.control.${control.name}`)}`;
  return risky ? `${name} · ${t("bidi.risk")}` : name;
}

export class BidiTagWidget extends WidgetType {
  constructor(
    readonly control: BidiControl,
    readonly risky: boolean,
  ) {
    super();
  }
  eq(other: BidiTagWidget): boolean {
    return other.control === this.control && other.risky === this.risky;
  }
  toDOM(): HTMLElement {
    const el = document.createElement("span");
    el.className = this.risky ? "cm-bidi-tag cm-bidi-tag-risk" : "cm-bidi-tag";
    el.dir = "ltr";
    el.textContent = this.control.name;
    el.title = bidiTagLabel(this.control, this.risky);
    el.setAttribute("aria-label", el.title);
    el.dataset.bidi = this.control.name;
    return el;
  }
  ignoreEvent(): boolean {
    return false;
  }
}

const CONTROL = /[\u061c\u200e\u200f\u202a-\u202e\u2066-\u2069]/;

function build(view: EditorView): DecorationSet {
  const shown = bidiMarksShown();
  const out: Range<Decoration>[] = [];
  const doc = view.state.doc;
  for (const { from, to } of view.visibleRanges) {
    let pos = from;
    while (pos <= to) {
      const line = doc.lineAt(pos);
      if (CONTROL.test(line.text)) {
        const risky = new Set(bidiRisks(line.text).map((r) => r.index));
        for (let i = 0; i < line.text.length; i++) {
          const c = BIDI_CONTROLS.get(line.text.charCodeAt(i));
          if (!c) continue;
          const isRisk = risky.has(i);
          if (!shown && !isRisk) continue;
          out.push(Decoration.widget({ widget: new BidiTagWidget(c, isRisk), side: -1 }).range(line.from + i));
        }
      }
      if (line.to >= to) break;
      pos = line.to + 1;
    }
  }
  return Decoration.set(out, true);
}

/** Remove every risky control in the editor, as one undoable change. */
export function removeRiskyControls(view: EditorView): number {
  const edits = removeRiskyEdits(view.state.doc.toString());
  if (edits.length) view.dispatch({ changes: edits, userEvent: "delete.bidi" });
  return edits.length;
}

/** The warning shown after a paste or drop that brought risky controls in. */
export function warnRiskyPaste(count: number, remove: () => void): void {
  useToastStore.getState().push({
    kind: "warning",
    title: t("bidi.paste.title"),
    body: t("bidi.paste.body", { count }),
    ttlMs: 0,
    action: { label: t("bidi.paste.remove"), run: remove },
  });
}

const pasteWatch = EditorView.updateListener.of((u) => {
  for (const tr of u.transactions) {
    if (!tr.isUserEvent("input.paste") && !tr.isUserEvent("input.drop")) continue;
    let inserted = "";
    tr.changes.iterChanges((_fa, _ta, _fb, _tb, text) => {
      inserted += text.toString() + "\n";
    });
    if (!hasBidiRisk(inserted)) continue;
    const view = u.view;
    warnRiskyPaste(bidiRisks(inserted).length, () => {
      removeRiskyControls(view);
      view.focus();
    });
  }
});

const theme = EditorView.baseTheme({
  ".cm-bidi-tag": {
    display: "inline-block",
    direction: "ltr",
    unicodeBidi: "isolate",
    font: "600 0.62em/1.2 ui-monospace, SFMono-Regular, Menlo, monospace",
    padding: "0 0.25em",
    margin: "0 0.08em",
    borderRadius: "0.25em",
    verticalAlign: "0.18em",
    userSelect: "none",
    cursor: "default",
  },
  "&light .cm-bidi-tag": { background: "#e0e7ff", color: "#3730a3" },
  "&dark .cm-bidi-tag": { background: "#312e81", color: "#e0e7ff" },
  "&light .cm-bidi-tag-risk": { background: "#fee2e2", color: "#991b1b", outline: "1px solid #dc2626" },
  "&dark .cm-bidi-tag-risk": { background: "#7f1d1d", color: "#fee2e2", outline: "1px solid #f87171" },
});

export function bidiMarksExtension() {
  return [
    theme,
    pasteWatch,
    ViewPlugin.fromClass(
      class {
        decorations: DecorationSet;
        off: () => void;
        constructor(view: EditorView) {
          this.decorations = build(view);
          this.off = onBidiMarksChange(() => view.dispatch({ effects: refresh.of(null) }));
        }
        update(u: ViewUpdate) {
          if (u.docChanged || u.viewportChanged || u.transactions.some((tr) => tr.effects.some((e) => e.is(refresh)))) this.decorations = build(u.view);
        }
        destroy() {
          this.off();
        }
      },
      { decorations: (v) => v.decorations },
    ),
  ];
}
