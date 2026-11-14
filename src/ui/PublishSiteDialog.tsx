/**
 * "Publish site" (plan 4.18): pick notes, then publish them as your own
 * static website — to GitHub Pages (a commit on a branch of your repository)
 * or as a .zip for any static host. Built by ../publish/site.ts with the
 * editor's own renderer, deployed by ../publish/deploy.ts.
 *
 * Nothing is sent before the user presses Publish, and then only the site's
 * files, only to the repository the user named. Loaded on demand from the
 * palette (`file.publishSite`): `void import("./PublishSiteDialog").then((m) => m.openPublishSite())`.
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Globe, X } from "lucide-react";
import { t, getLocale } from "../i18n";
import type { SiteNote } from "../publish/site";

const SETTINGS_KEY = "lumen.publishSite.v1";
const TOKEN_SECRET = "lumen.publish.github.token";

interface Settings {
  title: string;
  lang: string;
  target: "zip" | "github";
  repo: string;
  branch: string;
  /** Last picked notes (paths); null = all. */
  picked: string[] | null;
}

function loadSettings(): Settings {
  const base: Settings = { title: "My notes", lang: getLocale() === "he" ? "he" : "en", target: "zip", repo: "", branch: "gh-pages", picked: null };
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    return raw ? { ...base, ...(JSON.parse(raw) as Partial<Settings>) } : base;
  } catch {
    // why: storage blocked or corrupt — start from the defaults
    return base;
  }
}

function saveSettings(s: Settings): void {
  try {
    localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
  } catch {
    /* why: storage blocked — the form just won't remember its settings */
  }
}

const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const field: React.CSSProperties = { padding: "6px 8px", fontSize: 13, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg))", color: "inherit" };
const ghost: React.CSSProperties = { padding: "5px 12px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };
const primary: React.CSSProperties = { ...ghost, background: "hsl(var(--accent))", borderColor: "hsl(var(--accent))", color: "hsl(var(--accent-fg, 0 0% 100%))" };
const col: React.CSSProperties = { display: "flex", flexDirection: "column", gap: 4 };

function download(data: Uint8Array, name: string): void {
  const url = URL.createObjectURL(new Blob([data as unknown as BlobPart], { type: "application/zip" }));
  const a = document.createElement("a");
  a.href = url;
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 10_000);
}

