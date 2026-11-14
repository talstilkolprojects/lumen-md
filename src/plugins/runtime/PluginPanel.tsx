/**
 * The side panel a plugin opens (plan 11.2): its title and UI tree, rendered
 * by the app. One plugin panel at a time; closing it tells the plugin.
 */
import { useSyncExternalStore } from "react";
import { createRoot, type Root } from "react-dom/client";
import { t } from "../../i18n";
import { getPanel, sendUiEvent, subscribePanel } from "./manager";
import { UiTreeView } from "./UiTreeView";
import { openPluginNoteLink } from "./openNote";

function Panel() {
  const panel = useSyncExternalStore(subscribePanel, getPanel);
  if (!panel) return null;
  return (
    <aside
      role="complementary"
      aria-label={panel.title}
      data-plugin-panel={panel.pluginId}
      dir="auto"
      style={{ position: "fixed", top: 56, bottom: 16, insetInlineEnd: 16, width: 320, zIndex: 40, overflow: "auto", background: "hsl(var(--bg))", color: "hsl(var(--fg))", border: "1px solid hsl(var(--border-strong))", borderRadius: 10, padding: 12, boxShadow: "0 8px 32px hsl(0 0% 0%/0.2)", fontSize: 13 }}
    >
      <div style={{ display: "flex", alignItems: "center", gap: 8, marginBottom: 8 }}>
        <strong style={{ flex: 1 }}>{panel.title}</strong>
        <button
          type="button"
          aria-label={t("plugins.panel.close")}
          onClick={() => {
            void import("./manager").then((m) => m.closePanelByUser(panel.pluginId));
          }}
          style={{ border: "none", background: "transparent", color: "inherit", cursor: "pointer", fontSize: 16 }}
        >
          ×
        </button>
      </div>
      {panel.tree ? (
        <UiTreeView node={panel.tree} onOpenNote={(target) => void openPluginNoteLink(target)} onEvent={(e) => sendUiEvent(panel.pluginId, { scope: "panel", ...e })} />
      ) : (
        <span style={{ opacity: 0.6 }}>{t("plugins.block.loading")}</span>
      )}
    </aside>
  );
}

let root: Root | null = null;

/** Mount the panel host once (the manager calls it when a plugin opens a panel). */
export function ensurePanelHost(): void {
  if (root || typeof document === "undefined") return;
  const host = document.createElement("div");
  host.id = "lumen-plugin-panel";
  document.body.appendChild(host);
  root = createRoot(host);
  root.render(<Panel />);
}
