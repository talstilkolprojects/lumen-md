/**
 * One settings screen (plan 11.1): tabs, search, export / import.
 *
 * - General: the persisted switches and choices, drawn from
 *   `src/settings/schema.ts` (each control writes straight to the store or
 *   localStorage, so a change applies at once).
 * - The other tabs are the existing dialogs (theme, AI with the model
 *   manager, sync and collaboration, training, trusted keys, organization),
 *   rendered in place with `embedded`.
 * - Search matches the labels and keys of every setting, including the
 *   ones inside a tab's dialog, and narrows the tabs to the matching ones.
 *
 * The whole file is a lazy chunk: App only holds which tab is open.
 */

import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from "react";
import { Settings as SettingsIcon, X, Download, Upload, Search } from "lucide-react";
import { useAppStore, type AppState } from "../store/useStore";
import { SETTINGS_TABS, searchSettings, type SettingEntry, type SettingsTab } from "../settings/schema";
import { exportSettings, importSettings, parseSettingsFile, type SettingsTarget } from "../settings/io";
import { downloadText } from "../storage/exportFormats";
import { showAiToast } from "./AiToast";
import { SUPPORTED_LOCALES, t, type Locale } from "../i18n";
import { isBetaLocale } from "../i18n/review";
import { useFocusTrap } from "./useFocusTrap";
import "./settingsScreenStrings";
import { HelpButton } from "./HelpButton";
// W5.11: the "keep photo metadata" switch's label ships with this lazy screen.
import "../lib/journalistStrings";

const ThemeSettings = lazy(() => import("./ThemeSettings").then((m) => ({ default: m.ThemeSettings })));
const AiSettingsPanel = lazy(() => import("./AiSettingsPanel").then((m) => ({ default: m.AiSettingsPanel })));
const CollabSettings = lazy(() => import("./CollabSettings").then((m) => ({ default: m.CollabSettings })));
const FineTuneSettings = lazy(() => import("./FineTuneSettings").then((m) => ({ default: m.FineTuneSettings })));
const TrustedKeysSettings = lazy(() => import("./TrustedKeysSettings").then((m) => ({ default: m.TrustedKeysSettings })));
const OrgSettings = lazy(() => import("./OrgSettings").then((m) => ({ default: m.OrgSettings })));

/** A settings file is a few KB; anything far larger isn't one. */
const IMPORT_MAX_BYTES = 256 * 1024;

interface Props {
  tab?: SettingsTab;
  onClose: () => void;
  onOpenAuditLog?: () => void;
}

/** Store fields whose setter does more than set (direction, lazy locale, sanitising). */
function applyAppPatch(patch: Record<string, unknown>): void {
  const s = useAppStore.getState();
  const rest: Partial<AppState> = {};
  for (const [field, value] of Object.entries(patch)) {
    switch (field) {
      case "theme":
        s.setTheme(value as AppState["theme"]);
        break;
      case "locale":
        s.setLocale(value as Locale);
        break;
      case "themeSettings":
        s.setThemeSettings(value as Partial<AppState["themeSettings"]>);
        break;
      case "dailyNotes": {
        const d = value as Record<string, unknown>;
        const strings = Object.fromEntries(
          (["folder", "pattern", "template"] as const).filter((k) => typeof d[k] === "string").map((k) => [k, d[k] as string]),
        );
        s.setDailyNotes(strings);
        break;
      }
      case "writingGoalWords":
        s.setWritingGoal(value as number);
        break;
      case "mobileToolbar":
        // Unknown or repeated action ids go, as when the store loads (review t5, L2).
        s.setMobileToolbar(value as AppState["mobileToolbar"]);
        break;
      case "enabledSnippets":
        rest.enabledSnippets = [...new Set(value as string[])];
        break;
      case "rtl":
        if (s.rtl !== value) s.toggleRtl();
        break;
      case "showCalendar":
        if (s.showCalendar !== value) s.toggleCalendar();
        break;
      case "useFineTunedModel":
        if (s.useFineTunedModel !== value) s.toggleFineTunedModel();
        break;
      default:
        (rest as Record<string, unknown>)[field] = value;
    }
  }
  if (Object.keys(rest).length) useAppStore.setState(rest);
}

function browserTarget(): SettingsTarget {
  return {
    getApp: () => useAppStore.getState() as unknown as Record<string, unknown>,
    applyApp: applyAppPatch,
    storage: localStorage,
  };
}

