/**
 * Sync in two clicks (plan W4.19): a guided, Hebrew-first setup for people
 * who don't know what WebDAV is.
 *
 *   1. "Where?" — the best place this device has is already chosen
 *      (setup/recommend.ts): a desktop sync app's folder, the encrypted
 *      relay, or WebDAV. One click (plus the system folder dialog).
 *   2. "Your key" — Lumen makes the key: 13 Hebrew words. The user types one
 *      of them back, which shows they saved it, and reads, before anything
 *      starts, that a lost key means a lost sync copy. A second device pastes
 *      the words instead. One click starts the sync.
 *   3. Every file's state (synced, waiting, conflict, can't sync).
 *
 * Google Drive and Dropbox appear only once their OAuth apps exist; the
 * advanced panel keeps WebDAV details, S3 and everything else.
 */

import { useEffect, useMemo, useState, useSyncExternalStore } from "react";
import { getLocale, t } from "../../../i18n";
import "../strings";
import { syncSession, type SyncSession } from "./session";
import { describeConnectError } from "./SyncPanel";
import { oauthAvailable, type ProviderSettings } from "../providers";
import { relayOrigin } from "../providers/relay";
import { isMobileDevice, setupChoices, type SetupBackend } from "../setup/recommend";
import { checkPosition, newRecoveryWords, normalizeWord, parseRecoveryWords, relayToken } from "../setup/recoveryWords";
import type { FileSyncState } from "../status";
import { WrongPassphraseError } from "../header";
import { explainError } from "../../../lib/userError";
import { HelpButton } from "../../../ui/HelpButton";
import { UnauditedNotice } from "./unaudited";

const muted: React.CSSProperties = { fontSize: 13, color: "hsl(var(--fg-muted))" };
const errorStyle: React.CSSProperties = { fontSize: 13, color: "hsl(var(--danger))" };
const big: React.CSSProperties = { padding: "10px 18px", border: "none", borderRadius: 8, background: "hsl(var(--accent))", color: "white", cursor: "pointer", fontSize: 15, justifySelf: "start" };
const field: React.CSSProperties = { width: "100%", padding: "8px 10px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit" };

const STATE_ORDER: FileSyncState[] = ["conflict", "error", "pending", "excluded", "synced"];

