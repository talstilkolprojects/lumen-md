/**
 * First-run setup (plan 14.1): four short steps — language, where the vault
 * lives (browser storage or a folder), the look, and what to start with (a
 * sample vault in Hebrew or English, an empty one, "bring your notes" from
 * six apps into the import wizard, or an existing Obsidian folder opened as
 * the vault: plan W11.P6). Every choice applies at once and can be changed
 * later. Loaded lazily, only on a first visit or from ⌘K.
 */
import { useEffect, useRef, useState } from "react";
import { SUPPORTED_LOCALES, getLocale, isLocaleLoaded, loadLocale, systemLanguages, t, type Locale } from "../i18n";
import { useAppStore, type Theme } from "../store/useStore";
import { PRESET_IDS, type PresetId } from "../lib/themeSettings";
import { createFirstNote, currentVault, languageOrder, languagePlan, markSetupDone, openBrowserVault, openFolderVault, reconnectFolderVault, setupDue, type StartChoice } from "./setup";
import "./FirstRun.css";
import { useFocusTrap } from "../ui/useFocusTrap";
import "./firstRunStrings";
import { HelpButton } from "../ui/HelpButton";
import { explainError } from "../lib/userError";
import { FIRST_RUN_SOURCES, openImportWizard, type StartPath } from "./importEvent";
import type { ImportSourceId } from "../storage/import/types";

const ALL_STEPS = ["lang", "vault", "look", "start"] as const;
const THEMES: Theme[] = ["light", "dark", "system"];

export interface FirstRunResult {
  /** The note to open: its workspace path and text. */
  note: { path: string; content: string };
}

interface Props {
  /** Finished: open the note and start the tour. `null`: setup skipped, or handed to the import wizard / an opened folder (W11.P6). */
  onDone: (result: FirstRunResult | null) => void;
}

function folderSupported(): boolean {
  return typeof window !== "undefined" && typeof (window as unknown as { showDirectoryPicker?: unknown }).showDirectoryPicker === "function";
}

