/**
 * The gallery's sandboxed plugins (plan W1.20): each listed version with
 * its safety card from the registry scan (public/plugins/examples/scan.json);
 * versions that failed are not shown. Install opens the permission screen,
 * which scans the version again before anything is granted, and refuses
 * code that is not byte for byte the code the registry scanned (W4.32).
 * An installed plugin can be removed here, with what it stored.
 */
import { lazy, Suspense, useEffect, useState } from "react";
import { t } from "../../i18n";
import { fetchWithRetry } from "../../lib/fetchRetry";
import { showAiToast } from "../../ui/AiToast";
import { describeFindings, reportUrl } from "./permissions";
import { InstallDialog } from "./InstallDialog";
import type { PluginManifest } from "./manifest";
import type { ScanResult } from "./scan";
import "./devStrings";
import { explainError } from "../../lib/userError";

const DevPanel = lazy(() => import("./DevPanel").then((m) => ({ default: m.DevPanel })));

const BASE = "/plugins/examples";

interface Listed {
  manifest: PluginManifest;
  scan: ScanResult;
  path: string;
}

async function getJson<T>(url: string, signal: AbortSignal): Promise<T> {
  // privacy-ledger: not tracked — the app's own files: every caller passes a path under BASE (/plugins/examples, this origin).
  const res = await fetchWithRetry(url, { signal }, { label: "plugins.sandboxed", maxRetries: 1, baseDelayMs: 300, maxDelayMs: 1000 });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return (await res.json()) as T;
}

/** The registry's versions that passed their scan, newest last per plugin. */
async function loadListed(signal: AbortSignal): Promise<Listed[]> {
  const [index, scans] = await Promise.all([
    getJson<{ plugins: Array<{ id: string; versions: Array<{ version: string; path: string }> }> }>(`${BASE}/index.json`, signal),
    getJson<{ results: Array<ScanResult & { path: string }> }>(`${BASE}/scan.json`, signal),
  ]);
  const { parseManifest } = await import("./manifest");
  const out: Listed[] = [];
  for (const p of index.plugins) {
    const ok = p.versions.map((v) => ({ v, scan: scans.results.find((r) => r.id === p.id && r.version === v.version) ?? null })).filter((x) => x.scan?.passed);
    const latest = ok[ok.length - 1];
    if (!latest?.scan) continue;
    const manifest = parseManifest(await getJson<unknown>(`${BASE}/${latest.v.path}/lumen-plugin.json`, signal));
    out.push({ manifest, scan: latest.scan, path: latest.v.path });
  }
  return out;
}

