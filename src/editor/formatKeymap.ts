/**
 * The format keymap lives apart from ./formatCommands so the command
 * palette (loaded at startup) doesn't pull CodeMirror in with it (C1).
 */
import { keymap } from "@codemirror/view";
import type { Extension } from "@codemirror/state";
import { formatDocumentInView } from "./formatCommands";

/**
 * Editor keymap: Shift-Alt-F formats the document (VS Code's binding).
 * When the cursor is inside a fenced block that has a formatter, the
 * document formatter already covers it via embedded-language formatting.
 */
export function formatKeymap(): Extension {
  return keymap.of([
    {
      key: "Shift-Alt-f",
      preventDefault: true,
      run(view) {
        void formatDocumentInView(view);
        return true;
      },
    },
  ]);
}