export default function FirstRun({ onDone }: Props) {
  const locale = useAppStore((s) => s.locale) as Locale;
  const theme = useAppStore((s) => s.theme);
  const preset = useAppStore((s) => s.themeSettings.preset);
  // The language applies once its strings have loaded; the choice shows at once.
  const [pickedLocale, setPickedLocale] = useState<Locale | null>(null);
  const shownLocale = pickedLocale ?? locale;
  // Plan W4.35: a system that lists Hebrew starts in Hebrew with no language
  // question; otherwise one question, "Which language will you write in?".
  // Reopened from ⌘K (setup already done), the language step is always there.
  const [plan] = useState(() => languagePlan(systemLanguages()));
  const [showLang, setShowLang] = useState(() => plan.ask || !setupDue());
  const STEPS = showLang ? ALL_STEPS : ALL_STEPS.filter((s) => s !== "lang");
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<string | null>(null);
  /** The folder vault needs permission again (browser restart): it can't be written until reconnected. */
  const [disconnected, setDisconnected] = useState(false);
  const [path, setPath] = useState<StartPath>("sample");
  const start: StartChoice = path === "empty" ? "empty" : "sample";
  const [source, setSource] = useState<ImportSourceId>(FIRST_RUN_SOURCES[0]);
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  // Reopened from ⌘K: the vault may already be in a folder.
  useEffect(() => {
    let live = true;
    void currentVault().then((v) => {
      if (!live || v.folder === null) return;
      setFolder(v.folder);
      setDisconnected(v.disconnected);
    });
    return () => {
      live = false;
    };
  }, []);

  // Each step starts at its first control (keyboard and screen readers).
  useEffect(() => {
    panel.current?.querySelector<HTMLElement>("input:not([disabled]), button:not([disabled])")?.focus();
  }, [step]);

  const skip = () => {
    markSetupDone();
    onDone(null);
  };

  // Focus stays in the setup while it is open (plan 10.1); Escape skips it unless it is busy.
  const dialogRef = useRef<HTMLDivElement>(null);
  useFocusTrap(dialogRef, { onEscape: () => !busy && skip() });

  const chooseFolder = async () => {
    const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
    if (!picker) return;
    try {
      const handle = await picker.call(window, { mode: "readwrite" });
      if (await openFolderVault(handle)) {
        setFolder(handle.name);
        setDisconnected(false);
        setStatus(t("onboard.vault.folder.chosen", { folder: handle.name }));
      } else setStatus(t("onboard.vault.folder.denied", { folder: handle.name }));
    } catch {
      /* why: picker cancelled: the vault stays where it was */
    }
  };

  const chooseBrowser = async () => {
    if (folder === null) return;
    await openBrowserVault();
    setFolder(null);
    setDisconnected(false);
    setStatus("");
  };

  /** Permission again for the folder vault; false (with a message) when refused. */
  const reconnect = async (): Promise<boolean> => {
    if (await reconnectFolderVault()) {
      setDisconnected(false);
      setStatus(t("onboard.vault.folder.chosen", { folder: folder ?? "" }));
      return true;
    }
    setStatus(t("onboard.vault.folder.denied", { folder: folder ?? "" }));
    return false;
  };

  /** The language picked may still be loading: settle it before anything is written in it. */
  const settleLocale = async () => {
    const chosen = pickedLocale ?? locale;
    await loadLocale(chosen).catch(() => undefined);
    if (isLocaleLoaded(chosen) && getLocale() !== chosen) useAppStore.getState().setLocale(chosen);
    setPickedLocale(null);
  };

  /** W11.P6 "Bring your notes": setup is done, the import wizard opens on the source picked. */
  const finishWithImport = async () => {
    await settleLocale();
    markSetupDone();
    onDone(null);
    openImportWizard({ source, firstRun: true });
  };

  /** W11.P6 "Open an Obsidian folder": the folder becomes the vault as it is; no note is written into it. */
  const finishWithFolder = async () => {
    if (folder === null) {
      const picker = (window as unknown as { showDirectoryPicker?: (o: object) => Promise<FileSystemDirectoryHandle> }).showDirectoryPicker;
      if (!picker) return;
      let handle: FileSystemDirectoryHandle;
      try {
        handle = await picker.call(window, { mode: "readwrite" });
      } catch {
        return; // why: picker cancelled — stay on this step
      }
      if (!(await openFolderVault(handle))) {
        setStatus(t("onboard.vault.folder.denied", { folder: handle.name }));
        return;
      }
    } else if (disconnected && !(await reconnect())) return;
    await settleLocale();
    window.dispatchEvent(new Event("lumen-workspace-changed"));
    markSetupDone();
    onDone(null);
  };

  const finish = async () => {
    // A folder vault the browser closed: ask first (this click is the user gesture it needs).
    if (path === "import") return void finishWithImport();
    if (path === "obsidianFolder") return void finishWithFolder();
    if (folder !== null && disconnected && !(await reconnect())) return;
    setBusy(true);
    setStatus(t("onboard.working"));
    try {
      // The language picked may still be loading: the first note is in the one that actually applies.
      await settleLocale();
      const note = await createFirstNote(start, getLocale());
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      markSetupDone();
      onDone({ note });
    } catch (e) {
      setBusy(false);
      setStatus(t("onboard.failed", { error: explainError(e) }));
    }
  };

  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const langLabel = SUPPORTED_LOCALES.find((l) => l.code === (locale === "he" ? "he" : "en"))?.label ?? "English";

  return (
    <div className="lumen-firstrun-backdrop">
      <div className="lumen-firstrun" ref={dialogRef} role="dialog" aria-modal="true" aria-labelledby="lumen-firstrun-title" aria-describedby="lumen-firstrun-sub" data-testid="first-run">
        <header className="lumen-firstrun-head">
          <h2 id="lumen-firstrun-title">{t("onboard.title")}</h2>
          <HelpButton topic="getting-started/quickstart" />
          <p id="lumen-firstrun-sub">{t("onboard.subtitle")}</p>
          {!showLang && (
            <p className="lumen-firstrun-hint">
              {t("onboard.lang.current", { language: SUPPORTED_LOCALES.find((l) => l.code === shownLocale)?.label ?? shownLocale })}{" "}
              <button
                type="button"
                className="lumen-firstrun-link"
                data-testid="first-run-change-language"
                onClick={() => {
                  setShowLang(true);
                  setStep(0);
                }}
              >
                {t("onboard.lang.change")}
              </button>
            </p>
          )}
          <ol className="lumen-firstrun-dots" aria-label={t("onboard.step", { n: step + 1, total: STEPS.length })}>
            {STEPS.map((s, i) => (
              <li key={s} data-on={i <= step} aria-current={i === step ? "step" : undefined} />
            ))}
          </ol>
        </header>

        <div className="lumen-firstrun-body" ref={panel}>
          {current === "lang" && (
            <fieldset>
              <legend>{t("onboard.lang.write")}</legend>
              <p className="lumen-firstrun-hint">{t("onboard.lang.write.body")}</p>
              <div className="lumen-firstrun-grid">
                {languageOrder(SUPPORTED_LOCALES).map((l) => (
                  <label key={l.code} className="lumen-firstrun-choice" data-checked={shownLocale === l.code}>
                    <input
                      type="radio"
                      name="fr-lang"
                      checked={shownLocale === l.code}
                      onChange={() => {
                        setPickedLocale(l.code);
                        useAppStore.getState().setLocale(l.code);
                        // Once loading settles the store holds what applied (English if the strings failed to load).
                        void loadLocale(l.code)
                          .catch(() => undefined)
                          .then(() => setPickedLocale((p) => (p === l.code ? null : p)));
                      }}
                    />
                    <span lang={l.code} dir={l.dir}>{l.label}</span>
                  </label>
                ))}
              </div>
            </fieldset>
          )}

          {current === "vault" && (
            <fieldset>
              <legend>{t("onboard.vault.title")}</legend>
              <label className="lumen-firstrun-choice wide" data-checked={folder === null}>
                <input type="radio" name="fr-vault" checked={folder === null} onChange={() => void chooseBrowser()} />
                <span>
                  <strong>{t("onboard.vault.opfs")}</strong>
                  <small>{t("onboard.vault.opfs.desc")}</small>
                </span>
              </label>
              <label className="lumen-firstrun-choice wide" data-checked={folder !== null} data-disabled={!folderSupported()}>
                <input type="radio" name="fr-vault" checked={folder !== null} disabled={!folderSupported()} onChange={() => void chooseFolder()} />
                <span>
                  <strong>{t("onboard.vault.folder")}</strong>
                  <small>
                    {folder !== null && disconnected
                      ? t("vault.folder.reconnectBody", { folder })
                      : folderSupported()
                        ? t("onboard.vault.folder.desc")
                        : t("onboard.vault.folder.unsupported")}
                  </small>
                </span>
              </label>
              {folder !== null && disconnected && (
                <button type="button" className="lumen-firstrun-btn" onClick={() => void reconnect()}>
                  {t("vault.folder.reconnect")}
                </button>
              )}
            </fieldset>
          )}

          {current === "look" && (
            <>
              <fieldset>
                <legend>{t("onboard.style.theme")}</legend>
                <div className="lumen-firstrun-grid three">
                  {THEMES.map((th) => (
                    <label key={th} className="lumen-firstrun-choice" data-checked={theme === th}>
                      <input type="radio" name="fr-theme" checked={theme === th} onChange={() => useAppStore.getState().setTheme(th)} />
                      <span>{t(`onboard.style.${th}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
              <fieldset>
                <legend>{t("onboard.style.palette")}</legend>
                <div className="lumen-firstrun-grid">
                  {PRESET_IDS.map((p: PresetId) => (
                    <label key={p} className="lumen-firstrun-choice" data-checked={preset === p} data-preset={p}>
                      <input type="radio" name="fr-preset" checked={preset === p} onChange={() => useAppStore.getState().setThemeSettings({ preset: p })} />
                      <span>{t(`themeSettings.preset.${p}`)}</span>
                    </label>
                  ))}
                </div>
              </fieldset>
            </>
          )}

          {current === "start" && (
            <>
              <fieldset>
                <legend>{t("onboard.start.title")}</legend>
                <label className="lumen-firstrun-choice wide" data-checked={path === "sample"}>
                  <input type="radio" name="fr-start" checked={path === "sample"} onChange={() => setPath("sample")} />
                  <span>
                    <strong>{t("onboard.start.sample")}</strong>
                    <small>{t("onboard.start.sample.desc", { language: langLabel })}</small>
                  </span>
                </label>
                <label className="lumen-firstrun-choice wide" data-checked={path === "empty"}>
                  <input type="radio" name="fr-start" checked={path === "empty"} onChange={() => setPath("empty")} />
                  <span>
                    {/* empty-allow: the "start empty" choice's label, not an empty state */}
                    <strong>{t("onboard.start.empty")}</strong>
                    <small>{t("onboard.start.empty.desc")}</small>
                  </span>
                </label>
                <label className="lumen-firstrun-choice wide" data-checked={path === "import"}>
                  <input type="radio" name="fr-start" checked={path === "import"} onChange={() => setPath("import")} data-testid="first-run-path-import" />
                  <span>
                    <strong>{t("onboard.start.import")}</strong>
                    <small>{t("onboard.start.import.desc")}</small>
                  </span>
                </label>
                <label className="lumen-firstrun-choice wide" data-checked={path === "obsidianFolder"} data-disabled={!folderSupported()}>
                  <input type="radio" name="fr-start" checked={path === "obsidianFolder"} disabled={!folderSupported()} onChange={() => setPath("obsidianFolder")} data-testid="first-run-path-folder" />
                  <span>
                    <strong>{t("onboard.start.folder")}</strong>
                    <small>{folderSupported() ? (folder !== null ? t("onboard.start.folder.current", { folder }) : t("onboard.start.folder.desc")) : t("onboard.vault.folder.unsupported")}</small>
                  </span>
                </label>
              </fieldset>
              {path === "import" && (
                <fieldset data-testid="first-run-sources">
                  <legend>{t("onboard.import.from")}</legend>
                  <div className="lumen-firstrun-grid">
                    {FIRST_RUN_SOURCES.map((s) => (
                      <label key={s} className="lumen-firstrun-choice" data-checked={source === s}>
                        <input type="radio" name="fr-source" checked={source === s} onChange={() => setSource(s)} />
                        <span>{t(`onboard.import.source.${s}`)}</span>
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}
            </>
          )}
        </div>

        <p className="lumen-firstrun-status" role="status" aria-live="polite">
          {status}
        </p>

        <footer className="lumen-firstrun-foot">
          <button type="button" className="lumen-firstrun-link" onClick={skip} disabled={busy}>
            {t("onboard.skip")}
          </button>
          <span className="lumen-firstrun-spacer" />
          {step > 0 && (
            <button type="button" className="lumen-firstrun-btn" onClick={() => setStep(step - 1)} disabled={busy}>
              {t("onboard.back")}
            </button>
          )}
          <button type="button" className="lumen-firstrun-btn primary" disabled={busy} onClick={() => (last ? void finish() : setStep(step + 1))}>
            {last ? t(path === "import" ? "onboard.finish.import" : path === "obsidianFolder" ? "onboard.finish.folder" : "onboard.finish") : t("onboard.next")}
          </button>
        </footer>
      </div>
    </div>
  );
}