export function SandboxedPlugins() {
  const [items, setItems] = useState<Listed[] | null>(null);
  const [failed, setFailed] = useState(false);
  const [asking, setAsking] = useState<Listed | null>(null);
  const [busy, setBusy] = useState(false);
  const [devOpen, setDevOpen] = useState(false);
  const [installed, setInstalled] = useState<ReadonlySet<string>>(new Set());

  useEffect(() => {
    const ac = new AbortController();
    loadListed(ac.signal).then(setItems, () => {
      if (!ac.signal.aborted) setFailed(true);
    });
    return () => ac.abort();
  }, []);

  // Plugins already running (installed earlier in this session) show "Remove".
  useEffect(() => {
    let live = true;
    import("./manager").then(
      (m) => {
        if (live) setInstalled(new Set(m.runningPlugins().map((p) => p.id)));
      },
      () => undefined, // why: without the runtime nothing is installed; the cards show "Install"
    );
    return () => {
      live = false;
    };
  }, []);

  async function install(item: Listed): Promise<void> {
    setBusy(true);
    try {
      // privacy-ledger: not tracked — the app's own files (/plugins/examples, this origin).
      const code = await (await fetch(`${BASE}/${item.path}/${item.manifest.main}`)).text();
      const [{ scanPluginVersion }, { startPlugin }] = await Promise.all([import("./scan"), import("./manager")]);
      // The bytes about to run are scanned again: the card is about the registry copy.
      const scan = await scanPluginVersion({ manifest: item.manifest, main: code });
      if (!scan.passed) {
        showAiToast(t("pluginTrust.scanFailed", { name: item.manifest.name }), "error");
        return;
      }
      if (scan.sha256 !== item.scan.sha256) {
        showAiToast(t("pluginTrust.changed", { name: item.manifest.name }), "error");
        return;
      }
      await startPlugin({ manifest: item.manifest, code, grants: new Set(item.manifest.capabilities.map((c) => c.id)) });
      showAiToast(t("pluginTrust.installed", { name: item.manifest.name }), "success");
      setInstalled((cur) => new Set([...cur, item.manifest.id]));
      setAsking(null);
    } catch (e) {
      showAiToast(t("pluginTrust.installFailed", { name: item.manifest.name, error: explainError(e) }), "error");
    } finally {
      setBusy(false);
    }
  }

  async function remove(item: Listed): Promise<void> {
    setBusy(true);
    try {
      const { stopPlugin, clearPluginData } = await import("./manager");
      await stopPlugin(item.manifest.id);
      await clearPluginData(item.manifest.id);
      setInstalled((cur) => new Set([...cur].filter((id) => id !== item.manifest.id)));
      showAiToast(t("pluginTrust.removed", { name: item.manifest.name }), "success");
    } finally {
      setBusy(false);
    }
  }

  return (
    <section aria-labelledby="sandboxed-plugins-title" data-testid="sandboxed-plugins" style={{ padding: "12px 20px", borderTop: "1px solid hsl(var(--border))" }}>
      <h3 id="sandboxed-plugins-title" style={{ margin: "0 0 4px", fontSize: 15 }}>
        {t("pluginTrust.section.title")}
      </h3>
      <p style={{ margin: "0 0 10px", fontSize: 12, color: "hsl(var(--fg-muted))" }}>{t("pluginTrust.section.about")}</p>
      {failed ? (
        <p style={{ fontSize: 12 }}>{t("pluginTrust.loadFailed")}</p>
      ) : !items ? (
        <p style={{ fontSize: 12 }}>{t("pluginTrust.loading")}</p>
      ) : (
        <div style={{ display: "grid", gap: 10, gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))" }}>
          {items.map((it) => (
            <div key={it.manifest.id} data-testid="sandboxed-plugin-card" data-plugin={it.manifest.id} style={{ border: "1px solid hsl(var(--border))", borderRadius: 10, padding: 12, display: "grid", gap: 6 }}>
              <strong style={{ fontSize: 14 }}>{it.manifest.name}</strong>
              <span style={{ fontSize: 12, color: "hsl(var(--fg-muted))" }}>{it.manifest.description}</span>
              <span data-testid="safety-card" style={{ fontSize: 12 }}>
                {t("pluginTrust.card.grade", { grade: it.scan.grade, score: it.scan.score })} · {t("pluginTrust.card.perms", { n: it.manifest.capabilities.length })}
              </span>
              <span style={{ fontSize: 11, color: "hsl(var(--fg-muted))" }}>{it.scan.findings.length ? t("pluginTrust.card.notes", { list: describeFindings(it.scan.findings) }) : t("pluginTrust.card.clean")}</span>
              <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
                {installed.has(it.manifest.id) ? (
                  <>
                    <span data-testid="plugin-installed" style={{ fontSize: 12 }}>
                      {t("pluginTrust.installedBadge")}
                    </span>
                    <button type="button" className="btn" disabled={busy} onClick={() => void remove(it)}>
                      {t("pluginTrust.remove")}
                    </button>
                  </>
                ) : (
                  <button type="button" className="btn btn-primary" onClick={() => setAsking(it)}>
                    {t("pluginTrust.install")}
                  </button>
                )}
                <a href={reportUrl(it.manifest.id, it.manifest.version)} target="_blank" rel="noopener noreferrer" style={{ fontSize: 12, color: "hsl(var(--accent))" }}>
                  {t("pluginTrust.report")}
                </a>
              </div>
            </div>
          ))}
        </div>
      )}
      <details data-testid="plugin-dev" style={{ marginTop: 12 }} onToggle={(e) => setDevOpen((e.currentTarget as HTMLDetailsElement).open)}>
        <summary style={{ fontSize: 13, cursor: "pointer" }}>{t("pluginDev.title")}</summary>
        {devOpen && (
          <Suspense fallback={<p style={{ fontSize: 12 }}>{t("pluginTrust.loading")}</p>}>
            <DevPanel />
          </Suspense>
        )}
      </details>
      {asking && <InstallDialog manifest={asking.manifest} scan={asking.scan} busy={busy} onCancel={() => setAsking(null)} onInstall={() => void install(asking)} />}
    </section>
  );
}
