/**
 * The sync panel (plan 3.5): choose where the encrypted vault lives
 * (WebDAV, S3-compatible, Dropbox, Google Drive), connect, create or unlock
 * the vault, sync, and move plain-text notes an earlier Lumen left at
 * Dropbox / Drive into the vault. Lazy: opened from the command palette.
 * Plan W2.19: or keep it on the local network only, paired device to device.
 */

import { useEffect, useState, useSyncExternalStore, type FormEvent } from "react";
import { t } from "../../../i18n";
import "../strings";
import { PassphraseForm } from "./PassphraseForm";
import { FreshnessBanner } from "./FreshnessBanner";
import { SyncActivity } from "./SyncActivity";
import { SyncRulesForm } from "./SyncRulesForm";
import { e2eeErrorText, e2eeResultNotices } from "./errorText";
import { syncSession, type SyncSession } from "./session";
import { ProviderAuthError, ProviderUnreachableError, ProviderUnsupportedError } from "../providers/http";
import { defaultSettings, hasProviderSecret, legacyStore, oauthAvailable, PROVIDER_KINDS, providerCapabilities, providerHosts, SECRET_NAMES, type ProviderKind, type ProviderSettings } from "../providers";
import { LanHostPairing, LanJoin, describeLanError } from "./LanPairing";
import { LanAuthError } from "../lan/rpc";
import { LanLinkError } from "../lan/link";
import { LanNoVaultError, LanNotConnectedError } from "../lan";
import { loadMigrationRecord, migratePlaintext, planPlaintextMigration, revertPlaintextMigration, type MigrationPlan, type MigrationRecord } from "../providers/migrate";
import { HelpButton } from "../../../ui/HelpButton";
import { explainError } from "../../../lib/userError";

const NAMES: Record<ProviderKind, string> = { webdav: "WebDAV", s3: "S3", dropbox: "Dropbox", gdrive: "Google Drive", lan: "LAN", folder: "📁", relay: "Lumen relay" };
const PENDING_OAUTH = "lumen-sync-pending-oauth";

const field: React.CSSProperties = {
  width: "100%",
  padding: "6px 8px",
  border: "1px solid hsl(var(--border))",
  borderRadius: 6,
  background: "transparent",
  color: "inherit",
  font: "inherit",
};
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const errorStyle: React.CSSProperties = { fontSize: 12, color: "hsl(var(--danger))" };
const primary: React.CSSProperties = { padding: "6px 14px", border: "none", borderRadius: 6, background: "hsl(var(--accent))", color: "hsl(var(--accent-fg))", cursor: "pointer", justifySelf: "start" };

/** A human message for a failed connection (never the error's own text: explainError). */
export function describeConnectError(e: unknown, settings: ProviderSettings): string {
  if (e instanceof LanLinkError || e instanceof LanNoVaultError || e instanceof LanNotConnectedError || e instanceof LanAuthError) return describeLanError(e);
  if (e instanceof ProviderAuthError) return t("e2ee.sync.auth");
  if (e instanceof ProviderUnsupportedError) return t("e2ee.sync.unsupported", { detail: e.message });
  // fetch() rejects (a TypeError) when CORS or the page's CSP stops the request.
  if (e instanceof ProviderUnreachableError || e instanceof TypeError) return t("e2ee.sync.cors", { host: providerHosts(settings)[0] ?? "?" });
  return explainError(e, "sync");
}

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <label style={{ display: "grid", gap: 4, fontSize: 13 }}>
      {label}
      {children}
    </label>
  );
}