export function PublishSiteDialog({ onClose }: { onClose: () => void }) {
  const [notes, setNotes] = useState<SiteNote[] | null>(null);
  const [settings, setSettings] = useState<Settings>(loadSettings);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const [filter, setFilter] = useState("");
  const [token, setToken] = useState("");
  const [busy, setBusy] = useState<string | null>(null);
  const [result, setResult] = useState<{ text: string; url?: string; error?: boolean } | null>(null);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    closeRef.current?.focus();
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.stopPropagation();
        onClose();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      const { readAllNotes } = await import("../storage/workspaceNotes");
      const all = (await readAllNotes()).map((n) => ({ path: n.path, content: n.text })).sort((a, b) => a.path.localeCompare(b.path));
      if (cancelled) return;
      setNotes(all);
      const last = loadSettings().picked;
      setPicked(new Set(last ? all.map((n) => n.path).filter((p) => last.includes(p)) : all.map((n) => n.path)));
      const { getSecret, initSecretStore } = await import("../lib/secretStore");
      await initSecretStore();
      const saved = getSecret(TOKEN_SECRET);
      if (!cancelled && saved) setToken(saved);
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  const shown = useMemo(() => (notes ?? []).filter((n) => !filter || n.path.toLowerCase().includes(filter.toLowerCase())), [notes, filter]);
  const update = (patch: Partial<Settings>) => setSettings((s) => ({ ...s, ...patch }));

  const publish = async () => {
    if (!notes || busy) return;
    const chosen = notes.filter((n) => picked.has(n.path));
    if (!chosen.length) return;
    let repo: { owner: string; repo: string } | null = null;
    let useToken = token.trim();
    const { parseRepo, deployToGitHubPages, siteZip } = await import("../publish/deploy");
    if (settings.target === "github") {
      repo = parseRepo(settings.repo);
      if (!repo) return setResult({ text: t("publish.badRepo"), error: true });
      if (!useToken) {
        const { getGitToken } = await import("../sync/git");
        useToken = await getGitToken();
      }
      if (!useToken) return setResult({ text: t("publish.noToken"), error: true });
    }
    saveSettings({ ...settings, picked: picked.size === notes.length ? null : [...picked] });
    setResult(null);
    try {
      setBusy(t("publish.building", { count: chosen.length }));
      await import("../lib/journalistStrings");
      const [{ buildSite, wordsFor }, { renderHtmlDocument }, { readWorkspaceBlob }] = await Promise.all([
        import("../publish/site"),
        import("../storage/exportHtml"),
        import("../storage/workspace"),
      ]);
      const site = await buildSite(chosen, {
        title: settings.title.trim() || "Notes",
        lang: settings.lang,
        words: wordsFor(settings.lang),
        render: renderHtmlDocument,
        readAsset: async (path) => {
          try {
            return new Uint8Array(await (await readWorkspaceBlob(path)).arrayBuffer());
          } catch {
            // why: a referenced file that isn't in the vault stays a plain link; it is reported below
            return null;
          }
        },
      });
      const missing =
        (site.missing.length ? ` ${t("publish.missing", { count: site.missing.length })}` : "") +
        (site.withheld.length ? ` ${t("publish.withheld", { count: site.withheld.length })}` : "");
      if (settings.target === "zip" || !repo) {
        const name = `${(settings.title.trim() || "site").replace(/[^\p{L}\p{N}._-]+/gu, "-")}.zip`;
        download(await siteZip(site.files), name);
        setResult({ text: t("publish.done.zip", { name, count: site.pages.length }) + missing });
        return;
      }
      const { setSecret, flushSecrets } = await import("../lib/secretStore");
      if (token.trim()) {
        setSecret(TOKEN_SECRET, token.trim());
        await flushSecrets();
      }
      const res = await deployToGitHubPages(site.files, { ...repo, branch: settings.branch, token: useToken }, {
        onProgress: (p) => setBusy(t("publish.deploying", { step: p.step === "blobs" ? `${p.done}/${p.total}` : p.step })),
      });
      setResult({ text: t("publish.done.github", { count: site.pages.length, url: res.url }) + missing, url: res.url });
    } catch (e) {
      setResult({ text: t("publish.failed", { error: (e as Error).message }), error: true });
    } finally {
      setBusy(null);
    }
  };

  const toggle = (path: string) =>
    setPicked((s) => {
      const next = new Set(s);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return next;
    });

  return (
    <div className="cmd-palette-backdrop">
      <div className="cmd-palette" role="dialog" aria-modal="true" aria-label={t("publish.title")} data-testid="publish-site" style={{ maxWidth: 640, padding: 0, display: "flex", flexDirection: "column", maxHeight: "88vh" }}>
        <header style={{ padding: "14px 18px", borderBottom: "1px solid hsl(var(--border))", display: "flex", gap: 10, alignItems: "center" }}>
          <Globe size={18} style={{ color: "hsl(var(--accent))" }} />
          <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, flex: 1 }}>{t("publish.title")}</h2>
          <button ref={closeRef} type="button" style={ghost} onClick={onClose} aria-label={t("publish.close")}>
            <X size={16} />
          </button>
        </header>
        <div style={{ padding: 18, display: "flex", flexDirection: "column", gap: 12, fontSize: 13, overflowY: "auto" }}>
          <p style={{ ...muted, margin: 0 }}>{t("publish.intro")}</p>

          <div style={col}>
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <strong style={{ flex: 1 }}>{t("publish.notes", { count: picked.size, total: notes?.length ?? 0 })}</strong>
              <input style={{ ...field, width: 160 }} value={filter} onChange={(e) => setFilter(e.target.value)} placeholder={t("publish.filter")} aria-label={t("publish.filter")} />
              <button type="button" style={ghost} onClick={() => setPicked(new Set((notes ?? []).map((n) => n.path)))}>
                {t("publish.all")}
              </button>
              <button type="button" style={ghost} onClick={() => setPicked(new Set())}>
                {t("publish.none")}
              </button>
            </div>
            <div style={{ maxHeight: 200, overflowY: "auto", border: "1px solid hsl(var(--border))", borderRadius: 6, padding: 6 }} data-testid="publish-notes">
              {shown.map((n) => (
                <label key={n.path} style={{ display: "flex", gap: 8, padding: "2px 0" }}>
                  <input type="checkbox" checked={picked.has(n.path)} onChange={() => toggle(n.path)} />
                  <span dir="auto">{n.path}</span>
                </label>
              ))}
            </div>
          </div>

          <div style={{ display: "flex", gap: 12, flexWrap: "wrap" }}>
            <label style={{ ...col, flex: 2 }}>
              <span>{t("publish.siteTitle")}</span>
              <input dir="auto" style={field} value={settings.title} onChange={(e) => update({ title: e.target.value })} data-testid="publish-title" />
            </label>
            <label style={{ ...col, flex: 1 }}>
              <span>{t("publish.lang")}</span>
              <select style={field} value={settings.lang} onChange={(e) => update({ lang: e.target.value })} data-testid="publish-lang">
                <option value="en">English</option>
                <option value="he">עברית</option>
              </select>
            </label>
          </div>

          <fieldset style={{ border: "1px solid hsl(var(--border))", borderRadius: 6, padding: "8px 12px", display: "flex", flexDirection: "column", gap: 6 }}>
            <legend>{t("publish.target")}</legend>
            <label style={{ display: "flex", gap: 8 }}>
              <input type="radio" name="publish-target" checked={settings.target === "zip"} onChange={() => update({ target: "zip" })} data-testid="publish-target-zip" />
              <span>{t("publish.target.zip")}</span>
            </label>
            <label style={{ display: "flex", gap: 8 }}>
              <input type="radio" name="publish-target" checked={settings.target === "github"} onChange={() => update({ target: "github" })} data-testid="publish-target-github" />
              <span>{t("publish.target.github")}</span>
            </label>
            {settings.target === "github" && (
              <div style={{ display: "flex", flexDirection: "column", gap: 8, paddingInlineStart: 24 }}>
                <div style={{ display: "flex", gap: 8 }}>
                  <label style={{ ...col, flex: 2 }}>
                    <span>{t("publish.repo")}</span>
                    <input dir="ltr" style={field} value={settings.repo} onChange={(e) => update({ repo: e.target.value })} placeholder="owner/name" data-testid="publish-repo" />
                  </label>
                  <label style={{ ...col, flex: 1 }}>
                    <span>{t("publish.branch")}</span>
                    <input dir="ltr" style={field} value={settings.branch} onChange={(e) => update({ branch: e.target.value })} data-testid="publish-branch" />
                  </label>
                </div>
                <label style={col}>
                  <span>{t("publish.token")}</span>
                  <input dir="ltr" type="password" autoComplete="off" style={field} value={token} onChange={(e) => setToken(e.target.value)} data-testid="publish-token" />
                  <span style={muted}>{t("publish.token.hint")}</span>
                </label>
              </div>
            )}
          </fieldset>

          {busy && (
            <div style={muted} aria-live="polite" data-testid="publish-busy">
              {busy}
            </div>
          )}
          {result && (
            <div role={result.error ? "alert" : "status"} style={{ fontSize: 13, color: result.error ? "hsl(0 70% 55%)" : undefined }} data-testid="publish-result">
              {result.text}
              {result.url && (
                <>
                  {" "}
                  <a href={result.url} target="_blank" rel="noreferrer">
                    {t("publish.open")}
                  </a>
                </>
              )}
            </div>
          )}
          <div style={{ display: "flex", justifyContent: "flex-end", gap: 8 }}>
            <button type="button" style={primary} onClick={() => void publish()} disabled={!notes || !picked.size || !!busy} data-testid="publish-go">
              {t("publish.go")}
            </button>
          </div>
        </div>
      </div>
    </div>
  );
}

let openHost: { close: () => void } | null = null;

/** Open the publish dialog (one at a time). */
export function openPublishSite(): void {
  openHost?.close();
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    if (openHost?.close === close) openHost = null;
    try {
      root.unmount();
    } catch {
      /* why: already unmounted by an earlier close */
    }
    host.remove();
  };
  openHost = { close };
  root.render(<PublishSiteDialog onClose={close} />);
}
