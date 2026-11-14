/**
 * The feature-flags panel's host (plan 14.4), mounted once in App, and the
 * Beta badge of the status bar. The panel itself (./FeatureFlagsPanel)
 * loads when it is opened, so it stays out of the startup bundle.
 */

import { lazy, Suspense, useEffect, useState } from "react";
import { t } from "../i18n";
import { buildChannel } from "../flags/flags";

const FeatureFlagsPanel = lazy(() => import("./FeatureFlagsPanel").then((m) => ({ default: m.FeatureFlagsPanel })));

export const OPEN_FEATURE_FLAGS = "lumen-open-feature-flags";

/** Mounted once in App; renders the panel when asked. */
export function FeatureFlagsHost() {
  const [open, setOpen] = useState(false);
  useEffect(() => {
    const on = () => setOpen(true);
    window.addEventListener(OPEN_FEATURE_FLAGS, on);
    return () => window.removeEventListener(OPEN_FEATURE_FLAGS, on);
  }, []);
  return open ? (
    <Suspense fallback={null}>
      <FeatureFlagsPanel onClose={() => setOpen(false)} />
    </Suspense>
  ) : null;
}

/** "Beta" in the status bar of a beta build; opens the flags. */
export function BetaBadge() {
  if (buildChannel() !== "beta") return null;
  return (
    <button
      type="button"
      className="sb-item"
      data-testid="beta-badge"
      title={t("flags.badge.title")}
      onClick={() => window.dispatchEvent(new CustomEvent(OPEN_FEATURE_FLAGS))}
      style={{ border: "1px solid hsl(var(--accent) / 0.5)", borderRadius: 4, paddingInline: 6, color: "hsl(var(--accent))", background: "transparent", cursor: "pointer", font: "inherit" }}
    >
      {t("flags.badge")}
    </button>
  );
}
