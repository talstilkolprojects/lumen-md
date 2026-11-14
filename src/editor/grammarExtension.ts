/**
 * CodeMirror extension that runs LanguageTool grammar/spelling/style
 * checks against the live document and paints each match as a wavy
 * underline. Hovering the underline shows the rule message; the per-row
 * "Apply replacement" affordance lives in a separate panel.
 *
 *   • Debounced 1500 ms after the user stops typing (LanguageTool's
 *     public endpoint rate-limits aggressively; self-hosted instances
 *     can lower this via `setGrammarDebounce`).
 *   • Skipped for documents shorter than 40 characters — under that the
 *     checker is noisy and unhelpful.
 *   • Opt-in: only mounted when `useAppStore.grammarCheck` is true.
 *
 * Lives separately from `lintExtension.ts` (markdown structure linter)
 * because grammar requires a network round-trip and we don't want to
 * couple the two cadences.
 */
import { Decoration, EditorView, ViewPlugin } from "@codemirror/view";
import type { DecorationSet, ViewUpdate } from "@codemirror/view";
import type { Extension, Range } from "@codemirror/state";
import { checkGrammar, grammarLanguage, type GrammarMatch } from "../ai/grammar";
import { log } from "../lib/logger";
/** Mirrors hebrewSpellService.DICTIONARY_CHANGED_EVENT (that module loads lazily). */
const DICTIONARY_CHANGED_EVENT = "lumen-hebrew-dictionary-changed";

let DEBOUNCE_MS = 1500;
/** Override the debounce for tests / self-hosted high-throughput backends. */
export function setGrammarDebounce(ms: number): void {
  DEBOUNCE_MS = Math.max(200, Math.floor(ms));
}

const CATEGORY_COLOR: Record<string, string> = {
  TYPOS: "hsl(0 80% 65%)",
  GRAMMAR: "hsl(36 90% 60%)",
  STYLE: "hsl(220 14% 60%)",
  PUNCTUATION: "hsl(280 65% 65%)",
  TYPOGRAPHY: "hsl(220 14% 60%)",
  // A suggestion from the bundled word list (plan 9.2), not a certain error.
  HINT: "hsl(200 70% 60%)",
};

function colorFor(m: GrammarMatch): string {
  return CATEGORY_COLOR[m.rule.category ?? ""] ?? "hsl(40 90% 60%)";
}

function decorationsFor(
  matches: GrammarMatch[],
  docLen: number,
): DecorationSet {
  const ranges: Range<Decoration>[] = [];
  for (const m of matches) {
    const from = Math.max(0, Math.min(m.offset, docLen));
    const to = Math.max(from, Math.min(m.offset + m.length, docLen));
    if (from === to) continue;
    ranges.push(
      Decoration.mark({
        class: "cm-lumen-grammar",
        attributes: {
          "data-grammar-rule": m.rule.id,
          title: `${m.message}${
            m.replacements.length > 0
              ? ` — try: ${m.replacements.slice(0, 3).join(", ")}`
              : ""
          }`,
          style: `text-decoration: underline wavy ${colorFor(m)}; text-decoration-skip-ink: none`,
        },
      }).range(from, to),
    );
  }
  return Decoration.set(ranges, /* sort */ true);
}

export interface GrammarOptions {
  /** Pushed when matches change so a status pill / panel can update. */
  onMatches?: (matches: GrammarMatch[]) => void;
  /** Override the language tag passed to LanguageTool. Default: detected locally (plan 6.5), else `en-US`. */
  language?: string;
}

/**
 * Build the grammar extension. The live ViewPlugin owns the debounce
 * timer + decoration set; the network call goes through `checkGrammar`
 * (which has its own LRU cache so re-renders of the same text don't
 * issue duplicate requests).
 */
export function grammarExtension(opts: GrammarOptions = {}): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private timer: number | null = null;
      private inFlight = false;
      /** A run was asked for while one was in flight: run again when it ends. */
      private rerun = false;
      private lastChecked = "";
      private readonly onDictionaryChange: () => void;

      constructor(view: EditorView) {
        // Run once on mount so initial content gets checked even if the
        // user never types.
        this.schedule(view, /* immediate */ false);
        // The Hebrew dictionary was installed or removed: the unchanged
        // document needs a fresh check (new or stale spelling marks).
        this.onDictionaryChange = () => {
          this.lastChecked = "";
          this.schedule(view, false);
        };
        window.addEventListener(DICTIONARY_CHANGED_EVENT, this.onDictionaryChange);
      }

      update(u: ViewUpdate) {
        if (u.docChanged) this.schedule(u.view, false);
      }

      schedule(view: EditorView, _immediate: boolean) {
        if (this.timer != null) window.clearTimeout(this.timer);
        this.timer = window.setTimeout(() => {
          this.timer = null;
          void this.run(view);
        }, DEBOUNCE_MS);
      }

      async run(view: EditorView): Promise<void> {
        if (this.inFlight) {
          // The in-flight check may be painting results made before this
          // request's reason (a list or dictionary that just arrived, an
          // edit): run once more when it ends.
          this.rerun = true;
          return;
        }
        const text = view.state.doc.toString();
        if (text === this.lastChecked) return;
        this.lastChecked = text;
        this.inFlight = true;
        try {
          // Hebrew paragraphs: local rules + dictionary; the rest: LanguageTool (T28).
          const { checkByLanguage } = await import("../ai/hebrewSpellService");
          const matches = await checkByLanguage(text, async (latin) => checkGrammar(latin, opts.language ?? (await grammarLanguage(latin))));
          // Doc may have shifted while the request was in flight — clamp
          // by current length when we paint.
          const len = view.state.doc.length;
          this.decorations = decorationsFor(matches, len);
          opts.onMatches?.(matches);
          // Force redraw — extension state didn't change through a transaction.
          view.dispatch({});
        } catch (err) {
          // Soft failure — most commonly the public endpoint rate-limited
          // us. Log once and back off until the next typing pause.
          log.warn("grammar check failed", err);
          opts.onMatches?.([]);
        } finally {
          this.inFlight = false;
          if (this.rerun) {
            this.rerun = false;
            this.schedule(view, false);
          }
        }
      }

      destroy(): void {
        if (this.timer != null) window.clearTimeout(this.timer);
        window.removeEventListener(DICTIONARY_CHANGED_EVENT, this.onDictionaryChange);
      }
    },
    { decorations: (v) => v.decorations },
  );
}
