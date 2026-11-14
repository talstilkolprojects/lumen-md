/**
 * First-run setup (plan 14.1): four short steps — language, where the vault
 * lives (browser storage or a folder), the look, and what to start with (a
 * sample vault in Hebrew or English, or an empty one, with an optional
 * Obsidian / Notion import). Every choice applies at once and can be changed
 * later. Loaded lazily, only on a first visit or from ⌘K.
 */
import { useEffect, useRef, useState } from "react";
import { SUPPORTED_LOCALES, getLocale, isLocaleLoaded, loadLocale, t, type Locale } from "../i18n";
import { useAppStore, type Theme } from "../store/useStore";
import { PRESET_IDS, type PresetId } from "../lib/themeSettings";
import { createFirstNote, currentVault, importInto, markSetupDone, onVaultChange, openBrowserVault, openFolderVault, reconnectFolderVault, type StartChoice } from "./setup";
import "./FirstRun.css";

const STEPS = ["lang", "vault", "look", "start"] as const;
const THEMES: Theme[] = ["light", "dark", "system"];

export interface FirstRunResult {
  /** The note to open: its workspace path and text. */
  note: { path: string; content: string };
}

interface Props {
  /** Finished: open the note and start the tour. `null`: setup skipped. */
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
  const [step, setStep] = useState(0);
  const [folder, setFolder] = useState<string | null>(null);
  /** The folder vault needs permission again (browser restart): it can't be written until reconnected. */
  const [disconnected, setDisconnected] = useState(false);
  /** Start-up is still finding the vault (a slow restore): no choice can be made, nothing is written. */
  const [restoring, setRestoring] = useState(false);
  const [start, setStart] = useState<StartChoice>("sample");
  const [status, setStatus] = useState("");
  const [busy, setBusy] = useState(false);
  const panel = useRef<HTMLDivElement>(null);
  const importKind = useRef<"obsidian" | "notion">("obsidian");
  const fileInput = useRef<HTMLInputElement>(null);