function relayUrl(): string | null {
  // Only an explicit relay: its https origin must be in the build's connect-src (cspEndpoints.ts).
  // One name at a time (src/lib/publicEnv.ts): a whole import.meta.env inlines every VITE_* name.
  return relayOrigin((import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SYNC_RELAY_URL);
}

export function SetupWizard({
  onClose,
  onAdvanced,
  session = syncSession(),
  folderAccess,
  relay = relayUrl(),
}: {
  onClose: () => void;
  onAdvanced: () => void;
  session?: SyncSession;
  folderAccess: boolean;
  /** The relay origin (default: from this build's live-share server). */
  relay?: string | null;
}) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const choices = useMemo(
    () => setupChoices({ folderAccess, mobile: isMobileDevice(), relayUrl: relay, dropboxOAuth: oauthAvailable("dropbox"), gdriveOAuth: oauthAvailable("gdrive") }),
    [folderAccess, relay],
  );
  const [where, setWhere] = useState<SetupBackend>(choices.recommended);
  const [step, setStep] = useState<"where" | "key" | "done">(s.phase === "unlocked" ? "done" : "where");
  const [settings, setSettings] = useState<ProviderSettings | null>(null);
  const [webdav, setWebdav] = useState({ url: "", username: "", password: "" });
  const [words, setWords] = useState<string[] | null>(null);
  const [join, setJoin] = useState(false);
  const [typed, setTyped] = useState("");
  const [check, setCheck] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const position = useMemo(() => (words ? checkPosition(words) : 1), [words]);

  useEffect(() => {
    void newRecoveryWords().then(setWords);
  }, []);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const label = (b: SetupBackend) => t(`e2ee.guide.where.${b}`);

  /** Click 1: the place. A folder is picked here (the dialog needs the click). */
  async function chooseWhere() {
    setError(null);
    if (where === "dropbox" || where === "gdrive") return onAdvanced();
    if (where === "folder") {
      const { pickSyncFolder } = await import("../setup/folderHandle");
      const picked = await pickSyncFolder().catch((e: unknown) => (setError(explainError(e)), null));
      if (!picked) return;
      setSettings({ kind: "folder", name: picked.name });
    } else if (where === "relay") setSettings({ kind: "relay", url: relay ?? "" });
    else {
      if (!/^https:\/\//i.test(webdav.url.trim())) return setError(t("e2ee.guide.webdavUrl"));
      setSettings({ kind: "webdav", url: webdav.url.trim(), username: webdav.username.trim() });
    }
    setStep("key");
  }

  /** Click 2: connect, create or join the vault, run the first round. */
  async function start() {
    if (!settings) return;
    setError(null);
    let passphrase: string;
    if (join) {
      const parsed = await parseRecoveryWords(typed);
      if (!parsed.ok) return setError(parsed.reason === "unknown" ? t("e2ee.guide.wordUnknown", { n: (parsed.at ?? 0) + 1 }) : parsed.reason === "count" ? t("e2ee.guide.wordCount", { n: 13 }) : t("e2ee.guide.wordCheck"));
      passphrase = parsed.passphrase;
    } else {
      if (!words) return;
      if (normalizeWord(check) !== words[position - 1]) return setError(t("e2ee.guide.checkWrong", { n: position }));
      passphrase = words.join(" ");
    }
    setBusy(true);
    try {
      const secret = settings.kind === "relay" ? await relayToken(passphrase) : settings.kind === "webdav" ? webdav.password : null;
      await session.connect(settings, secret);
      if (session.get().vaultExists && !join) {
        // The place already holds a vault: this is the second device. Ask for its words.
        setJoin(true);
        setError(t("e2ee.guide.existing"));
        return;
      }
      await session.open(passphrase);
      setStep("done");
    } catch (e) {
      setError(e instanceof WrongPassphraseError ? t("e2ee.guide.wrongKey") : describeConnectError(e, settings));
    } finally {
      setBusy(false);
    }
  }

  const files = s.files ? [...s.files.entries()] : [];
  const counts = new Map<FileSyncState, number>();
  for (const [, f] of files) counts.set(f.state, (counts.get(f.state) ?? 0) + 1);
  const attention = files.filter(([, f]) => f.state === "conflict" || f.state === "error" || f.state === "pending").slice(0, 50);

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "grid", placeItems: "center", zIndex: 1000 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-setup-title"
        dir={getLocale() === "he" || getLocale() === "ar" ? "rtl" : "ltr"}
        data-testid="sync-setup"
        style={{ width: "min(540px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 12, padding: 20, display: "grid", gap: 14 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="sync-setup-title" style={{ margin: 0, fontSize: 18 }}>
            {t("e2ee.guide.title")}
          </h2>
          <span style={{ flex: 1 }} />
          <HelpButton topic="sync/two-clicks" />
          <button type="button" aria-label={t("e2ee.sync.close")} onClick={onClose} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 20 }}>
            ×
          </button>
        </div>
        <UnauditedNotice />

        {step === "where" && (
          <>
            <div style={muted}>{t("e2ee.guide.whereIntro")}</div>
            <div role="radiogroup" aria-label={t("e2ee.guide.whereTitle")} style={{ display: "grid", gap: 8 }}>
              {choices.available.map((b) => (
                <label key={b} style={{ display: "flex", gap: 10, alignItems: "flex-start", padding: 10, border: `1px solid hsl(var(--${where === b ? "accent" : "border"}))`, borderRadius: 8, cursor: "pointer" }}>
                  <input type="radio" name="sync-where" value={b} checked={where === b} onChange={() => setWhere(b)} data-testid={`sync-where-${b}`} />
                  <span style={{ display: "grid", gap: 2 }}>
                    <strong>
                      {label(b)}
                      {b === choices.recommended ? ` · ${t("e2ee.guide.recommended")}` : ""}
                    </strong>
                    <span style={muted}>{t(`e2ee.guide.where.${b}.about`)}</span>
                  </span>
                </label>
              ))}
            </div>
            {where === "webdav" && (
              <div style={{ display: "grid", gap: 6 }}>
                <input style={field} placeholder="https://cloud.example.com/remote.php/dav/files/me/Lumen/" value={webdav.url} onChange={(e) => setWebdav({ ...webdav, url: e.target.value })} aria-label={t("e2ee.sync.url")} dir="ltr" />
                <input style={field} placeholder={t("e2ee.sync.username")} value={webdav.username} onChange={(e) => setWebdav({ ...webdav, username: e.target.value })} aria-label={t("e2ee.sync.username")} dir="ltr" autoComplete="username" />
                <input style={field} type="password" placeholder={t("e2ee.sync.password")} value={webdav.password} onChange={(e) => setWebdav({ ...webdav, password: e.target.value })} aria-label={t("e2ee.sync.password")} dir="ltr" autoComplete="current-password" />
              </div>
            )}
            <button type="button" style={big} onClick={() => void chooseWhere()} data-testid="sync-setup-continue">
              {where === "folder" ? t("e2ee.guide.pickFolder") : t("e2ee.guide.continue")}
            </button>
            <button type="button" onClick={onAdvanced} style={{ justifySelf: "start", background: "none", border: "none", color: "hsl(var(--accent))", cursor: "pointer", padding: 0 }}>
              {t("e2ee.guide.advanced")}
            </button>
          </>
        )}

        {step === "key" && (
          <>
            {!join && words && (
              <>
                <div style={{ fontSize: 14 }}>{t("e2ee.guide.keyIntro")}</div>
                <ol data-testid="sync-setup-words" style={{ display: "grid", gridTemplateColumns: "repeat(auto-fill, minmax(96px, 1fr))", gap: 6, padding: 12, margin: 0, listStylePosition: "inside", border: "1px dashed hsl(var(--border))", borderRadius: 8, fontSize: 16 }} dir="rtl" lang="he">
                  {words.map((w, i) => (
                    <li key={i}>{w}</li>
                  ))}
                </ol>
                <div role="note" style={{ ...errorStyle, color: "hsl(var(--warning))" }}>
                  {t("e2ee.guide.lossWarning")}
                </div>
                <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
                  <button type="button" onClick={() => void navigator.clipboard?.writeText(words.join(" ")).catch(() => undefined)}>
                    {t("e2ee.guide.copy")}
                  </button>
                </div>
                <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
                  {t("e2ee.guide.checkAsk", { n: position })}
                  <input style={field} value={check} onChange={(e) => setCheck(e.target.value)} dir="rtl" lang="he" autoComplete="off" data-testid="sync-setup-check" />
                </label>
              </>
            )}
            {join && (
              <label style={{ display: "grid", gap: 4, fontSize: 14 }}>
                {t("e2ee.guide.joinAsk")}
                <textarea style={{ ...field, minHeight: 80 }} value={typed} onChange={(e) => setTyped(e.target.value)} dir="rtl" lang="he" autoComplete="off" data-testid="sync-setup-join" />
              </label>
            )}
            <button type="button" style={big} disabled={busy} onClick={() => void start()} data-testid="sync-setup-start">
              {busy ? t("e2ee.sync.connecting") : join ? t("e2ee.guide.join") : t("e2ee.guide.start")}
            </button>
            <button type="button" onClick={() => (setJoin(!join), setError(null))} style={{ justifySelf: "start", background: "none", border: "none", color: "hsl(var(--accent))", cursor: "pointer", padding: 0 }}>
              {join ? t("e2ee.guide.newKey") : t("e2ee.guide.haveKey")}
            </button>
          </>
        )}

        {step === "done" && (
          <>
            <div role="status" style={{ fontSize: 15 }}>
              {t("e2ee.guide.done")}
            </div>
            <ul aria-label={t("e2ee.guide.statusTitle")} style={{ margin: 0, paddingInlineStart: 18, fontSize: 14 }} data-testid="sync-setup-counts">
              {STATE_ORDER.filter((st) => counts.get(st)).map((st) => (
                <li key={st}>
                  {t(`e2ee.state.${st}`)}: {counts.get(st)}
                </li>
              ))}
            </ul>
            {attention.length > 0 && (
              <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 13 }} data-testid="sync-setup-files">
                {attention.map(([path, f]) => (
                  <li key={path} dir="auto">
                    {path} — {t(`e2ee.state.${f.state}`)}
                  </li>
                ))}
              </ul>
            )}
            <div style={muted}>{t("e2ee.guide.secondDevice")}</div>
            <button type="button" style={big} onClick={onClose}>
              {t("e2ee.guide.finish")}
            </button>
          </>
        )}

        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}
      </div>
    </div>
  );
}
