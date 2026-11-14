/**
 * Where models download from (plan W4.14), in the AI settings: whether this
 * deployment has Lumen's mirror, the user's own copy (a URL with the same
 * layout as the mirror's releases), and model files picked on this device,
 * kept only when their sha256 matches the registry. Lazy, with the panel.
 */

import { useEffect, useRef, useState } from "react";
import { t } from "../i18n";
import "../ai/modelSourcesStrings";

const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" };
const muted: React.CSSProperties = { fontSize: 12, color: "hsl(var(--fg-muted))" };
const input: React.CSSProperties = { flex: 1, minWidth: 0, padding: "4px 8px", fontSize: 13 };
const ghost: React.CSSProperties = { padding: "4px 10px", fontSize: 12, borderRadius: 6, border: "1px solid hsl(var(--border))", background: "transparent", color: "inherit", cursor: "pointer" };

export function ModelSourcesSection({ captionStyle }: { captionStyle?: React.CSSProperties }) {
  const [mirror, setMirror] = useState<string | null>(null);
  const [user, setUser] = useState("");
  const [note, setNote] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /** Models that are (partly) only on Hugging Face, each with its message (plan W6.33). */
  const [hfOnly, setHfOnly] = useState<Array<{ key: string; params: Record<string, string> }>>([]);
  const fileRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let alive = true;
    void import("../ai/modelHosting").then(async (h) => {
      const base = h.builtMirrorBase();
      const saved = await h.readUserSource();
      const messages = h.mirrorMessages(await h.loadHostedModels());
      if (!alive) return;
      setMirror(base);
      setUser(saved ?? "");
      setHfOnly(messages);
    });
    return () => {
      alive = false;
    };
  }, []);

  const save = async () => {
    const h = await import("../ai/modelHosting");
    const value = user.trim();
    try {
      const kept = await h.writeUserSource(value);
      if (value && !kept) setNote(t("modelSources.invalid"));
      else setNote(t("modelSources.saved"));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    }
  };

  const pick = async (list: FileList | null) => {
    if (!list?.length) return;
    setBusy(true);
    try {
      const h = await import("../ai/modelHosting");
      const models = await h.loadHostedModels();
      const res = await h.importLocalModelFiles([...list], models, { open: (n) => caches.open(n) });
      setNote(t("modelSources.imported", { stored: res.stored.length, unknown: res.unknown.length }));
    } catch (e) {
      setNote(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
      if (fileRef.current) fileRef.current.value = "";
    }
  };

  let host = "";
  try {
    host = mirror ? new URL(mirror).host : "";
  } catch {
    host = "";
  }

  return (
    <>
      <div id="ai-set-sources" style={captionStyle}>
        {t("modelSources.title")}
      </div>
      <div style={muted}>{t("modelSources.about")}</div>
      <div style={muted} data-testid="model-mirror-state">
        {mirror ? t("modelSources.mirrorOn", { host }) : t("modelSources.mirrorOff")}
      </div>
      <label style={row}>
        <span style={{ minWidth: 90 }}>{t("modelSources.userLabel")}</span>
        <input style={input} type="url" dir="ltr" value={user} onChange={(e) => setUser(e.target.value)} placeholder="https://example.com/models" aria-describedby="model-sources-hint" />
        <button type="button" style={ghost} onClick={() => void save()}>
          {t("modelSources.save")}
        </button>
      </label>
      <div id="model-sources-hint" style={muted}>
        {t("modelSources.userHint")}
      </div>
      <div style={row}>
        <button type="button" style={ghost} disabled={busy} onClick={() => fileRef.current?.click()}>
          {t("modelSources.importFiles")}
        </button>
        <input ref={fileRef} type="file" multiple hidden onChange={(e) => void pick(e.target.files)} data-testid="model-files-input" />
      </div>
      {hfOnly.length > 0 && (
        <details style={muted} data-testid="model-hf-only">
          <summary>
            {t("modelSources.hfOnlyTitle")} ({hfOnly.length})
          </summary>
          <ul style={{ margin: "4px 0", paddingInlineStart: 18 }}>
            {hfOnly.map((m, i) => (
              <li key={i}>{t(m.key, m.params)}</li>
            ))}
          </ul>
        </details>
      )}
      {note && (
        <div style={muted} role="status">
          {note}
        </div>
      )}
    </>
  );
}