function ProviderForm({ session, initial, onDone }: { session: SyncSession; initial: ProviderSettings | null; onDone: () => void }) {
  const [settings, setSettings] = useState<ProviderSettings>(initial ?? defaultSettings("webdav"));
  const [secret, setSecret] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const kind = settings.kind;
  const secretName = SECRET_NAMES[kind];
  const haveSecret = hasProviderSecret(kind);
  const oauth = kind === "dropbox" || kind === "gdrive";
  const patch = (p: Partial<ProviderSettings>) => setSettings((s) => ({ ...s, ...p }) as ProviderSettings);

  async function submit(e: FormEvent) {
    e.preventDefault();
    setError(null);
    if (oauth && !haveSecret) {
      // The sign-in leaves the page; the panel reopens and connects on return.
      try {
        sessionStorage.setItem(PENDING_OAUTH, JSON.stringify(settings));
      } catch {
        /* why: private mode: the user connects again after signing in */
      }
      await legacyStore(kind)!.connect();
      return;
    }
    setBusy(true);
    try {
      await session.connect(settings, secretName ? (secret || (haveSecret ? null : "")) : null);
      onDone();
    } catch (err) {
      setError(describeConnectError(err, settings));
    } finally {
      setBusy(false);
    }
  }

  return (
    <div style={{ display: "grid", gap: 10 }}>
      <form onSubmit={submit} style={{ display: "grid", gap: 10 }} aria-label={t("e2ee.sync.provider")}>
        <fieldset style={{ display: "grid", gap: 6, border: "none", padding: 0, margin: 0 }}>
          <legend style={{ fontWeight: 600, marginBottom: 4 }}>{t("e2ee.sync.provider")}</legend>
          {PROVIDER_KINDS.map((k) => {
            const available = oauthAvailable(k);
            return (
              <label key={k} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13, opacity: available ? 1 : 0.6 }}>
                <input
                  type="radio"
                  name="sync-provider"
                  value={k}
                  checked={kind === k}
                  disabled={!available}
                  onChange={() => {
                    setSettings(initial?.kind === k ? initial : defaultSettings(k));
                    setSecret("");
                    setError(null);
                  }}
                />
                <span>
                  {k === "webdav" ? t("e2ee.sync.kind.webdav") : k === "s3" ? t("e2ee.sync.kind.s3") : k === "lan" ? t("e2ee.sync.kind.lan") : NAMES[k]}
                  {!available && <span style={{ ...muted, display: "block" }}>{t("e2ee.sync.oauthMissing", { name: NAMES[k] })}</span>}
                </span>
              </label>
            );
          })}
        </fieldset>

        {settings.kind === "webdav" && (
          <>
            <Field label={t("e2ee.sync.url")}>
              <input dir="ltr" type="url" required placeholder="https://cloud.example.com/remote.php/dav/files/me/Lumen/" value={settings.url} onChange={(e) => patch({ url: e.target.value })} style={field} />
            </Field>
            <Field label={t("e2ee.sync.username")}>
              <input dir="ltr" autoComplete="username" value={settings.username} onChange={(e) => patch({ username: e.target.value })} style={field} />
            </Field>
          </>
        )}
        {settings.kind === "s3" && (
          <>
            <Field label={t("e2ee.sync.endpoint")}>
              <input dir="ltr" type="url" required placeholder="https://s3.eu-central-1.amazonaws.com" value={settings.endpoint} onChange={(e) => patch({ endpoint: e.target.value })} style={field} />
            </Field>
            <Field label={t("e2ee.sync.region")}>
              <input dir="ltr" required value={settings.region} onChange={(e) => patch({ region: e.target.value })} style={field} />
            </Field>
            <Field label={t("e2ee.sync.bucket")}>
              <input dir="ltr" required value={settings.bucket} onChange={(e) => patch({ bucket: e.target.value })} style={field} />
            </Field>
            <Field label={t("e2ee.sync.prefix")}>
              <input dir="ltr" value={settings.prefix} onChange={(e) => patch({ prefix: e.target.value })} style={field} />
            </Field>
            <Field label={t("e2ee.sync.accessKey")}>
              <input dir="ltr" required autoComplete="off" value={settings.accessKeyId} onChange={(e) => patch({ accessKeyId: e.target.value })} style={field} />
            </Field>
            <label style={{ display: "flex", gap: 8, fontSize: 13 }}>
              <input type="checkbox" checked={settings.pathStyle} onChange={(e) => patch({ pathStyle: e.target.checked })} />
              {t("e2ee.sync.pathStyle")}
            </label>
          </>
        )}
        {settings.kind === "lan" && (
          <fieldset style={{ display: "grid", gap: 6, border: "none", padding: 0, margin: 0 }}>
            <legend style={{ fontSize: 13, marginBottom: 4 }}>{t("e2ee.lan.role")}</legend>
            {(["host", "peer"] as const).map((role) => (
              <label key={role} style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13 }}>
                <input type="radio" name="lan-role" value={role} checked={settings.role === role} onChange={() => patch({ role })} />
                {t(`e2ee.lan.role.${role}`)}
              </label>
            ))}
            <div style={muted}>{t("e2ee.lan.note")}</div>
          </fieldset>
        )}
        {secretName && (
          <Field label={t(kind === "s3" ? "e2ee.sync.secretKey" : "e2ee.sync.password")}>
            <input
              dir="ltr"
              type="password"
              autoComplete={kind === "webdav" ? "current-password" : "off"}
              placeholder={haveSecret ? t("e2ee.sync.keepSecret") : ""}
              value={secret}
              onChange={(e) => setSecret(e.target.value)}
              style={field}
            />
          </Field>
        )}
        {error && (
          <div role="alert" style={errorStyle}>
            {error}
          </div>
        )}
        {!(settings.kind === "lan" && settings.role === "peer") && (
          <button type="submit" disabled={busy || !oauthAvailable(kind)} style={primary}>
            {busy ? t("e2ee.sync.connecting") : oauth && !haveSecret ? t("e2ee.sync.signIn", { name: NAMES[kind] }) : t("e2ee.sync.connect")}
          </button>
        )}
      </form>
      {settings.kind === "lan" && settings.role === "peer" && (
        <LanJoin
          onLinked={async () => {
            try {
              await session.connect(settings, null);
              onDone();
            } catch (err) {
              setError(describeConnectError(err, settings));
            }
          }}
        />
      )}
    </div>
  );
}