  // Reopened from ⌘K: the vault may already be in a folder. A slow start-up
  // may still be restoring it: read again whenever the vault's place changes.
  useEffect(() => {
    let live = true;
    let stop: (() => void) | null = null;
    const read = () =>
      void currentVault().then((v) => {
        if (!live) return;
        setRestoring(v.restoring);
        if (v.restoring) return;
        setFolder(v.folder);
        setDisconnected(v.disconnected);
      });
    read();
    void onVaultChange(read).then((off) => {
      if (live) stop = off;
      else off();
    });
    return () => {
      live = false;
      stop?.();
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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) skip();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [busy]);

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
      /* picker cancelled: the vault stays where it was */
    }
  };

  const chooseBrowser = async () => {
    if (folder === null || restoring) return;
    if (!(await openBrowserVault())) return; // still restoring: nothing switched
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

  const startImport = (kind: "obsidian" | "notion") => {
    importKind.current = kind;
    const input = fileInput.current;
    if (!input) return;
    input.value = "";
    input.accept = kind === "notion" ? ".zip,application/zip" : "";
    (input as HTMLInputElement & { webkitdirectory: boolean }).webkitdirectory = kind === "obsidian";
    input.click();
  };

  const onImportFiles = async () => {
    const files = fileInput.current?.files;
    if (!files?.length) return;
    setBusy(true);
    try {
      const r = await importInto(importKind.current, files);
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      setStatus(t("onboard.import.done", { notes: String(r.notes), folder: r.folder }));
    } catch (e) {
      setStatus(t("onboard.import.failed", { error: (e as Error).message }));
    } finally {
      setBusy(false);
    }
  };

  const finish = async () => {
    if (restoring) return; // where to write is not known yet
    // A folder vault the browser closed: ask first (this click is the user gesture it needs).
    if (folder !== null && disconnected && !(await reconnect())) return;
    setBusy(true);
    setStatus(t("onboard.working"));
    try {
      // The language picked may still be loading: the first note is in the one that actually applies.
      const chosen = pickedLocale ?? locale;
      await loadLocale(chosen).catch(() => undefined);
      if (isLocaleLoaded(chosen) && getLocale() !== chosen) useAppStore.getState().setLocale(chosen);
      setPickedLocale(null);
      const note = await createFirstNote(start, getLocale());
      window.dispatchEvent(new Event("lumen-workspace-changed"));
      markSetupDone();
      onDone({ note });
    } catch (e) {
      setBusy(false);
      setStatus(t("onboard.failed", { error: (e as Error).message }));
    }
  };

  const current = STEPS[step];
  const last = step === STEPS.length - 1;
  const langLabel = SUPPORTED_LOCALES.find((l) => l.code === (locale === "he" ? "he" : "en"))?.label ?? "English";

  return (
    <div className="lumen-firstrun-backdrop">
      <div className="lumen-firstrun" role="dialog" aria-modal="true" aria-labelledby="lumen-firstrun-title" aria-describedby="lumen-firstrun-sub" data-testid="first-run">
        <header className="lumen-firstrun-head">
          <h2 id="lumen-firstrun-title">{t("onboard.title")}</h2>
          <p id="lumen-firstrun-sub">{t("onboard.subtitle")}</p>
          <ol className="lumen-firstrun-dots" aria-label={t("onboard.step", { n: step + 1, total: STEPS.length })}>
            {STEPS.map((s, i) => (
              <li key={s} data-on={i <= step} aria-current={i === step ? "step" : undefined} />
            ))}
          </ol>
        </header>

        <div className="lumen-firstrun-body" ref={panel}>
          {current === "lang" && (
            <fieldset>
              <legend>{t("onboard.lang.title")}</legend>
              <p className="lumen-firstrun-hint">{t("onboard.lang.body")}</p>
              <div className="lumen-firstrun-grid">
                {SUPPORTED_LOCALES.map((l) => (
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
              <label className="lumen-firstrun-choice wide" data-checked={!restoring && folder === null} data-disabled={restoring}>
                <input type="radio" name="fr-vault" checked={!restoring && folder === null} disabled={restoring} onChange={() => void chooseBrowser()} />
                <span>
                  <strong>{t("onboard.vault.opfs")}</strong>
                  <small>{t("onboard.vault.opfs.desc")}</small>
                </span>
              </label>
              <label className="lumen-firstrun-choice wide" data-checked={!restoring && folder !== null} data-disabled={restoring || !folderSupported()}>
                <input type="radio" name="fr-vault" checked={!restoring && folder !== null} disabled={restoring || !folderSupported()} onChange={() => void chooseFolder()} />
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
              {restoring && <p className="lumen-firstrun-note">{t("vault.folder.restoring")}</p>}
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
                <label className="lumen-firstrun-choice wide" data-checked={start === "sample"}>
                  <input type="radio" name="fr-start" checked={start === "sample"} onChange={() => setStart("sample")} />
                  <span>
                    <strong>{t("onboard.start.sample")}</strong>
                    <small>{t("onboard.start.sample.desc", { language: langLabel })}</small>
                  </span>
                </label>
                <label className="lumen-firstrun-choice wide" data-checked={start === "empty"}>
                  <input type="radio" name="fr-start" checked={start === "empty"} onChange={() => setStart("empty")} />
                  <span>
                    <strong>{t("onboard.start.empty")}</strong>
                    <small>{t("onboard.start.empty.desc")}</small>
                  </span>
                </label>
              </fieldset>
              <fieldset>
                <legend>{t("onboard.import.title")}</legend>
                <div className="lumen-firstrun-row">
                  <button type="button" className="lumen-firstrun-btn" disabled={busy} onClick={() => startImport("obsidian")}>
                    {t("onboard.import.obsidian")}
                  </button>
                  <button type="button" className="lumen-firstrun-btn" disabled={busy} onClick={() => startImport("notion")}>
                    {t("onboard.import.notion")}
                  </button>
                </div>
                <input ref={fileInput} type="file" multiple hidden onChange={() => void onImportFiles()} data-testid="first-run-import" />
              </fieldset>
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
          <button type="button" className="lumen-firstrun-btn primary" disabled={busy || (last && restoring)} onClick={() => (last ? void finish() : setStep(step + 1))}>
            {last ? t("onboard.finish") : t("onboard.next")}
          </button>
        </footer>
      </div>
    </div>
  );
}
