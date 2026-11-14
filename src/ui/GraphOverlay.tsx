/**
 * The full-screen graph view (W6.25: moved out of App.tsx unchanged). The
 * graph itself is a lazy chunk.
 */
import { lazy, Suspense } from "react";
import { t } from "../i18n";
import { ErrorBoundary } from "./ErrorBoundary";

const GraphView = lazy(() => import("./GraphView").then(m => ({ default: m.GraphView })));

export function GraphOverlay({ onClose, onOpenFile }: { onClose: () => void; onOpenFile: (path: string, content: string) => void }) {
  return (
    <div style={{ position: "fixed", inset: 0, zIndex: 9999, background: "hsl(var(--bg))" }}>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", padding: "8px 16px", borderBottom: "1px solid hsl(var(--border))" }}>
        <h3 style={{ margin: 0, fontSize: 14, color: "hsl(var(--fg))" }}>{t("graphView.title")}</h3>
        <button className="icon-btn" onClick={onClose} style={{ width: "auto", padding: "4px 12px", fontSize: 12 }}>{t("dialog.cancel")}</button>
      </div>
      <div style={{ height: "calc(100vh - 42px)" }}>
        <Suspense fallback={<div style={{padding:'2rem',color:'hsl(var(--fg-muted))'}}>{t("loading.generic")}</div>}>
          <ErrorBoundary fallback={
            <div style={{ padding: "3rem", textAlign: "center", color: "hsl(0 80% 60%)" }}>
              <strong>{t("graphView.renderFailed")}</strong>
              <p>{t("graphView.renderFailedDetail")}</p>
            </div>
          }>
            <GraphView onOpenFile={onOpenFile} />
          </ErrorBoundary>
        </Suspense>
      </div>
    </div>
  );
}