function Migration({ session, kind }: { session: SyncSession; kind: ProviderKind }) {
  const store = legacyStore(kind);
  const [plan, setPlan] = useState<MigrationPlan | null>(null);
  const [record, setRecord] = useState<MigrationRecord | null>(null);
  const [progress, setProgress] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!store) return;
    let live = true;
    void (async () => {
      const files = await session.localFiles();
      const [p, r] = await Promise.all([planPlaintextMigration(store, files), loadMigrationRecord(store.name)]);
      if (live) (setPlan(p), setRecord(r));
    })().catch((e) => live && setError(explainError(e)));
    return () => {
      live = false;
    };
  }, [store, session]);

  if (!store || (!plan?.files.length && !record)) return null;
  const name = NAMES[kind];

  async function run() {
    setError(null);
    try {
      const files = await session.localFiles();
      const r = await migratePlaintext(store!, files, { onProgress: (d, n) => setProgress(`${d}/${n}`) });
      setRecord(r);
      setPlan({ files: [], clashes: [] });
      setMessage(t("e2ee.sync.migrate.done", { n: r.moved.length, folder: r.backupFolder, name }));
      await session.syncNow().catch(() => undefined);
    } catch (e) {
      setError(explainError(e));
    } finally {
      setProgress(null);
    }
  }

  async function revert() {
    setError(null);
    try {
      const n = await revertPlaintextMigration(store!);
      setRecord(null);
      setMessage(t("e2ee.sync.migrate.reverted", { n }));
    } catch (e) {
      setError(explainError(e));
    }
  }

  return (
    <section style={{ display: "grid", gap: 8, paddingTop: 10, borderTop: "1px solid hsl(var(--border))" }} aria-label={t("e2ee.sync.migrate.title")}>
      <div style={{ fontWeight: 600 }}>{t("e2ee.sync.migrate.title")}</div>
      {plan && plan.files.length > 0 && (
        <>
          <div style={{ fontSize: 13 }}>{t("e2ee.sync.migrate.found", { n: plan.files.length, name })}</div>
          {plan.clashes.length > 0 && <div style={muted}>{t("e2ee.sync.migrate.clashes", { n: plan.clashes.length })}</div>}
          <button type="button" onClick={run} disabled={progress !== null} style={primary}>
            {progress ?? t("e2ee.sync.migrate.run")}
          </button>
        </>
      )}
      {message && (
        <div role="status" style={{ fontSize: 13 }}>
          {message}
        </div>
      )}
      {record?.finishedAt && (
        <button type="button" onClick={revert} style={{ justifySelf: "start" }}>
          {t("e2ee.sync.migrate.revert")}
        </button>
      )}
      {error && (
        <div role="alert" style={errorStyle}>
          {error}
        </div>
      )}
    </section>
  );
}

