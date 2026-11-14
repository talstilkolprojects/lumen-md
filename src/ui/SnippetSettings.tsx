/**
 * CSS snippets in the theme settings (plan W1.21): the `.css` files of
 * `.lumen/snippets/`, each with a switch, and what the sanitizer removed
 * from it (anything that would reach the network).
 */
import { useCallback, useEffect, useState } from "react";
import { RefreshCw, ShieldAlert } from "lucide-react";
import { useAppStore } from "../store/useStore";
import { onWorkspaceChanged } from "../storage/workspaceEvents";
import { isOPFSAvailable } from "../storage/workspace";
import { createExampleSnippet, refreshSnippets, type LoadedSnippet } from "../theme/snippets";
import { t } from "../i18n";

export function SnippetSettings() {
  const enabled = useAppStore((s) => s.enabledSnippets);
  const setEnabled = useAppStore((s) => s.setSnippetEnabled);
  const [snippets, setSnippets] = useState<LoadedSnippet[] | null>(null);

  const reload = useCallback(() => {
    if (!isOPFSAvailable()) return setSnippets([]);
    void refreshSnippets(useAppStore.getState().enabledSnippets).then(setSnippets);
  }, []);

  useEffect(() => {
    reload();
    return onWorkspaceChanged(reload, { debounceMs: 300 });
  }, [reload]);

  return (
    <fieldset style={{ border: "none", margin: 0, padding: 0, minWidth: 0 }} data-testid="snippet-settings">
      <legend style={{ margin: "0 0 8px", fontSize: 11, fontWeight: 600, textTransform: "uppercase", letterSpacing: "0.05em", color: "hsl(var(--fg-muted))" }}>{t("snippets.title")}</legend>
      <p style={{ margin: "0 0 8px", fontSize: 12, lineHeight: 1.5, color: "hsl(var(--fg-muted))" }}>{t("snippets.intro")}</p>
      {snippets && snippets.length === 0 && (
        <button
          type="button"
          onClick={() => void createExampleSnippet().then(reload)}
          disabled={!isOPFSAvailable()}
          style={{ fontSize: 12, padding: "4px 10px", borderRadius: 6, border: "1px solid hsl(var(--border))", background: "hsl(var(--bg-subtle))", color: "hsl(var(--fg))", cursor: "pointer" }}
        >
          {t("snippets.createExample")}
        </button>
      )}
      <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "grid", gap: 6 }}>
        {(snippets ?? []).map((s) => {
          const on = enabled.includes(s.name);
          return (
            <li key={s.path} data-snippet={s.name}>
              <label style={{ display: "flex", gap: 8, alignItems: "center", fontSize: 12 }}>
                <input type="checkbox" role="switch" checked={on} onChange={(e) => setEnabled(s.name, e.target.checked)} aria-describedby={s.result.removed.length ? `snippet-removed-${s.name}` : undefined} />
                <span dir="auto" style={{ fontWeight: 500 }}>{s.name}</span>
                <span style={{ color: "hsl(var(--fg-muted))" }} dir="ltr">{s.path}</span>
              </label>
              {s.result.removed.length > 0 && (
                <p id={`snippet-removed-${s.name}`} style={{ margin: "2px 0 0", paddingInlineStart: 24, fontSize: 11, color: "hsl(var(--fg-muted))", display: "flex", gap: 4, alignItems: "start" }} data-testid="snippet-removed">
                  <ShieldAlert size={12} aria-hidden="true" style={{ flexShrink: 0, marginBlockStart: 2 }} />
                  <span>
                    {t("snippets.removed", { count: s.result.removed.length })}{" "}
                    {s.result.removed
                      .slice(0, 3)
                      .map((r) => t("snippets.removedAt", { line: r.line, reason: t(`snippets.reason.${r.reason}`) }))
                      .join(" · ")}
                  </span>
                </p>
              )}
            </li>
          );
        })}
      </ul>
      <button type="button" onClick={reload} style={{ marginBlockStart: 8, fontSize: 12, display: "inline-flex", gap: 4, alignItems: "center", border: "none", background: "transparent", color: "hsl(var(--accent))", cursor: "pointer", padding: 0 }}>
        <RefreshCw size={12} aria-hidden="true" /> {t("snippets.reload")}
      </button>
    </fieldset>
  );
}
