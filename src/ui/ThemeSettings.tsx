/**
 * Theme settings panel (palette: `settings.theme`).
 *
 * Every control writes straight to the store, which applies the CSS
 * variables to <html> immediately — the whole app (and the sample block
 * at the top of the panel) is the live preview. Import is strictly
 * validated by `parseThemeJson`; export downloads the same JSON shape.
 */

import { useEffect, useId, useRef, useState } from "react";
import { useFocusTrap } from "./useFocusTrap";
import { Palette as PaletteIcon, X, Download, Upload, RotateCcw, Check, AlertTriangle } from "lucide-react";
import { useAppStore } from "../store/useStore";
import {
  FONT_CHOICES,
  LIMITS,
  PRESET_IDS,
  PRESETS,
  STYLESHEET_PALETTE,
  contrastReport,
  effectivePalette,
  exportThemeJson,
  isValidCustomFont,
  parseThemeJson,
  type FontChoice,
  type PresetId,
} from "../lib/themeSettings";
import { isHexColor, normalizeHex } from "../lib/contrast";
import { downloadText } from "../storage/exportFormats";
import { showAiToast } from "./AiToast";
import { t } from "../i18n";

interface Props {
  open: boolean;
  onClose: () => void;
  /** Rendered as a tab of the settings screen: no backdrop, no own close. */
  embedded?: boolean;
}

function useIsDark(open: boolean): boolean {
  const read = () =>
    typeof document !== "undefined" && document.documentElement.classList.contains("dark");
  const [dark, setDark] = useState(read);
  useEffect(() => {
    if (!open || typeof MutationObserver === "undefined") return;
    setDark(read());
    const obs = new MutationObserver(() => setDark(read()));
    obs.observe(document.documentElement, { attributes: true, attributeFilter: ["class"] });
    return () => obs.disconnect();
  }, [open]);
  return dark;
}

