/**
 * Editor announcements for screen readers (plan W1.23). When the cursor
 * moves to another line, the structure of that line is spoken through the
 * shared live region (../a11y/announce): "Heading 2: Plan", "Task, done",
 * "Code block" — what a screen reader reading the raw text would miss
 * (it says "number sign number sign Plan"). With "every line" on, the line
 * number too. Debounced, so holding an arrow key speaks only where it stops.
 */

import { ViewPlugin, type EditorView, type ViewUpdate } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { announce, describeLine, headingAbove, verbosity } from "../a11y/announce";
import { t } from "../i18n";

const DEBOUNCE_MS = 350;

export function screenReaderAnnouncements(): Extension {
  return ViewPlugin.fromClass(
    class {
      private line: number;
      private timer: ReturnType<typeof setTimeout> | null = null;
      constructor(readonly view: EditorView) {
        this.line = view.state.doc.lineAt(view.state.selection.main.head).number;
      }
      update(u: ViewUpdate) {
        if (!u.selectionSet || !u.view.hasFocus) return;
        const line = u.state.doc.lineAt(u.state.selection.main.head);
        if (line.number === this.line) return;
        this.line = line.number;
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => {
          this.timer = null;
          const info = describeLine(line.text, line.number, verbosity());
          if (info) announce(t(info.key, info.vars));
        }, DEBOUNCE_MS);
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
      }
    },
  );
}

/** "Line 12 of 40, column 3, under heading “Plan”" — for the "where am I" command. */
export function describePosition(view: EditorView): string {
  const head = view.state.selection.main.head;
  const line = view.state.doc.lineAt(head);
  const vars = { line: line.number, lines: view.state.doc.lines, col: head - line.from + 1 };
  const heading = headingAbove(view.state.doc.toString().split("\n"), line.number);
  return heading ? t("sr.position.section", { ...vars, heading }) : t("sr.position", vars);
}
