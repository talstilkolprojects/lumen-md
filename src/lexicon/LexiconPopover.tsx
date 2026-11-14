/**
 * Right-click on a Hebrew word (plan W5.26): synonyms, definition and the
 * word's niqqud from the offline lexicon. Opened by src/editor/Editor.tsx
 * (contextmenu, only when the pack is installed; Shift+right-click keeps the
 * browser's menu) and by the palette's "look up the word" command.
 * Choosing a synonym or the pointed form replaces the word in the note —
 * only if the note still has that word there.
 */
import { useEffect, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import type { EditorView } from "@codemirror/view";
import "./strings";
import { t } from "../i18n";
import { useFocusTrap } from "../ui/useFocusTrap";
import { loadLexicon } from "./store";
import { lookup, withPrefix, type LookupResult } from "./lexicon";
import { wordAt } from "./wordAt";

export type LexiconMode = "menu" | "synonyms" | "definition" | "nikud";

function replaceWord(view: EditorView, range: { from: number; to: number; word: string }, insert: string): boolean {
  if (view.state.sliceDoc(range.from, range.to) !== range.word) return false;
  view.dispatch({ changes: { from: range.from, to: range.to, insert }, selection: { anchor: range.from + insert.length } });
  view.focus();
  return true;
}

const btn: CSSProperties = { border: "1px solid hsl(var(--border))", borderRadius: 6, padding: "2px 8px", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 13 };

function Panel({ view, range, initial, x, y, close }: { view: EditorView; range: { from: number; to: number; word: string }; initial: LexiconMode; x: number; y: number; close: () => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape: close });
  const [mode, setMode] = useState<LexiconMode>(initial);
  const [result, setResult] = useState<LookupResult | null | undefined>(undefined);
  const [attribution, setAttribution] = useState("");
  useEffect(() => {
    let live = true;
    loadLexicon()
      .then((index) => {
        if (!live) return;
        setAttribution(index.attribution);
        setResult(lookup(index, range.word));
      })
      .catch(() => live && setResult(null));
    return () => {
      live = false;
    };
  }, [range.word]);
  const pick = (w: string) => {
    replaceWord(view, range, w);
    close();
  };
  const pointed = result?.senses.map((s) => s.pointed).filter((p, i, all) => p && all.indexOf(p) === i) ?? [];
  return (
    <div
      ref={ref}
      role="dialog"
      aria-modal="true"
      aria-label={t("lexicon.title", { word: range.word })}
      data-testid="lexicon-popover"
      dir="rtl"
      lang="he"
      tabIndex={-1}
      style={{ position: "fixed", left: Math.max(8, Math.min(x, window.innerWidth - 328)), top: Math.max(8, Math.min(y, window.innerHeight - 340)), zIndex: 9999, width: 320, maxHeight: 340, overflow: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 10, padding: 12, boxShadow: "0 8px 24px hsl(0 0% 0%/0.2)", fontSize: 13 }}
    >
      <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 8 }}>
        <strong>{range.word}</strong>
        <button type="button" style={btn} onClick={close} aria-label={t("lexicon.close")}>
          ×
        </button>
      </div>
      {mode === "menu" && (
        <div role="menu" style={{ display: "grid", gap: 4 }}>
          {(["synonyms", "definition", "nikud"] as const).map((m, i) => (
            <button key={m} type="button" role="menuitem" autoFocus={i === 0} style={{ ...btn, textAlign: "start" }} onClick={() => setMode(m)}>
              {t(`lexicon.${m}`)}
            </button>
          ))}
        </div>
      )}
      {mode !== "menu" && result === undefined && <p>{t("lexicon.loading")}</p>}
      {mode !== "menu" && result === null && <p data-testid="lexicon-none">{t("lexicon.notFound")}</p>}
      {mode === "synonyms" && result && (
        <section aria-label={t("lexicon.synonyms")}>
          {result.synonyms.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }} data-testid="lexicon-synonyms">
              {result.synonyms.map((s) => (
                <button key={s} type="button" style={btn} onClick={() => pick(withPrefix(result.prefix, s))} title={t("lexicon.replaceWith", { word: withPrefix(result.prefix, s) })}>
                  {withPrefix(result.prefix, s)}
                </button>
              ))}
            </div>
          ) : (
            <p>{t("lexicon.noSynonyms")}</p>
          )}
        </section>
      )}
      {mode === "definition" && result && (
        <section aria-label={t("lexicon.definition")} data-testid="lexicon-definition">
          {result.senses.length ? (
            result.senses.map((s, i) => (
              <div key={i} style={{ marginBottom: 8 }}>
                <div>
                  <strong>{s.pointed || s.word}</strong>
                  {s.pos && <span style={{ color: "hsl(var(--fg-muted))", marginInlineStart: 6 }}>{s.pos}</span>}
                </div>
                <ol style={{ margin: "4px 0 0", paddingInlineStart: 20 }}>
                  {s.defs.map((d, j) => (
                    <li key={j}>{d}</li>
                  ))}
                </ol>
              </div>
            ))
          ) : (
            <p>{t("lexicon.noDefinition")}</p>
          )}
        </section>
      )}
      {mode === "nikud" && result && (
        <section aria-label={t("lexicon.nikud")} data-testid="lexicon-nikud">
          {pointed.length ? (
            <div style={{ display: "flex", flexWrap: "wrap", gap: 4 }}>
              {pointed.map((p) => (
                <button key={p} type="button" style={{ ...btn, fontSize: 16 }} onClick={() => pick(withPrefix(result.prefix, p))} title={t("lexicon.replaceWith", { word: withPrefix(result.prefix, p) })}>
                  {withPrefix(result.prefix, p)}
                </button>
              ))}
            </div>
          ) : (
            <p>{t("lexicon.noNikud")}</p>
          )}
          {result.prefix && <p style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t("lexicon.prefixNote", { prefix: result.prefix })}</p>}
        </section>
      )}
      {mode !== "menu" && attribution && (
        <p style={{ marginTop: 10, marginBottom: 0, fontSize: 10, color: "hsl(var(--fg-muted))" }} dir="auto">
          {attribution}
        </p>
      )}
    </div>
  );
}

let openHost: (() => void) | null = null;

/** Open the lexicon for the word at `pos`. Returns false when there is no Hebrew word there. */
export function openLexicon(view: EditorView, pos: number, at: { x: number; y: number }, initial: LexiconMode = "menu"): boolean {
  const range = wordAt(view, pos);
  if (!range) return false;
  openHost?.();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
    if (openHost === close) openHost = null;
  };
  openHost = close;
  root.render(<Panel view={view} range={range} initial={initial} x={at.x} y={at.y} close={close} />);
  return true;
}
