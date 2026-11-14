/**
 * Niqqud alternatives in the editor (plan W2.5), as in Dicta's Nakdan:
 * after "Hebrew: add niqqud", every pointed word remembers its other
 * readings. Words the model found ambiguous get a dotted underline; a click
 * on one (or Alt+click on any pointed word) opens the list, and picking a
 * reading replaces the word. Escape closes the list.
 *
 * Loaded with the niqqud command's lazy chunk and added to the editor with
 * StateEffect.appendConfig on first use: nothing of it is in the startup
 * bundle. Its strings travel with the niqqud chunk (registered by
 * ../ai/nikudStrings, which the service loads first).
 */
import { StateEffect, StateField, type Extension, type Range } from "@codemirror/state";
import { Decoration, EditorView, showTooltip, type DecorationSet, type Tooltip } from "@codemirror/view";
import { isAmbiguous, type Alternative, type WordAlternatives } from "../text/nikudAlt";
import { sameSkeleton } from "../text/nikud";

type T = (key: string, vars?: Record<string, string | number>) => string;

interface Open {
  from: number;
  to: number;
  alternatives: Alternative[];
}

const setWords = StateEffect.define<{ words: WordAlternatives[]; offset: number }>();
const openList = StateEffect.define<Open | null>();

function mark(alternatives: Alternative[]) {
  return Decoration.mark({ class: isAmbiguous(alternatives) ? "cm-nikud-alt cm-nikud-ambiguous" : "cm-nikud-alt", alternatives });
}

const wordsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    let v = value.map(tr.changes);
    for (const e of tr.effects) {
      if (!e.is(setWords)) continue;
      const { words, offset } = e.value;
      const from = offset;
      const to = offset + (words.at(-1)?.to ?? 0);
      // The new words replace whatever was remembered inside the pointed span.
      v = v.update({ filter: (a, b) => b <= from || a >= to });
      const ranges: Range<Decoration>[] = words.filter((w) => w.alternatives.length > 1 && w.to > w.from).map((w) => mark(w.alternatives).range(offset + w.from, offset + w.to));
      v = v.update({ add: ranges, sort: true });
    }
    return v;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** The alternatives remembered for the word at `pos`, if any. */
function wordAt(view: EditorView, pos: number): Open | null {
  let hit: Open | null = null;
  view.state.field(wordsField).between(pos, pos, (from, to, d) => {
    const alternatives = (d.spec as { alternatives?: Alternative[] }).alternatives;
    if (alternatives && pos >= from && pos <= to) hit = { from, to, alternatives };
  });
  return hit;
}

function listField(t: T) {
  return StateField.define<Tooltip | null>({
    create: () => null,
    update(value, tr) {
      for (const e of tr.effects) if (e.is(openList)) return e.value ? tooltipFor(e.value, t) : null;
      if (tr.docChanged || tr.selection) return null;
      return value;
    },
    provide: (f) => showTooltip.from(f),
  });
}

function tooltipFor(open: Open, t: T): Tooltip {
  return {
    pos: open.from,
    end: open.to,
    above: true,
    create(view) {
      const dom = document.createElement("div");
      dom.className = "cm-nikud-alternatives";
      dom.setAttribute("role", "listbox");
      dom.setAttribute("aria-label", t("nikud.alt.title"));
      dom.dir = "rtl";
      const current = view.state.sliceDoc(open.from, open.to);
      const total = open.alternatives.reduce((s, a) => s + a.p, 0) || 1;
      for (const alt of open.alternatives) {
        const b = document.createElement("button");
        b.type = "button";
        b.setAttribute("role", "option");
        b.setAttribute("aria-selected", String(alt.text === current));
        b.setAttribute("aria-label", t("nikud.alt.choose", { word: alt.text }));
        b.className = "cm-nikud-alt-option";
        const word = document.createElement("span");
        word.textContent = alt.text;
        const pct = document.createElement("small");
        pct.textContent = ` ${Math.round((100 * alt.p) / total)}%`;
        b.append(word, pct);
        b.addEventListener("mousedown", (e) => e.preventDefault());
        b.addEventListener("click", () => choose(view, open, alt));
        dom.appendChild(b);
      }
      return { dom };
    },
  };
}

/** Replace the word with `alt` (only if the word still has the same consonants) and keep its readings. */
function choose(view: EditorView, open: Open, alt: Alternative): void {
  const now = view.state.sliceDoc(open.from, open.to);
  if (!sameSkeleton(now, alt.text)) {
    view.dispatch({ effects: openList.of(null) });
    return;
  }
  const others = [alt, ...open.alternatives.filter((a) => a !== alt)];
  view.dispatch({
    changes: { from: open.from, to: open.to, insert: alt.text },
    effects: [openList.of(null), setWords.of({ offset: open.from, words: [{ from: 0, to: alt.text.length, alternatives: others }] })],
  });
}

const theme = EditorView.baseTheme({
  ".cm-nikud-ambiguous": { textDecoration: "underline dotted", textUnderlineOffset: "0.25em", cursor: "pointer" },
  ".cm-nikud-alternatives": { display: "flex", flexDirection: "column", padding: "4px", gap: "2px", fontSize: "1.1em" },
  ".cm-nikud-alt-option": { all: "unset", padding: "2px 8px", borderRadius: "4px", cursor: "pointer" },
  ".cm-nikud-alt-option:hover, .cm-nikud-alt-option:focus-visible": { background: "rgba(127,127,127,.2)" },
  ".cm-nikud-alt-option[aria-selected=true]": { fontWeight: "600" },
});

function extension(t: T): Extension {
  const list = listField(t);
  return [
    wordsField,
    list,
    theme,
    EditorView.domEventHandlers({
      click(e, view) {
        const pos = view.posAtCoords({ x: e.clientX, y: e.clientY });
        if (pos == null) return false;
        const open = wordAt(view, pos);
        if (!open) return false;
        // A plain click opens the list on an underlined (ambiguous) word; Alt+click on any pointed word.
        if (!e.altKey && !isAmbiguous(open.alternatives)) return false;
        view.dispatch({ effects: openList.of(open) });
        return false;
      },
      keydown(e, view) {
        if (e.key !== "Escape" || !view.state.field(list, false)) return false;
        view.dispatch({ effects: openList.of(null) });
        return false;
      },
    }),
  ];
}

const installed = new WeakSet<EditorView>();

/**
 * Remember the readings of the words just pointed: `words` are relative to
 * `offset` (where the pointed text starts in the document). Installs the
 * extension on this editor the first time.
 */
export function rememberNikudAlternatives(view: EditorView, offset: number, words: WordAlternatives[], t: T): void {
  if (!words.length) return;
  if (!installed.has(view)) {
    installed.add(view);
    view.dispatch({ effects: StateEffect.appendConfig.of(extension(t)) });
  }
  view.dispatch({ effects: setWords.of({ words, offset }) });
}

/** Tests: open the list for the word at `pos` as a click would; returns whether there was one. */
export function openNikudAlternativesAt(view: EditorView, pos: number): boolean {
  const open = wordAt(view, pos);
  if (open) view.dispatch({ effects: openList.of(open) });
  return !!open;
}
