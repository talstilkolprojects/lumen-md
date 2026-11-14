/**
 * Developer mode (plan W3.10): connect to `npm run dev` of a plugin made by
 * `npx create-lumen-plugin`, reload it on every save, and see what it does:
 * the capabilities it asked for against the ones it used, its last calls
 * to the app, refused calls, CPU time, memory and how long a reload took.
 */
import { useEffect, useRef, useState } from "react";
import { t } from "../../i18n";
import "./devStrings";
import { DEFAULT_DEV_URL, type DevConnection, type DevStatus } from "./devPlugin";
import type { PluginInstance } from "./pluginHost";
import { explainError } from "../../lib/userError";

const STATE_KEY = {
  connecting: "pluginDev.state.connecting",
  running: "pluginDev.state.running",
  error: "pluginDev.state.error",
  closed: "pluginDev.state.closed",
} as const;

function kb(bytes: number): string {
  return bytes >= 1024 * 1024 ? `${(bytes / 1024 / 1024).toFixed(1)} MB` : `${Math.round(bytes / 1024)} KB`;
}

/** Re-render on the instance's activity (calls, stats). */
function useActivity(instance: PluginInstance | null): number {
  const [n, setN] = useState(0);
  useEffect(() => instance?.onActivity(() => setN((x) => x + 1)), [instance]);
  return n;
}

export function DevPanel({ connect }: { connect?: (url: string) => Promise<DevConnection> }) {
  const [url, setUrl] = useState(DEFAULT_DEV_URL);
  const [status, setStatus] = useState<DevStatus | null>(null);
  const [failure, setFailure] = useState<string | null>(null);
  const conn = useRef<DevConnection | null>(null);
  const inst = status?.instance ?? null;
  useActivity(inst);

  useEffect(() => () => void conn.current?.close(), []);

  async function start(): Promise<void> {
    setFailure(null);
    try {
      const c = await (connect ?? (await import("./devPlugin")).connectDevPlugin)(url);
      conn.current = c;
      c.onChange(setStatus);
      setStatus(c.status);
    } catch (e) {
      setFailure(explainError(e));
    }
  }

  async function stop(): Promise<void> {
    await conn.current?.close();
    conn.current = null;
    setStatus(null);
  }

  const used = inst?.capabilityUse ?? new Map<string, number>();
  const asked = status?.manifest?.capabilities.map((c) => c.id) ?? [];
  const extra = [...used.keys()].filter((c) => !asked.includes(c as never));
  const stats = inst?.stats ?? null;
  const denied = new Map<string, number>([...(inst?.denied ?? []), ...Object.entries(stats?.denied ?? {})]);

  return (
    <div data-testid="plugin-dev-panel" style={{ display: "grid", gap: 8, fontSize: 12 }}>
      <p style={{ margin: 0, color: "hsl(var(--fg-muted))" }}>{t("pluginDev.about")}</p>
      <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
        <label htmlFor="plugin-dev-url">{t("pluginDev.url")}</label>
        <input id="plugin-dev-url" dir="ltr" value={url} onChange={(e) => setUrl(e.target.value)} disabled={!!conn.current} style={{ minWidth: 200 }} />
        {conn.current ? (
          <>
            <button type="button" className="btn" onClick={() => void conn.current?.reload()}>
              {t("pluginDev.reload")}
            </button>
            <button type="button" className="btn" onClick={() => void stop()}>
              {t("pluginDev.disconnect")}
            </button>
          </>
        ) : (
          <button type="button" className="btn btn-primary" onClick={() => void start()}>
            {t("pluginDev.connect")}
          </button>
        )}
      </div>
      {failure && (
        <p role="alert" style={{ margin: 0, color: "hsl(var(--danger, 0 70% 50%))" }}>
          {t("pluginDev.failed", { error: failure })}
        </p>
      )}
      {status && (
        <div data-testid="plugin-dev-status" aria-live="polite" style={{ display: "grid", gap: 6 }}>
          <strong>
            {status.manifest ? `${status.manifest.name} ${status.manifest.version}` : status.url} · {t(STATE_KEY[status.state])}
          </strong>
          {status.error && <span role="alert">{status.error}</span>}
          <span data-testid="plugin-dev-reload">
            {t("pluginDev.reloads", { n: status.reloads })}
            {status.lastReloadMs != null && ` · ${t("pluginDev.reloadMs", { ms: status.lastReloadMs })}`}
            {inst?.loadMs != null && ` · ${t("pluginDev.loadMs", { ms: Math.round(inst.loadMs) })}`}
          </span>
          {stats && (
            <span data-testid="plugin-dev-stats">
              {t("pluginDev.cpu", { ms: Math.round(stats.cpuMs), max: Math.round(stats.maxEntryMs), n: stats.entries })} · {t("pluginDev.memory", { size: kb(stats.memoryBytes) })}
            </span>
          )}
          {status.scan && status.scan.findings.length > 0 && <span>{t("pluginDev.scanNotes", { n: status.scan.findings.length, grade: status.scan.grade })}</span>}
          <table data-testid="plugin-dev-caps" style={{ borderCollapse: "collapse" }}>
            <caption style={{ textAlign: "start", fontWeight: 600 }}>{t("pluginDev.caps")}</caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "start" }}>{t("pluginDev.cap")}</th>
                <th scope="col" style={{ textAlign: "end" }}>{t("pluginDev.used")}</th>
                <th scope="col" style={{ textAlign: "end" }}>{t("pluginDev.denied")}</th>
              </tr>
            </thead>
            <tbody>
              {[...asked, ...extra].map((c) => (
                <tr key={c} data-cap={c}>
                  <td dir="ltr" style={{ textAlign: "start" }}>
                    {c}
                    {!asked.includes(c) && ` (${t("pluginDev.notAsked")})`}
                    {asked.includes(c) && !used.get(c) && ` (${t("pluginDev.unused")})`}
                  </td>
                  <td style={{ textAlign: "end" }}>{used.get(c) ?? 0}</td>
                  <td style={{ textAlign: "end" }}>{denied.get(c) ?? 0}</td>
                </tr>
              ))}
            </tbody>
          </table>
          {inst && inst.calls.length > 0 && (
            <details>
              <summary>{t("pluginDev.calls", { n: inst.calls.length })}</summary>
              <ol data-testid="plugin-dev-calls" dir="ltr" style={{ margin: 0, paddingInlineStart: 18, maxHeight: 180, overflow: "auto", fontFamily: "var(--font-mono, monospace)" }}>
                {inst.calls
                  .slice(-50)
                  .reverse()
                  .map((c, i) => (
                    <li key={`${c.at}-${i}`}>
                      {c.method} · {c.outcome} · {c.ms.toFixed(1)} ms
                    </li>
                  ))}
              </ol>
            </details>
          )}
        </div>
      )}
    </div>
  );
}
