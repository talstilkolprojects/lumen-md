/**
 * Credits (plan 6.1): the attribution every model and data file Lumen can
 * download asks for — CC BY in particular (the ivrit.ai speech model) —
 * read from models/registry.json, the same list the licence gate checks.
 * Lazy-loaded from the command palette.
 */
import { createRoot } from "react-dom/client";
import registry from "../../models/registry.json";
import { t } from "../i18n";

interface Entry {
  id: string;
  kind: string;
  source?: string;
  license: string;
  class: string;
  attribution?: string;
  delivery?: string;
}

/** Models the app can download or ships, with their attribution line. */
export function creditEntries(list: readonly Entry[] = (registry as { models: Entry[] }).models): Entry[] {
  return list.filter((m) => m.attribution && m.class !== "forbidden" && m.delivery !== "none").sort((a, b) => a.kind.localeCompare(b.kind) || a.id.localeCompare(b.id));
}

export function openCredits(): void {
  const host = document.createElement("div");
  document.body.appendChild(host);
  const root = createRoot(host);
  const close = () => {
    root.unmount();
    host.remove();
  };
  root.render(
    <div role="dialog" aria-modal="true" aria-label={t("credits.title")} onClick={(e) => e.target === e.currentTarget && close()} onKeyDown={(e) => e.key === "Escape" && close()} style={{ position: "fixed", inset: 0, zIndex: 9999, background: "hsl(0 0% 0%/0.4)", display: "flex", alignItems: "center", justifyContent: "center", padding: 16 }}>
      <div style={{ background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 12, padding: 20, maxWidth: 720, width: "100%", maxHeight: "80vh", overflow: "auto", fontSize: 13 }}>
        <h2 style={{ marginTop: 0 }}>{t("credits.title")}</h2>
        <p>{t("credits.intro")}</p>
        <ul style={{ paddingInlineStart: 18 }}>
          {creditEntries().map((m) => (
            <li key={m.id} style={{ marginBottom: 6 }} dir="auto">
              <strong>{m.id}</strong> — {m.license}
              <br />
              <span style={{ opacity: 0.8 }}>{m.attribution}</span>
              {m.source && (
                <>
                  {" "}
                  <a href={m.source} target="_blank" rel="noreferrer noopener">
                    {m.source.replace(/^https:\/\//, "")}
                  </a>
                </>
              )}
            </li>
          ))}
        </ul>
        <button type="button" autoFocus onClick={close} style={{ border: "1px solid hsl(var(--border-strong))", borderRadius: 6, padding: "4px 12px", background: "transparent", color: "inherit", cursor: "pointer" }}>
          {t("credits.close")}
        </button>
      </div>
    </div>,
  );
}