function readLocal(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function writeLocal(key: string, value: string): void {
  try {
    if (value === "") localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    /* why: storage denied */
  }
}

export function SettingsScreen({ tab: initialTab = "general", onClose, onOpenAuditLog }: Props) {
  const ids = useId();
  const [tab, setTab] = useState<SettingsTab>(initialTab);
  const [query, setQuery] = useState("");
  const searchRef = useRef<HTMLInputElement>(null);
  const fileRef = useRef<HTMLInputElement>(null);
  const state = useAppStore();
  // Re-render after a localStorage-backed control changes.
  const [, setLocalVersion] = useState(0);

  const { entries, tabs } = useMemo(() => searchSettings(query, t), [query]);
  const visibleTabs = SETTINGS_TABS.filter((x) => tabs.has(x.id));

  useEffect(() => {
    searchRef.current?.focus();
  }, []);

  // One focus trap for every dialog (plan 10.1): focus stays in the screen, Escape closes it.
  const trapRef = useRef<HTMLDivElement | null>(null);
  useFocusTrap(trapRef, { onEscape: onClose });

  // A search that leaves the open tab out moves to the first tab it found.
  useEffect(() => {
    if (!tabs.has(tab) && visibleTabs[0]) setTab(visibleTabs[0].id);
  }, [tabs, tab, visibleTabs]);

  const onImportFile = async (file: File | undefined) => {
    if (!file) return;
    const parsed = file.size <= IMPORT_MAX_BYTES ? parseSettingsFile(await file.text()) : null;
    if (!parsed) {
      showAiToast(t("settings.importFailed"), "error");
      return;
    }
    const { applied, skipped, refused } = importSettings(parsed, browserTarget());
    setLocalVersion((v) => v + 1);
    showAiToast(t("settings.imported", { n: applied, skipped: skipped.length }), "success");
    // An import never loosens privacy (settings/io.ts): name what it left as it was.
    if (refused.length) showAiToast(t("settings.importRefused", { keys: refused.join(", ") }), "info");
  };

  const onExport = () => {
    const file = exportSettings(browserTarget());
    downloadText("lumen-settings.json", `${JSON.stringify(file, null, 2)}\n`, "application/json");
  };

  const general = entries.filter((e) => e.tab === "general" && e.label && e.type !== "json" && e.type !== "list" && e.type !== "text");

  const setEntry = (entry: SettingEntry, value: unknown) => {
    if (entry.store === "app") applyAppPatch({ [entry.id]: value });
    else {
      writeLocal(entry.id, String(value));
      setLocalVersion((v) => v + 1);
    }
  };

  const valueOf = (entry: SettingEntry): unknown =>
    entry.store === "app" ? (state as unknown as Record<string, unknown>)[entry.id] : readLocal(entry.id) ?? "";

  const control = (entry: SettingEntry) => {
    const id = `${ids}-${entry.id}`;
    const value = valueOf(entry);
    const label = t(entry.label ?? entry.id);
    if (entry.type === "boolean") {
      const [off, on] = entry.values ?? [false, true];
      return (
        <label key={entry.id} htmlFor={id} style={row}>
          <input
            id={id}
            type="checkbox"
            checked={value === on}
            data-setting={entry.id}
            onChange={(e) => setEntry(entry, e.target.checked ? on : off)}
          />
          <span>{label}</span>
        </label>
      );
    }
    if (entry.type === "choice") {
      // Languages a native speaker has not reviewed yet are marked beta (plan W4.18).
      const optionLabel = (o: { value: string; label?: string }) => {
        if (o.label) return t(o.label);
        const name = SUPPORTED_LOCALES.find((l) => l.code === o.value)?.label ?? o.value;
        return entry.id === "locale" && isBetaLocale(o.value) ? t("locale.betaLabel", { label: name }) : name;
      };
      const select = (
        <label key={entry.id} htmlFor={id} style={row}>
          <span style={{ flex: 1 }}>{label}</span>
          <select id={id} value={String(value)} data-setting={entry.id} onChange={(e) => setEntry(entry, e.target.value)} style={input}>
            {(entry.options ?? []).map((o) => (
              <option key={o.value} value={o.value}>
                {optionLabel(o)}
              </option>
            ))}
          </select>
        </label>
      );
      if (entry.id !== "locale" || !isBetaLocale(String(value))) return select;
      return (
        <div key={entry.id}>
          {select}
          <p data-testid="locale-beta-note" style={{ margin: "2px 0 8px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>
            {t("locale.betaNote")}{" "}
            <button type="button" data-testid="locale-suggest" onClick={() => void import("./TranslationSuggest").then((m) => m.openTranslationSuggest())} style={{ border: "none", background: "none", padding: 0, color: "hsl(var(--accent))", cursor: "pointer", textDecoration: "underline", font: "inherit" }}>
              {t("cmd.i18n.suggest")}
            </button>
          </p>
        </div>
      );
    }
    return (
      <label key={entry.id} htmlFor={id} style={row}>
        <span style={{ flex: 1 }}>{label}</span>
        <input
          id={id}
          type="number"
          min={entry.min}
          max={entry.max}
          value={Number(value) || 0}
          data-setting={entry.id}
          onChange={(e) => {
            const n = Number(e.target.value);
            if (Number.isFinite(n)) setEntry(entry, entry.store === "app" ? n : String(n));
          }}
          style={{ ...input, width: 96 }}
        />
      </label>
    );
  };

  const panel = () => {
    switch (tab) {
      case "general":
        // empty-action: the settings search field (clearing it shows every setting)
        return general.length ? <div style={{ display: "flex", flexDirection: "column", gap: 4 }}>{general.map(control)}</div> : <p style={muted}>{t("settings.empty")}</p>;
      case "appearance":
        return <ThemeSettings open embedded onClose={onClose} />;
      case "ai":
        return <AiSettingsPanel open embedded onClose={onClose} />;
      case "sync":
        return <CollabSettings embedded onClose={onClose} />;
      case "fineTune":
        return <FineTuneSettings open embedded onClose={onClose} />;
      case "security":
        return <TrustedKeysSettings open embedded onClose={onClose} />;
      case "org":
        return <OrgSettings open embedded onClose={onClose} onOpenAuditLog={onOpenAuditLog} />;
    }
  };

  return (
    <div className="cmd-palette-backdrop" onClick={onClose}>
      <div
        className="cmd-palette"
        ref={trapRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby={`${ids}-title`}
        data-testid="settings-screen"
        onClick={(e) => e.stopPropagation()}
        style={{ width: "min(920px, 96vw)", maxWidth: 920, maxHeight: "90vh", height: "90vh", padding: 0, display: "flex", flexDirection: "column" }}
      >
        <header style={header}>
          <SettingsIcon size={16} aria-hidden="true" />
          <h2 id={`${ids}-title`} style={{ margin: 0, fontSize: 16, fontWeight: 600 }}>
            {t("settings.title")}
          </h2>
          <HelpButton topic="editor/settings" />
          <div style={{ flex: 1, display: "flex", alignItems: "center", gap: 6, minWidth: 120 }}>
            <Search size={14} aria-hidden="true" style={{ color: "hsl(var(--fg-muted))" }} />
            <input
              ref={searchRef}
              type="search"
              value={query}
              onChange={(e) => setQuery(e.target.value)}
              placeholder={t("settings.search")}
              aria-label={t("settings.search")}
              data-testid="settings-search"
              style={{ ...input, flex: 1 }}
            />
          </div>
          <button type="button" style={secondaryBtn} onClick={onExport}>
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
            data-testid="settings-import-input"
            onChange={(e) => {
              void onImportFile(e.target.files?.[0]);
              e.target.value = "";
            }}
          />
          <button type="button" onClick={onClose} aria-label={t("ai.settings.close")} style={iconBtn}>
            <X size={14} />
          </button>
        </header>
        <div style={{ display: "flex", flex: 1, minHeight: 0, flexWrap: "wrap" }}>
          <nav role="tablist" aria-orientation="vertical" aria-label={t("settings.title")} style={nav}>
            {visibleTabs.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                id={`${ids}-tab-${x.id}`}
                aria-selected={tab === x.id}
                aria-controls={`${ids}-panel`}
                data-tab={x.id}
                onClick={() => setTab(x.id)}
                style={tab === x.id ? { ...tabBtn, ...tabActive } : tabBtn}
              >
                {t(x.label)}
              </button>
            ))}
            {/* empty-action: the settings search field above (clearing it shows every tab) */}
            {!visibleTabs.length && <p style={{ ...muted, padding: 8 }}>{t("settings.empty")}</p>}
          </nav>
          <section
            role="tabpanel"
            id={`${ids}-panel`}
            aria-labelledby={`${ids}-tab-${tab}`}
            data-testid={`settings-tab-${tab}`}
            style={{ flex: "1 1 320px", minWidth: 0, overflowY: "auto", padding: 16, maxHeight: "100%" }}
          >
            {visibleTabs.length > 0 && <Suspense fallback={<p style={muted}>…</p>}>{panel()}</Suspense>}
          </section>
        </div>
      </div>
    </div>
  );
}

const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  flexWrap: "wrap",
  gap: 10,
  padding: "12px 16px",
  borderBottom: "1px solid hsl(var(--border))",
};
const nav: React.CSSProperties = {
  display: "flex",
  flexDirection: "column",
  gap: 2,
  padding: 8,
  flex: "0 0 200px",
  borderInlineEnd: "1px solid hsl(var(--border))",
  overflowY: "auto",
};
const tabBtn: React.CSSProperties = {
  textAlign: "start",
  padding: "8px 10px",
  borderRadius: 6,
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg))",
  cursor: "pointer",
  fontSize: 13,
};
const tabActive: React.CSSProperties = { background: "hsl(var(--accent) / 0.12)", color: "hsl(var(--accent))", fontWeight: 600 };
const row: React.CSSProperties = { display: "flex", alignItems: "center", gap: 10, padding: "6px 0", fontSize: 13, cursor: "pointer" };
const input: React.CSSProperties = {
  padding: "5px 8px",
  borderRadius: 6,
  border: "1px solid hsl(var(--border))",
  background: "hsl(var(--bg-subtle))",
  color: "hsl(var(--fg))",
  fontSize: 13,
};
const iconBtn: React.CSSProperties = {
  border: "none",
  background: "transparent",
  color: "hsl(var(--fg-muted))",
  cursor: "pointer",
  padding: 4,
  display: "flex",
};
const muted: React.CSSProperties = { margin: 0, fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" };
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
