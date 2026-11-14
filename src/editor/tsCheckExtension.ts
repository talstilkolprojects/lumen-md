/**
 * TypeScript checks inside code blocks of the source editor — ```ts /
 * ```tsx, and JavaScript (```js, ```live-js: syntax errors always, type
 * errors with `// @ts-check`): wavy underlines with the message, type info
 * on hover and completions while typing. `live-js shared` blocks of one
 * scope are checked together, as they run. Opt-in ("Enable TypeScript checks in code blocks") because
 * the compiler is a multi-MB download, loaded in a worker on first use.
 */
import { EditorState, Prec, StateEffect, StateField } from "@codemirror/state";
import type { Extension, Range } from "@codemirror/state";
import { Decoration, EditorView, ViewPlugin, hoverTooltip, keymap } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import { autocompletion, startCompletion } from "@codemirror/autocomplete";
import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { findTsBlocks, toUnits, unitAt, unitRangeToDoc, type TsUnit } from "../lsp/tsBlocks";
import type { TsClient } from "../lsp/tsClient";
import type { TsDiagnostic } from "../lsp/tsService";

const setTsDiagnostics = StateEffect.define<DecorationSet>();

const tsDiagnosticsField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(value, tr) {
    value = value.map(tr.changes);
    for (const e of tr.effects) if (e.is(setTsDiagnostics)) value = e.value;
    return value;
  },
  provide: (f) => EditorView.decorations.from(f),
});

/** Map diagnostics (unit-relative) to document decorations. */
export function diagnosticDecorations(
  units: readonly TsUnit[],
  diags: readonly TsDiagnostic[],
  docLength: number,
): DecorationSet {
  const byId = new Map(units.map((u) => [u.id, u]));
  const ranges: Range<Decoration>[] = [];
  for (const d of diags) {
    const u = byId.get(d.id);
    if (!u) continue;
    const r = unitRangeToDoc(u, d.start, d.length);
    if (!r) continue;
    const from = Math.min(r.from, docLength);
    const to = Math.min(r.to, docLength);
    if (to <= from) continue;
    ranges.push(
      Decoration.mark({
        class: `cm-ts-${d.severity}`,
        attributes: { title: `TS${d.code}: ${d.message}` },
      }).range(from, to),
    );
  }
  ranges.sort((a, b) => a.from - b.from);
  return Decoration.set(ranges, true);
}

const toInput = (units: readonly TsUnit[]) =>
  units.map(({ id, tsx, js, shared, code }) => ({ id, tsx, js, shared, code }));

const theme = EditorView.baseTheme({
  ".cm-ts-error": { textDecoration: "underline wavy hsl(0 80% 60%)", textDecorationSkipInk: "none" },
  ".cm-ts-warning": { textDecoration: "underline wavy hsl(40 90% 55%)", textDecorationSkipInk: "none" },
  ".cm-ts-info": { textDecoration: "underline dotted hsl(220 14% 60%)" },
  ".cm-ts-hover": { padding: "4px 8px", maxWidth: "60ch", fontSize: "12px", direction: "ltr" },
  ".cm-ts-hover code": { whiteSpace: "pre-wrap", fontFamily: "var(--font-mono, monospace)" },
  ".cm-ts-hover-doc": { marginTop: "4px", opacity: "0.8" },
});

/** The extension; `client` is injectable for tests. */
export function tsCheckExtension(client: TsClient, opts: { debounceMs?: number } = {}): Extension {
  const debounceMs = opts.debounceMs ?? 600;
  const checker = ViewPlugin.fromClass(
    class {
      private timer: ReturnType<typeof setTimeout> | null = null;
      private run = 0;
      constructor(private view: EditorView) {
        this.schedule();
      }
      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule();
      }
      schedule() {
        if (this.timer) clearTimeout(this.timer);
        this.timer = setTimeout(() => void this.check(), debounceMs);
      }
      async check() {
        this.timer = null;
        const run = ++this.run;
        const doc = this.view.state.doc.toString();
        const units = toUnits(findTsBlocks(doc));
        let deco = Decoration.none;
        if (units.length > 0) {
          try {
            const diags = await client.check(toInput(units));
            deco = diagnosticDecorations(units, diags, doc.length);
          } catch {
            return; // worker failed to load — leave the editor untouched
          }
        }
        // Drop stale results (the doc changed while the worker was busy).
        if (run !== this.run || this.view.state.doc.toString() !== doc) return;
        this.view.dispatch({ effects: setTsDiagnostics.of(deco) });
      }
      destroy() {
        if (this.timer) clearTimeout(this.timer);
        this.run++;
      }
    },
  );

  const source = async (ctx: CompletionContext): Promise<CompletionResult | null> => {
    const doc = ctx.state.doc.toString();
    const units = toUnits(findTsBlocks(doc));
    const at = unitAt(units, ctx.pos);
    if (!at) return null;
    const word = ctx.matchBefore(/[\w$]*/);
    const before = at.unit.code.slice(Math.max(0, at.offset - (word?.text.length ?? 0) - 2), at.offset - (word?.text.length ?? 0));
    const afterDot = /\.\s*$/.test(before);
    if (!ctx.explicit && !afterDot && (!word || word.text.length === 0)) return null;
    let items;
    try {
      items = await client.complete(toInput(units), at.unit.id, at.offset);
    } catch {
      return null;
    }
    if (ctx.aborted) return null;
    return {
      from: word ? word.from : ctx.pos,
      options: items.map((i, n) => ({ label: i.label, type: completionType(i.kind), boost: -n / 1000 })),
      validFor: /^[\w$]*$/,
    };
  };

  const hover = hoverTooltip(async (view, pos) => {
    const units = toUnits(findTsBlocks(view.state.doc.toString()));
    const at = unitAt(units, pos);
    if (!at) return null;
    let info;
    try {
      info = await client.hover(toInput(units), at.unit.id, at.offset);
    } catch {
      return null;
    }
    if (!info) return null;
    return {
      pos,
      create: () => {
        const dom = document.createElement("div");
        dom.className = "cm-ts-hover";
        const sig = document.createElement("code");
        sig.textContent = info.text;
        dom.appendChild(sig);
        if (info.doc) {
          const docEl = document.createElement("div");
          docEl.className = "cm-ts-hover-doc";
          docEl.textContent = info.doc;
          dom.appendChild(docEl);
        }
        return { dom };
      },
    };
  });

  // A language-data source, not `autocompletion({ override })`: overrides
  // can't be combined, and the `[[` link completion (4.5) is one too. The
  // source answers only inside ts blocks.
  // Ctrl-Space asks for completions inside a ts block; elsewhere it stays the
  // AI ghost text's (the link completion turns the default binding off).
  const explicit = Prec.highest(
    keymap.of([
      {
        key: "Ctrl-Space",
        run: (view) => !!unitAt(toUnits(findTsBlocks(view.state.doc.toString())), view.state.selection.main.head) && startCompletion(view),
      },
    ]),
  );
  return [tsDiagnosticsField, checker, theme, hover, autocompletion(), explicit, EditorState.languageData.of(() => [{ autocomplete: source }])];
}

function completionType(kind: string): string {
  switch (kind) {
    case "method":
    case "function":
    case "local function":
      return "function";
    case "property":
    case "getter":
    case "setter":
      return "property";
    case "class":
      return "class";
    case "interface":
    case "type":
      return "type";
    case "enum":
      return "enum";
    case "keyword":
      return "keyword";
    case "const":
      return "constant";
    default:
      return "variable";
  }
}

export { tsDiagnosticsField };
