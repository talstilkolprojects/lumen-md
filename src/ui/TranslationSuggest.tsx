/**
 * "Suggest a better translation" (plan W4.18): type the words you saw, pick
 * the string, write a better one, and open a GitHub issue filled in with the
 * key, the English, the current translation and yours. No server and no
 * account in Lumen: the issue opens in a new tab only when you click, and
 * you can copy the text instead. Lazy-loaded from the palette and from the
 * language setting.
 */
import { useEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { createRoot } from "react-dom/client";
import "./translationSuggestStrings";
import { SUPPORTED_LOCALES, getLocale, loadLocale, t } from "../i18n";
import { isBetaLocale } from "../i18n/review";
import { findStrings, suggestionBody, suggestionLink, type StringMatch } from "../i18n/suggest";
import { useFocusTrap } from "./useFocusTrap";
import { version } from "../../package.json";
import { HelpButton } from "./HelpButton";

const input: CSSProperties = { inlineSize: "100%", padding: "4px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "hsl(var(--bg))", color: "hsl(var(--fg))", fontSize: 13, boxSizing: "border-box" };
const btn: CSSProperties = { border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", background: "transparent", color: "inherit", cursor: "pointer" };

export function TranslationSuggest({ onClose, open = (u) => window.open(u, "_blank", "noopener,noreferrer") }: { onClose: () => void; open?: (url: string) => void }) {
  const ref = useRef<HTMLDivElement>(null);
  useFocusTrap(ref, { onEscape: onClose });
  const locale = getLocale();
  const [strings, setStrings] = useState<{ cur: Record<string, string>; en: Record<string, string> } | null>(null);
  const [query, setQuery] = useState("");
  const [picked, setPicked] = useState<StringMatch | null>(null);
  const [suggestion, setSuggestion] = useState("");
  const [note, setNote] = useState("");
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    void Promise.all([loadLocale(locale), loadLocale("en")]).then(([cur, en]) => setStrings({ cur, en }));
  }, [locale]);
  const matches = useMemo(() => (strings ? findStrings(query, strings.cur, strings.en) : []), [query, strings]);
  const name = SUPPORTED_LOCALES.find((l) => l.code === locale)?.label ?? locale;
  const input0 = picked && suggestion.trim() ? { ...picked, locale, suggestion: suggestion.trim(), note, version } : null;
  const link = input0 ? suggestionLink(input0) : null;
  const dir = SUPPORTED_LOCALES.find((l) => l.code === locale)?.dir ?? "ltr";
  return (
    <div role="presentation" onMouseDown={(e) => e.target === e.currentTarget && onClose()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "var(--overlay)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div ref={ref} role="dialog" aria-modal="true" aria-labelledby="ts-title" data-testid="translation-suggest" tabIndex={-1} style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 16, inlineSize: "min(560px, 100%)", maxBlockSize: "85vh", overflow: "auto", fontSize: 13 }}>
        <h2 id="ts-title" style={{ marginBlockStart: 0, fontSize: 16 }}>
          {t("i18nSuggest.title", { language: name })}
        </h2>
        <HelpButton topic="contributing/translations#suggest-a-better-translation" />
        <p style={{ marginBlockStart: 0, color: "hsl(var(--fg-muted))" }}>{isBetaLocale(locale) ? t("i18nSuggest.introBeta") : t("i18nSuggest.intro")}</p>
        <label style={{ display: "grid", gap: 2 }}>
          <span>{t("i18nSuggest.find")}</span>
          <input autoFocus dir="auto" value={query} onChange={(e) => (setQuery(e.target.value), setPicked(null))} style={input} data-testid="ts-query" />
        </label>
        {!picked && query.trim().length >= 2 && (
          <ul role="listbox" aria-label={t("i18nSuggest.matches")} style={{ listStyle: "none", padding: 0, margin: "6px 0", display: "grid", gap: 4 }}>
            {/* empty-action: the search field above */}
            {matches.length === 0 && <li style={{ color: "hsl(var(--fg-muted))" }}>{strings ? t("i18nSuggest.none") : t("i18nSuggest.loading")}</li>}
            {matches.map((m) => (
              <li key={m.key}>
                <button type="button" role="option" aria-selected={false} data-testid="ts-match" onClick={() => (setPicked(m), setSuggestion(m.current))} style={{ ...btn, inlineSize: "100%", textAlign: "start", display: "grid", gap: 2 }}>
                  <span dir={dir}>{m.current}</span>
                  <span dir="ltr" style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>
                    {m.english} · <code>{m.key}</code>
                  </span>
                </button>
              </li>
            ))}
          </ul>
        )}
        {picked && (
          <div style={{ display: "grid", gap: 6, marginBlockStart: 8 }}>
            <div style={{ fontSize: 12 }} dir="ltr">
              <code>{picked.key}</code> — {picked.english}
            </div>
            <label style={{ display: "grid", gap: 2 }}>
              <span>{t("i18nSuggest.yours")}</span>
              <textarea dir={dir} rows={3} value={suggestion} onChange={(e) => setSuggestion(e.target.value)} style={input} data-testid="ts-suggestion" />
            </label>
            <label style={{ display: "grid", gap: 2 }}>
              <span>{t("i18nSuggest.why")}</span>
              <input dir="auto" value={note} onChange={(e) => setNote(e.target.value)} style={input} />
            </label>
            <p style={{ margin: 0, fontSize: 11, color: "hsl(var(--fg-muted))" }}>{t("i18nSuggest.privacy")}</p>
            <div style={{ display: "flex", gap: 8, justifyContent: "flex-end", flexWrap: "wrap" }}>
              <button
                type="button"
                style={btn}
                disabled={!input0}
                onClick={() => {
                  if (!input0) return;
                  void navigator.clipboard?.writeText(suggestionBody(input0)).then(() => setCopied(true));
                }}
              >
                {copied ? t("i18nSuggest.copied") : t("i18nSuggest.copy")}
              </button>
              <button type="button" style={{ ...btn, fontWeight: 600 }} disabled={!link} data-testid="ts-open" onClick={() => link && open(link.url)}>
                {t("i18nSuggest.open")}
              </button>
            </div>
            {link && !link.withBody && <p style={{ margin: 0, fontSize: 11 }}>{t("i18nSuggest.tooLong")}</p>}
          </div>
        )}
        <div style={{ marginBlockStart: 10 }}>
          <button type="button" style={btn} onClick={onClose}>
            {t("i18nSuggest.close")}
          </button>
        </div>
      </div>
    </div>
  );
}

export function openTranslationSuggest(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(<TranslationSuggest onClose={close} />);
}