function Unlocked({ session }: { session: SyncSession }) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const engine = session.engine();
  const [code, setCode] = useState<string | null>(null);
  const [request, setRequest] = useState("");
  const [answer, setAnswer] = useState<string | null>(null);
  const [pairError, setPairError] = useState<string | null>(null);
  const [cancelled, setCancelled] = useState(false);
  const last = s.last;
  // I3: an answer or a code holds this device's key changes back for minutes; the user can call it off.
  const cancelPairing = () => {
    if (!engine) return;
    void engine.cancelPairing().then(() => {
      setAnswer(null);
      setCode(null);
      setCancelled(true);
    });
  };
  const answerRequest = () => {
    if (!engine) return;
    setPairError(null);
    setAnswer(null);
    setCancelled(false);
    void engine.answerPairing(request).then(setAnswer, (e) => setPairError(e2eeErrorText(e, "answer", explainError)));
  };
  return (
    <div style={{ display: "grid", gap: 10 }}>
      {engine && <FreshnessBanner sync={engine} />}
      <div style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
        <button type="button" onClick={() => void session.syncNow().catch(() => undefined)} disabled={s.syncing} style={primary}>
          {s.syncing ? t("e2ee.sync.syncing") : t("e2ee.sync.syncNow")}
        </button>
        <button type="button" onClick={() => session.lock()}>
          {t("e2ee.sync.lock")}
        </button>
      </div>
      {last && s.lastAt && (
        <div role="status" data-testid="sync-result" style={muted}>
          {t("e2ee.sync.result", { time: new Date(s.lastAt).toLocaleTimeString(), up: last.uploaded, down: last.downloaded, deleted: last.deleted })}
          {last.held.length > 0 && <> · {t("e2ee.sync.held", { n: last.held.length })}</>}
        </div>
      )}
      {last &&
        e2eeResultNotices(last).map((n) => (
          <div key={n} role="alert" style={errorStyle} data-testid="sync-notice">
            {n}
          </div>
        ))}
      {s.error && (
        <div role="alert" style={errorStyle}>
          {s.error}
        </div>
      )}
      {s.notice && (
        <div role="status" data-testid="sync-notice" style={{ display: "flex", gap: 8, alignItems: "baseline", fontSize: 13, padding: "6px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6 }}>
          <span style={{ flex: 1 }}>{t(s.notice.key, { minutes: s.notice.minutes })}</span>
          <button type="button" onClick={() => session.dismissNotice()}>
            {t("e2ee.bg.dismiss")}
          </button>
        </div>
      )}
      <SyncActivity session={session} />
      <SyncRulesForm session={session} />
      {s.settings &&
        providerCapabilities(s.settings.kind).limits.map((key) => (
          <div key={key} style={muted} data-testid="provider-limit">
            {t(key)}
          </div>
        ))}
      {engine && (
        <div style={{ display: "grid", gap: 4 }}>
          <Field label={t("e2ee.pair.answerTitle")}>
            <textarea value={request} onChange={(e) => setRequest(e.target.value)} dir="ltr" rows={2} spellCheck={false} style={{ ...field, fontFamily: "JetBrains Mono, ui-monospace, monospace", fontSize: 12 }} />
          </Field>
          <div style={muted}>{t("e2ee.pair.answerHint")}</div>
          <button type="button" style={{ justifySelf: "start" }} disabled={!request.trim()} onClick={answerRequest}>
            {t("e2ee.pair.answer")}
          </button>
          {answer && (
            <code dir="ltr" data-testid="pair-answer" style={{ userSelect: "all", wordBreak: "break-all", fontSize: 12 }}>
              {answer}
            </code>
          )}
          {pairError && (
            <div role="alert" style={errorStyle}>
              {pairError}
            </div>
          )}
        </div>
      )}
      {engine && (
        <div style={{ display: "grid", gap: 4 }}>
          <button
            type="button"
            style={{ justifySelf: "start" }}
            onClick={() =>
              void engine.pairingCode().then(
                (c) => {
                  setCode(c);
                  setCancelled(false);
                },
                (e) => setCode(e2eeErrorText(e, "other", explainError)),
              )
            }
          >
            {t("e2ee.sync.pairCode")}
          </button>
          {code && (
            <>
              <code dir="ltr" style={{ userSelect: "all", wordBreak: "break-all", fontSize: 12 }}>
                {code}
              </code>
              <div style={muted}>{t("e2ee.sync.pairCodeNote")}</div>
            </>
          )}
          {(answer || code) && (
            <button type="button" style={{ justifySelf: "start" }} onClick={cancelPairing}>
              {t("e2ee.pair.cancel")}
            </button>
          )}
          {cancelled && (
            <div role="status" style={muted}>
              {t("e2ee.pair.cancelled")}
            </div>
          )}
        </div>
      )}
      {s.settings?.kind === "lan" && s.settings.role === "host" && <LanHostPairing />}
      {s.settings && <Migration session={session} kind={s.settings.kind} />}
    </div>
  );
}

export function SyncPanel({ onClose, session = syncSession() }: { onClose: () => void; session?: SyncSession }) {
  const s = useSyncExternalStore(session.subscribe, session.get);
  const [saved, setSaved] = useState<ProviderSettings | null | undefined>(undefined);
  const [choosing, setChoosing] = useState(false);

  useEffect(() => {
    void session.saved().then(setSaved, () => setSaved(null));
  }, [session]);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const where = !s.settings ? "" : s.settings.kind === "lan" ? t(`e2ee.lan.where.${s.settings.role}`) : s.settings.kind === "folder" ? `${NAMES.folder} ${s.settings.name}` : `${NAMES[s.settings.kind]} — ${providerHosts(s.settings)[0] ?? ""}`;

  return (
    <div style={{ position: "fixed", inset: 0, background: "var(--overlay)", display: "grid", placeItems: "center", zIndex: 1000 }} onMouseDown={(e) => e.target === e.currentTarget && onClose()}>
      <div
        role="dialog"
        aria-modal="true"
        aria-labelledby="sync-panel-title"
        style={{ width: "min(520px, calc(100vw - 32px))", maxHeight: "calc(100vh - 32px)", overflow: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border))", borderRadius: 10, padding: 18, display: "grid", gap: 14 }}
      >
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <h2 id="sync-panel-title" style={{ margin: 0, fontSize: 16 }}>
            {t("e2ee.sync.title")}
          </h2>
          <HelpButton topic="sync/e2ee" />
          <button type="button" aria-label={t("e2ee.sync.close")} onClick={onClose} style={{ background: "none", border: "none", color: "inherit", cursor: "pointer", fontSize: 18 }}>
            ×
          </button>
        </div>

        {s.phase === "disconnected" && s.error && (
          <div role="alert" style={errorStyle}>
            {s.error}
          </div>
        )}
        {(s.phase === "disconnected" || choosing) && saved !== undefined && <ProviderForm session={session} initial={s.settings ?? saved} key={choosing ? "again" : "first"} onDone={() => setChoosing(false)} />}

        {s.phase !== "disconnected" && !choosing && (
          <>
            <div style={{ display: "flex", justifyContent: "space-between", gap: 8, flexWrap: "wrap", fontSize: 13 }}>
              <span dir="auto">{t("e2ee.sync.connectedTo", { where })}</span>
              <span style={{ display: "flex", gap: 8 }}>
                <button type="button" onClick={() => setChoosing(true)}>
                  {t("e2ee.sync.choose")}
                </button>
                <button type="button" onClick={() => void session.disconnect()} title={t("e2ee.sync.disconnectNote")}>
                  {t("e2ee.sync.disconnect")}
                </button>
              </span>
            </div>
            {s.phase === "connected" && (
              <>
                <div style={muted}>{t(s.vaultExists ? "e2ee.sync.existingVault" : "e2ee.sync.newVault")}</div>
                <PassphraseForm mode={s.vaultExists ? "unlock" : "create"} onSubmit={async (pass) => void (await session.open(pass))} />
                {/* Before the first round: what this device leaves out (plan W1.8). */}
                <SyncRulesForm session={session} />
              </>
            )}
            {s.phase === "unlocked" && <Unlocked session={session} />}
          </>
        )}
        {choosing && s.phase !== "disconnected" && (
          <button type="button" onClick={() => setChoosing(false)} style={{ justifySelf: "start" }}>
            {t("e2ee.sync.back")}
          </button>
        )}
      </div>
    </div>
  );
}

/** After an OAuth sign-in returns: the provider the user chose before leaving. */
export function takePendingOAuth(): ProviderSettings | null {
  try {
    const raw = sessionStorage.getItem(PENDING_OAUTH);
    sessionStorage.removeItem(PENDING_OAUTH);
    return raw ? (JSON.parse(raw) as ProviderSettings) : null;
  } catch {
    return null;
  }
}
