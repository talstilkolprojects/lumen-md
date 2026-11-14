/**
 * Reading options (plan W3.5): face, size, line height and column width of
 * the preview — for this note or for every note — plus a dyslexia-friendly
 * face for Latin text and spaced Hebrew. A face is downloaded (from this
 * app, not a font service) only when it is chosen.
 */
import { useEffect, useState } from "react";
import { BookOpen, X } from "lucide-react";
import "../reading/strings";
import { t } from "../i18n";
import { DYSLEXIA_FONT, HEBREW_FONTS, downloadBytes, type ReadingFontId } from "../reading/fonts";
import { DEFAULT_READING, READING_LIMITS, applyReading, effectiveReading, globalReading, noteReading, saveGlobalReading, saveNoteReading, type ReadingSettings as Settings } from "../reading/settings";
import { HelpButton } from "./HelpButton";

interface Props {
  open: boolean;
  onClose: () => void;
  /** The open note's workspace path (per-note settings need one). */
  notePath: string | null;
}

/** Genesis 1:1 with nikud and cantillation: the hardest line for a Hebrew face. */
const SAMPLE = "בְּרֵאשִׁ֖ית בָּרָ֣א אֱלֹהִ֑ים אֵ֥ת הַשָּׁמַ֖יִם וְאֵ֥ת הָאָֽרֶץ׃";
const LATIN_SAMPLE = "The quick brown fox jumps over the lazy dog.";

const box: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 6, fontSize: 13 };
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const btn: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };

const kb = (n: number) => Math.max(1, Math.round(n / 1024));