export function ThemeSettings({ open, onClose, embedded = false }: Props) {
  const settings = useAppStore((s) => s.themeSettings);
  const setThemeSettings = useAppStore((s) => s.setThemeSettings);
  const resetThemeSettings = useAppStore((s) => s.resetThemeSettings);
  const dark = useIsDark(open);
  const ids = useId();
  const fileRef = useRef<HTMLInputElement | null>(null);
  const [accentDraft, setAccentDraft] = useState("");
  const [fontDraft, setFontDraft] = useState(settings.customFont);
  const [importError, setImportError] = useState<string | null>(null);

  useEffect(() => {
    if (!open) return;
    setImportError(null);
    setFontDraft(useAppStore.getState().themeSettings.customFont);
    setAccentDraft("");
  }, [open]);

  // Focus stays in the dialog while it is open and returns on close; Escape closes it (plan 10.1).
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { active: open && !embedded, onEscape: onClose });

  if (!open) return null;

  const palette = effectivePalette(settings, dark);
  const report = contrastReport(palette);
  const accentHex = settings.accent ?? palette.accent;
  const accentInvalid = accentDraft !== "" && !isHexColor(accentDraft);
  const fontInvalid = settings.fontFamily === "custom" && fontDraft !== "" && !isValidCustomFont(fontDraft);

  const commitAccent = (value: string) => {
    setAccentDraft(value);
    if (isHexColor(value)) setThemeSettings({ accent: normalizeHex(value) });
  };

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    setImportError(null);
    if (file.size > LIMITS.importMaxBytes) {
      setImportError(t("themeSettings.import.error.tooLarge"));
      return;
    }
    const res = parseThemeJson(await file.text());
    if (!res.ok) {
      setImportError(t(`themeSettings.import.error.${res.error}`, { key: res.key ?? "" }));
      return;
    }
    setThemeSettings(res.settings);
    setFontDraft(res.settings.customFont);
    setAccentDraft("");
    showAiToast(t("themeSettings.import.done"), "success");
  };

  const onReset = () => {
    resetThemeSettings();
    setFontDraft("");
    setAccentDraft("");
    setImportError(null);
  };

  return (
    <div className={embedded ? undefined : "cmd-palette-backdrop"} onClick={embedded ? undefined : onClose}>
      <div
        className={embedded ? undefined : "cmd-palette"}
        ref={trapRef}
        role={embedded ? "region" : "dialog"}
        aria-modal={embedded ? undefined : "true"}
        aria-labelledby={`${ids}-title`}
        onClick={(e) => e.stopPropagation()}
        style={embedded ? { display: "flex", flexDirection: "column" } : { maxWidth: 600, maxHeight: "86vh", display: "flex", flexDirection: "column" }}
        data-testid="theme-settings"
      >
        <div style={header}>
          <PaletteIcon size={16} aria-hidden="true" />
          <h2 id={`${ids}-title`} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("themeSettings.title")}
          </h2>
          {!embedded && (
            <button type="button" onClick={onClose} aria-label={t("themeSettings.close")} style={iconBtn}>
              <X size={14} />
            </button>
          )}
        </div>

        <div style={{ overflow: "auto", padding: "12px 16px", display: "flex", flexDirection: "column", gap: 16 }}>
          {/* Live sample — reads the same CSS variables as the editor. */}
          <div
            aria-label={t("themeSettings.preview")}
            role="note"
            style={{
              border: "1px solid hsl(var(--border))",
              borderRadius: 8,
              padding: "10px 12px",
              background: "hsl(var(--bg-subtle))",
              color: "hsl(var(--fg))",
              fontFamily: "var(--editor-font)",
              fontSize: "var(--editor-font-size)",
              lineHeight: "var(--editor-line-height)",
            }}
          >
            <div style={{ color: "hsl(var(--accent))", fontWeight: 700 }}>{t("themeSettings.preview.heading")}</div>
            <div>{t("themeSettings.preview.body")}</div>
            <div style={{ color: "hsl(var(--fg-muted))" }}>{t("themeSettings.preview.muted")}</div>
          </div>

          <fieldset style={fieldset}>
            <legend style={sectionTitle}>{t("themeSettings.presets")}</legend>
            <div role="radiogroup" aria-label={t("themeSettings.presets")} style={{ display: "flex", flexWrap: "wrap", gap: 8 }}>
              {PRESET_IDS.map((id) => (
                <PresetButton
                  key={id}
                  id={id}
                  dark={dark}
                  active={settings.preset === id}
                  onSelect={() => setThemeSettings({ preset: id })}
                />
              ))}
            </div>
          </fieldset>

          <fieldset style={fieldset}>
            <legend style={sectionTitle}>{t("themeSettings.accent")}</legend>
            <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
              <input
                type="color"
                value={accentHex}
                onChange={(e) => commitAccent(e.target.value)}
                aria-label={t("themeSettings.accent.picker")}
                style={{ width: 40, height: 30, padding: 0, border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent" }}
              />
              <input
                type="text"
                dir="ltr"
                value={accentDraft || accentHex}
                onChange={(e) => commitAccent(e.target.value.trim())}
                aria-label={t("themeSettings.accent.hex")}
                aria-invalid={accentInvalid || undefined}
                spellCheck={false}
                maxLength={7}
                style={{ ...textInput, width: 100, fontFamily: "ui-monospace, monospace" }}
              />
              {settings.accent && (
                <button type="button" style={linkBtn} onClick={() => { setThemeSettings({ accent: null }); setAccentDraft(""); }}>
                  {t("themeSettings.accent.usePreset")}
                </button>
              )}
            </div>
            {accentInvalid && (
              <p role="alert" style={{ ...muted, color: "hsl(0 70% 50%)", marginTop: 6 }}>
                {t("themeSettings.accent.invalid")}
              </p>
            )}
          </fieldset>

          <fieldset style={fieldset}>
            <legend style={sectionTitle}>{t("themeSettings.typography")}</legend>
            <div style={grid}>
              <label htmlFor={`${ids}-font`} style={label}>{t("themeSettings.font")}</label>
              <select
                id={`${ids}-font`}
                value={settings.fontFamily}
                onChange={(e) => {
                  const fontFamily = e.target.value as FontChoice;
                  if (fontFamily === "custom" && !isValidCustomFont(fontDraft)) {
                    // Can't switch until a valid name exists — keep the
                    // selection visible via the name input below.
                    setThemeSettings({ fontFamily: "custom", customFont: "Inter" });
                    setFontDraft("Inter");
                    return;
                  }
                  setThemeSettings({ fontFamily });
                }}
                style={textInput}
              >
                {FONT_CHOICES.map((f) => (
                  <option key={f} value={f}>{t(`themeSettings.font.${f}`)}</option>
                ))}
              </select>

              {settings.fontFamily === "custom" && (
                <>
                  <label htmlFor={`${ids}-custom-font`} style={label}>{t("themeSettings.font.customName")}</label>
                  <div>
                    <input
                      id={`${ids}-custom-font`}
                      type="text"
                      value={fontDraft}
                      maxLength={LIMITS.customFontMaxLength}
                      onChange={(e) => {
                        setFontDraft(e.target.value);
                        if (isValidCustomFont(e.target.value)) setThemeSettings({ customFont: e.target.value });
                      }}
                      aria-invalid={fontInvalid || undefined}
                      aria-describedby={`${ids}-custom-font-help`}
                      style={{ ...textInput, width: "100%" }}
                    />
                    <p id={`${ids}-custom-font-help`} style={{ ...muted, marginTop: 4, color: fontInvalid ? "hsl(0 70% 50%)" : undefined }}>
                      {t(fontInvalid ? "themeSettings.font.customInvalid" : "themeSettings.font.customHelp")}
                    </p>
                  </div>
                </>
              )}

              <Slider
                id={`${ids}-size`}
                label={t("themeSettings.fontSize")}
                value={settings.fontSize}
                display={t("themeSettings.px", { n: settings.fontSize })}
                {...LIMITS.fontSize}
                onChange={(v) => setThemeSettings({ fontSize: v })}
              />
              <Slider
                id={`${ids}-lh`}
                label={t("themeSettings.lineHeight")}
                value={settings.lineHeight}
                display={settings.lineHeight.toFixed(2)}
                {...LIMITS.lineHeight}
                onChange={(v) => setThemeSettings({ lineHeight: Math.round(v * 100) / 100 })}
              />
              <Slider
                id={`${ids}-width`}
                label={t("themeSettings.contentWidth")}
                value={settings.contentWidth}
                display={t("themeSettings.ch", { n: settings.contentWidth })}
                {...LIMITS.contentWidth}
                onChange={(v) => setThemeSettings({ contentWidth: v })}
              />
            </div>
          </fieldset>

          <fieldset style={fieldset}>
            <legend style={sectionTitle}>{t("themeSettings.contrast")}</legend>
            <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 4 }} data-testid="theme-contrast">
              {report.map((c) => (
                <li key={c.id} style={{ display: "flex", alignItems: "center", gap: 8, fontSize: 12 }}>
                  {c.pass ? (
                    <Check size={13} aria-hidden="true" style={{ color: "hsl(150 60% 38%)" }} />
                  ) : (
                    <AlertTriangle size={13} aria-hidden="true" style={{ color: "hsl(30 90% 45%)" }} />
                  )}
                  <span>{t(`themeSettings.contrast.${c.id}`)}</span>
                  <span dir="ltr" style={{ marginInlineStart: "auto", fontVariantNumeric: "tabular-nums" }}>
                    {c.ratio.toFixed(2)}:1
                  </span>
                  <span style={{ ...muted, minWidth: 56, textAlign: "end" }}>
                    {c.pass ? t("themeSettings.contrast.pass") : t("themeSettings.contrast.fail", { min: c.required })}
                  </span>
                </li>
              ))}
            </ul>
          </fieldset>

          {importError && (
            <p role="alert" style={{ ...muted, color: "hsl(0 70% 50%)" }} data-testid="theme-import-error">
              {importError}
            </p>
          )}

          <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
            <button
              type="button"
              style={secondaryBtn}
              onClick={() => downloadText("lumen-theme.json", exportThemeJson(settings), "application/json")}
            >
              <Download size={13} aria-hidden="true" /> {t("themeSettings.export")}
            </button>
            <button type="button" style={secondaryBtn} onClick={() => fileRef.current?.click()}>
              <Upload size={13} aria-hidden="true" /> {t("themeSettings.import")}
            </button>
            <input
              ref={fileRef}
              type="file"
              accept="application/json,.json"
              hidden
              data-testid="theme-import-input"
              onChange={(e) => {
                void onImportFile(e.target.files?.[0]);
                e.target.value = "";
              }}
            />
            <button type="button" style={{ ...secondaryBtn, marginInlineStart: "auto" }} onClick={onReset}>
              <RotateCcw size={13} aria-hidden="true" /> {t("themeSettings.reset")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

function PresetButton({ id, dark, active, onSelect }: { id: PresetId; dark: boolean; active: boolean; onSelect: () => void }) {
  const p = PRESETS[id][dark ? "dark" : "light"] ?? STYLESHEET_PALETTE[dark ? "dark" : "light"];
  return (
    <button
      type="button"
      role="radio"
      aria-checked={active}
      onClick={onSelect}
      style={{
        display: "flex",
        alignItems: "center",
        gap: 8,
        padding: "6px 10px",
        borderRadius: 8,
        cursor: "pointer",
        border: active ? "2px solid hsl(var(--accent))" : "1px solid hsl(var(--border))",
        background: "hsl(var(--bg))",
        color: "hsl(var(--fg))",
        fontSize: 12,
      }}
    >
      <span aria-hidden="true" style={{ display: "inline-flex", borderRadius: 4, overflow: "hidden", border: `1px solid ${p.border}` }}>
        <span style={{ width: 12, height: 18, background: p.bg }} />
        <span style={{ width: 12, height: 18, background: p.fg }} />
        <span style={{ width: 12, height: 18, background: p.accent }} />
      </span>
      {t(`themeSettings.preset.${id}`)}
    </button>
  );
}

function Slider(props: {
  id: string;
  label: string;
  value: number;
  display: string;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
}) {
  return (
    <>
      <label htmlFor={props.id} style={label}>{props.label}</label>
      <div style={{ display: "flex", alignItems: "center", gap: 8 }}>
        <input
          id={props.id}
          type="range"
          min={props.min}
          max={props.max}
          step={props.step}
          value={props.value}
          aria-valuetext={props.display}
          onChange={(e) => props.onChange(Number(e.target.value))}
          style={{ flex: 1, accentColor: "hsl(var(--accent))" }}
        />
        <output htmlFor={props.id} dir="ltr" style={{ minWidth: 52, textAlign: "end", fontSize: 12, fontVariantNumeric: "tabular-nums" }}>
          {props.display}
        </output>
      </div>
    </>
  );
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  gap: 10,
  padding: "12px 16px",
  borderBottom: "1px solid hsl(var(--border))",
};
const iconBtn: React.CSSProperties = {
  marginInlineStart: "auto",
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 4,
  display: "flex",
};
const fieldset: React.CSSProperties = { border: "none", margin: 0, padding: 0, minWidth: 0 };
const grid: React.CSSProperties = {
  display: "grid",
  gridTemplateColumns: "minmax(110px, max-content) 1fr",
  alignItems: "center",
  gap: "8px 12px",
};
const label: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-subtle))" };
const muted: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" };
const sectionTitle: React.CSSProperties = {
  margin: "0 0 8px",
  padding: 0,
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: "0.05em",
  color: "hsl(var(--fg-muted))",
};
const textInput: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg))",
  color: "hsl(var(--fg))",
  fontSize: 12,
};
const secondaryBtn: React.CSSProperties = {
  display: "inline-flex",
  alignItems: "center",
  gap: 6,
  padding: "6px 12px",
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  cursor: "pointer",
  fontSize: 12,
};
const linkBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "hsl(var(--accent))",
  textDecoration: "underline",
  cursor: "pointer",
  fontSize: 12,
  padding: 0,
};
