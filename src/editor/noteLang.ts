/**
 * The note's language tag on the editor (plan W7.9): `lang` on CodeMirror's
 * content element, from the front matter or a Yiddish note's own text
 * (text/noteLanguage.ts, loaded on demand so the startup bundle stays as it
 * is). Yiddish and Hebrew-letter Ladino also get the bundled Hebrew face
 * with full pointing (אַ אָ פֿ), which the default Heebo lacks.
 */
import { EditorView, ViewPlugin, type ViewUpdate } from "@codemirror/view";
import { documentLanguage, ensureLanguageFont } from "../text/noteLanguageLoader";

export function noteLangExtension() {
  return ViewPlugin.fromClass(
    class {
      seq = 0;
      constructor(readonly view: EditorView) {
        this.refresh();
      }
      update(u: ViewUpdate) {
        // Only the beginning of the note decides; re-read it when it changes.
        if (u.docChanged && u.changes.touchesRange(0, 4000)) this.refresh();
      }
      refresh() {
        const id = ++this.seq;
        void documentLanguage(this.view.state.sliceDoc(0, 4000)).then((tag) => {
          if (id !== this.seq) return;
          const el = this.view.contentDOM;
          if (tag) el.setAttribute("lang", tag);
          else el.removeAttribute("lang");
          void ensureLanguageFont(tag).catch(() => undefined);
        });
      }
    },
  );
}