export function ReadingSettings({ open, onClose, notePath }: Props) {
  const [scope, setScope] = useState<"note" | "all">(() => (notePath && noteReading(notePath) ? "note" : "all"));
  const [s, setS] = useState<Settings>(() => effectiveReading(notePath));
  const [loading, setLoading] = useState(false);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  const commit = (next: Settings, where = scope) => {
    setS(next);
    if (where === "note" && notePath) saveNoteReading(notePath, next);
    else saveGlobalReading(next);
    setLoading(true);
    setFailed(false);
    void applyReading(next).then((ok) => {
      setLoading(false);
      setFailed(!ok);
    });
  };

  const changeScope = (next: "note" | "all") => {
    setScope(next);
    if (next === "all" && notePath) {
      // Back to the global settings: this note's own ones are dropped.
      saveNoteReading(notePath, null);
      const g = globalReading();
      setS(g);
      void applyReading(g);
    } else commit(s, next);
  };

  const set = <K extends keyof Settings>(k: K, v: Settings[K]) => commit({ ...s, [k]: v });
  const hebrew = HEBREW_FONTS.find((f) => f.id === s.font);
  const sampleFont = hebrew ? `"${hebrew.family}", var(--font-serif)` : "var(--font-serif)";
  const slider = (k: "size" | "lineHeight" | "width", label: string, unit: string) => (
    <label style={row}>
      <span style={{ minWidth: 110 }}>{label}</span>
      <input
        type="range"
        min={READING_LIMITS[k].min}
        max={READING_LIMITS[k].max}
        step={READING_LIMITS[k].step}
        value={s[k]}
        data-testid={`reading-${k}`}
        onChange={(e) => set(k, Number(e.currentTarget.value))}
      />
      <span style={muted}>
        {k === "lineHeight" ? s[k].toFixed(2) : s[k]}
        {unit}
      </span>
    </label>
  );

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("reading.title")} data-testid="reading-settings">
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, padding: 0, display: "flex", flexDirection: "column", maxHeight: "85vh" }}>
        <header style={{ padding: "12px 16px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <BookOpen size={16} />
          <h2 style={{ margin: 0, fontSize: 15, fontWeight: 600, flex: 1 }}>{t("reading.title")}</h2>
          <HelpButton topic="editor/reading" />
          <button type="button" style={btn} onClick={onClose} aria-label={t("reading.close")}>
            <X size={14} />
          </button>
        </header>
        <div style={{ overflowY: "auto", padding: 16, display: "flex", flexDirection: "column", gap: 14 }}>
          <fieldset style={{ ...box, border: 0, padding: 0, margin: 0 }}>
            <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t("reading.scope")}</legend>
            <label style={row}>
              <input type="radio" name="reading-scope" checked={scope === "all"} onChange={() => changeScope("all")} data-testid="reading-scope-all" />
              {t("reading.scope.all")}
            </label>
            <label style={{ ...row, opacity: notePath ? 1 : 0.5 }}>
              <input type="radio" name="reading-scope" disabled={!notePath} checked={scope === "note"} onChange={() => changeScope("note")} data-testid="reading-scope-note" />
              {t("reading.scope.note")}
            </label>
          </fieldset>

          <label style={box}>
            <span style={{ fontWeight: 600 }}>{t("reading.font")}</span>
            <select value={s.font} onChange={(e) => set("font", e.currentTarget.value as ReadingFontId)} data-testid="reading-font">
              <option value="default">{t("reading.font.default")}</option>
              {HEBREW_FONTS.map((f) => (
                <option key={f.id} value={f.id}>
                  {f.name}
                  {downloadBytes(f) ? ` · ${t("reading.font.download", { kb: kb(downloadBytes(f)) })}` : ""}
                </option>
              ))}
            </select>
            <span style={muted}>{t("reading.font.local")}</span>
          </label>

          <div
            data-testid="reading-sample"
            dir="rtl"
            lang="he"
            style={{ fontFamily: sampleFont, fontSize: s.size + 4, lineHeight: s.spacedHebrew ? Math.max(s.lineHeight, 1.9) : s.lineHeight, wordSpacing: s.spacedHebrew ? "0.18em" : undefined, letterSpacing: s.spacedHebrew ? "0.02em" : undefined, padding: "8px 12px", borderRadius: 8, background: "hsl(var(--bg-subtle))" }}
          >
            {SAMPLE}
          </div>

          {slider("size", t("reading.size"), " px")}
          {slider("lineHeight", t("reading.lineHeight"), "")}
          {slider("width", t("reading.width"), " ch")}

          <label style={row}>
            <input type="checkbox" checked={s.spacedHebrew} onChange={(e) => set("spacedHebrew", e.currentTarget.checked)} data-testid="reading-spaced" />
            <span>{t("reading.spacedHebrew")}</span>
          </label>
          <label style={row}>
            <input type="checkbox" checked={s.dyslexiaLatin} onChange={(e) => set("dyslexiaLatin", e.currentTarget.checked)} data-testid="reading-dyslexia" />
            <span>
              {t("reading.dyslexia")} <span style={muted}>({DYSLEXIA_FONT.name} · {t("reading.font.download", { kb: kb(downloadBytes(DYSLEXIA_FONT)) })})</span>
            </span>
          </label>
          {s.dyslexiaLatin && (
            <div lang="en" dir="ltr" style={{ fontFamily: `"${DYSLEXIA_FONT.family}", var(--font-sans)`, fontSize: s.size, padding: "6px 12px", borderRadius: 8, background: "hsl(var(--bg-subtle))" }}>
              {/* i18n-allow: a fixed English pangram shows the Latin face */}
              {LATIN_SAMPLE}
            </div>
          )}

          <div style={{ ...row, justifyContent: "space-between" }}>
            <span role="status" aria-live="polite" style={muted} data-testid="reading-status">
              {loading ? t("reading.loading") : failed ? t("reading.failed") : ""}
            </span>
            <button type="button" style={btn} onClick={() => commit({ ...DEFAULT_READING })} data-testid="reading-reset">
              {t("reading.reset")}
            </button>
          </div>
          <p style={muted}>{t("reading.license")}</p>
        </div>
      </div>
    </div>
  );
}
