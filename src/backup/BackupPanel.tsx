/**
 * Backups (plan W1.6): choose a second drive or folder, plain or encrypted,
 * back up now, see when the last backup worked or failed, and restore a
 * file, a folder or the whole vault into a new folder. Opened from the
 * command palette on its own root; lazy.
 */

import { useEffect, useState, useSyncExternalStore } from "react";
import { createRoot } from "react-dom/client";
import { t, getLocale } from "../i18n";
import "./strings";
import { getVaultBackend } from "../storage/vault";
import { createFolderBackend, ensureFolderPermission, pickVaultFolder, vaultFolderHandle } from "../storage/vault/location";
import { generateIdentity } from "../sync/e2ee/age";
import { listBackups, restore, targetInsideVault } from "./backup";
import { loadBackupConfig, saveBackupConfig, type BackupConfig } from "./config";
import { backupHealth, backupStatus, subscribeBackupStatus } from "./status";
import { startBackups, targetFor } from "./start";
import { HelpButton } from "../ui/HelpButton";

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))", margin: 0 };
const field: React.CSSProperties = { padding: "5px 8px", border: "1px solid hsl(var(--border))", borderRadius: 6, background: "transparent", color: "inherit", font: "inherit", fontSize: 13 };
const when = (ms: number | null) => (ms === null ? "—" : new Date(ms).toLocaleString(getLocale()));

function Status() {
  const s = useSyncExternalStore(subscribeBackupStatus, backupStatus, backupStatus);
  const health = backupHealth(s);
  const days = s.lastSuccessAt ? Math.floor((Date.now() - s.lastSuccessAt) / 86_400_000) : 0;
  const text =
    health === "failed"
      ? t("backup.status.failed", { time: when(s.lastFailureAt), error: s.lastError ?? "" })
      : health === "stale"
        ? t("backup.status.stale", { days })
        : health === "never"
          ? t("backup.status.never")
          : t("backup.status.ok", { time: when(s.lastSuccessAt) });
  return (
    <p role={health === "failed" ? "alert" : "status"} data-testid="backup-status" data-health={health} style={{ ...muted, color: health === "failed" ? "hsl(var(--danger))" : undefined }}>
      {s.running ? t("backup.running") : text}
    </p>
  );
}

