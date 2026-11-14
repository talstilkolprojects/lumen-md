import { useEffect, useState } from "react";
import { t } from "../i18n";

/**
 * Listens for new service-worker versions (vite-plugin-pwa, "prompt" mode)
 * and shows a non-blocking banner offering the user to refresh.
 */
export function UpdateBanner() {
  const [needRefresh, setNeedRefresh] = useState(false);
  const [updateSW, setUpdateSW] = useState<
    ((reload?: boolean) => Promise<void>) | null
  >(null);

  useEffect(() => {
    let cancelled = false;
    // Dynamic import keeps the SW glue out of the main bundle in dev.
    import("virtual:pwa-register")
      .then(({ registerSW }) => {
        if (cancelled) return;
        const fn = registerSW({
          immediate: true,
          onNeedRefresh() {
            setNeedRefresh(true);
          },
        });
        setUpdateSW(() => fn);
        // Drop runtime caches left by earlier versions (best effort).
        void import("../lib/runtimeCaches").then((m) => m.deleteStaleRuntimeCaches()).catch(() => { /* why: stale caches only take space; the next start tries again */ });
      })
      .catch(() => {
        // why: SW not available (dev / unsupported browser) — no banner.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  if (!needRefresh) return null;

  return (
    <div className="pwa-update-banner" role="status" aria-live="polite">
      <span>{t("update.available")}</span>
      <button
        type="button"
        className="pwa-update-btn"
        onClick={() => updateSW?.(true)}
      >
        {t("update.reload")}
      </button>
      <button
        type="button"
        className="pwa-update-dismiss"
        onClick={() => setNeedRefresh(false)}
        aria-label={t("update.dismiss")}
      >
        ×
      </button>
    </div>
  );
}