function Panel({ onClose }: { onClose: () => void }) {
  const [config, setConfig] = useState<BackupConfig | null | undefined>(undefined);
  const [key, setKey] = useState<{ identity: string; recipient: string } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [message, setMessage] = useState<string | null>(null);
  const [backups, setBackups] = useState<Array<{ name: string; at: number; encrypted: boolean }>>([]);
  const [path, setPath] = useState("");
  const [identity, setIdentity] = useState("");

  const refresh = async (c: BackupConfig | null) => {
    setBackups(c ? await listBackups(await targetFor(c)).catch(() => []) : []);
  };
  useEffect(() => {
    void loadBackupConfig().then((c) => {
      setConfig(c);
      void refresh(c);
    });
    const onKey = (e: KeyboardEvent) => e.key === "Escape" && onClose();
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  const fail = (e: unknown) => setError(String((e as Error)?.message ?? e));

  async function choose(encrypted: boolean) {
    setError(null);
    const handle = await pickVaultFolder();
    if (!handle) return;
    if (await targetInsideVault(await vaultFolderHandle(), handle)) return setError(t("backup.insideVault"));
    let mode: BackupConfig["mode"] = { kind: "plain" };
    if (encrypted) {
      const id = await generateIdentity();
      setKey(id);
      mode = { kind: "age", recipient: id.recipient };
    }
    const c: BackupConfig = { kind: "folder", handle, label: handle.name, mode };
    await saveBackupConfig(c);
    setConfig(c);
    startBackups();
    void refresh(c);
  }

  async function backupNow() {
    setError(null);
    if (config) await ensureFolderPermission(config.handle, true);
    await startBackups()
      .backupNow()
      .catch(fail);
    void refresh(config ?? null);
  }

  async function restoreInto(select: { all: true } | { file: string } | { folder: string }, into: "vault" | "folder") {
    setError(null);
    setMessage(null);
    if (!config || backups.length === 0) return;
    try {
      const target = await targetFor(config);
      const newest = backups[0];
      let dest = getVaultBackend();
      if (into === "folder") {
        const h = await pickVaultFolder();
        if (!h) return;
        dest = createFolderBackend(h);
      }
      const r = await restore({ target, name: newest.name, identity: newest.encrypted ? identity.trim() : undefined, into: dest, select });
      setMessage(r.renamed.length ? t("backup.restoredKept", { n: r.restored.length, m: r.renamed.length }) : t("backup.restored", { n: r.restored.length }));
    } catch (e) {
      fail(e);
    }
  }

  return (
    <div className="cmd-palette-backdrop" onClick={onClose} role="dialog" aria-modal="true" aria-label={t("backup.title")}>
      <div className="cmd-palette" onClick={(e) => e.stopPropagation()} style={{ maxWidth: 560, padding: 16, display: "grid", gap: 12 }}>
        <div style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
          <strong>{t("backup.title")}</strong>
          <HelpButton topic="workspace/backups" />
          <button type="button" onClick={onClose} aria-label={t("backup.close")}>
            ×
          </button>
        </div>
        <p style={muted}>{t("backup.intro")}</p>
        <Status />
        {config === undefined ? null : (
          <>
            <div style={{ fontSize: 13 }}>
              {config ? (
                <bdi dir="auto">{t("backup.target", { name: config.label, mode: t(`backup.mode.${config.mode.kind}`) })}</bdi>
              ) : (
                // empty-action: the two "choose a drive" buttons right below
                t("backup.none")
              )}
            </div>
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => void choose(false).catch(fail)}>
                {t("backup.choose.plain")}
              </button>
              <button type="button" onClick={() => void choose(true).catch(fail)}>
                {t("backup.choose.age")}
              </button>
              {config && (
                <button type="button" onClick={() => void backupNow()} data-testid="backup-now">
                  {t("backup.now")}
                </button>
              )}
            </div>
          </>
        )}
        {key && (
          <div style={{ display: "grid", gap: 4 }}>
            <strong style={{ fontSize: 13 }}>{t("backup.key.title")}</strong>
            <code dir="ltr" style={{ userSelect: "all", wordBreak: "break-all", fontSize: 11 }}>
              {key.identity}
            </code>
            <p style={muted}>{t("backup.key.note")}</p>
          </div>
        )}
        {backups.length > 0 && (
          <section style={{ display: "grid", gap: 6 }} aria-label={t("backup.list")}>
            <strong style={{ fontSize: 13 }}>{t("backup.list")}</strong>
            <ul style={{ margin: 0, paddingInlineStart: 18, fontSize: 12 }} data-testid="backup-list">
              {backups.slice(0, 17).map((b) => (
                <li key={b.name}>
                  <bdi dir="ltr">{when(b.at)}</bdi>
                  {b.encrypted ? " 🔒" : ""}
                </li>
              ))}
            </ul>
            {backups[0].encrypted && (
              <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
                {t("backup.keyPrompt")}
                <input dir="ltr" value={identity} onChange={(e) => setIdentity(e.target.value)} style={field} autoComplete="off" />
              </label>
            )}
            <div style={{ display: "flex", gap: 8, flexWrap: "wrap" }}>
              <button type="button" onClick={() => void restoreInto({ all: true }, "folder")}>
                {t("backup.restoreAll")}
              </button>
            </div>
            <label style={{ display: "grid", gap: 4, fontSize: 12 }}>
              {t("backup.restorePath")}
              <input dir="auto" value={path} onChange={(e) => setPath(e.target.value)} style={field} />
            </label>
            <button type="button" disabled={!path.trim()} style={{ justifySelf: "start" }} onClick={() => void restoreInto(/\.[^/]+$/.test(path.trim()) ? { file: path.trim() } : { folder: path.trim() }, "vault")}>
              {t("backup.restoreFile")}
            </button>
          </section>
        )}
        {message && (
          <p role="status" style={muted}>
            {message}
          </p>
        )}
        {error && (
          <p role="alert" style={{ ...muted, color: "hsl(var(--danger))" }}>
            {error}
          </p>
        )}
      </div>
    </div>
  );
}

let root: ReturnType<typeof createRoot> | null = null;
let host: HTMLDivElement | null = null;

export function openBackupPanel(): void {
  if (!host) {
    host = document.createElement("div");
    document.body.appendChild(host);
    root = createRoot(host);
  }
  const close = () => root?.render(null);
  root!.render(<Panel onClose={close} />);
}
