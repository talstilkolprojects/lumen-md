/**
 * Live data hook — pulls a block's body from a URL when the fence meta
 * specifies `src="https://..."`, with an optional `refresh="60s"` for
 * auto-rotating dashboards.
 *
 *     ```chart src="https://example.com/sales.json"
 *     ```
 *
 *     ```csv src="https://example.com/sales.csv" refresh="30s"
 *     ```
 *
 * Returns:
 *   - `effectiveSource`: the fetched body when `src=` is set, otherwise the
 *     inline source unchanged. Components that render data should pass this
 *     to their parser.
 *   - `loading` / `error`: surface progress + failures.
 *   - `refetch()`: imperatively re-fetch (used by a manual refresh button).
 *
 * The hook is intentionally CORS-aware: failures fall through to the
 * inline body when one exists, so a misconfigured server doesn't blank
 * the diagram entirely.
 */

import { useCallback, useEffect, useMemo, useState } from "react";
import { log } from "../lib/logger";
import { fetchWithRetry } from "../lib/fetchRetry";
import { explainError } from "../lib/userError";

export interface FetchedSource {
  effectiveSource: string;
  loading: boolean;
  error: string | null;
  /** True when the body came from the network (vs the inline fence). */
  remote: boolean;
  /** Resolved URL or null when `src=` is missing. */
  url: string | null;
  /** ms until the next auto-refresh, or null when not configured. */
  refreshMs: number | null;
  /** Manual re-fetch trigger. */
  refetch: () => void;
}

const META_SRC_RE = /\bsrc\s*=\s*["']([^"']+)["']/i;
const META_REFRESH_RE = /\brefresh\s*=\s*["']?(\d+)([smh]?)["']?/i;

export function parseSrcFromMeta(meta: string | undefined): {
  url: string | null;
  refreshMs: number | null;
} {
  if (!meta) return { url: null, refreshMs: null };
  const srcMatch = meta.match(META_SRC_RE);
  const url = srcMatch?.[1] ?? null;
  const refMatch = meta.match(META_REFRESH_RE);
  let refreshMs: number | null = null;
  if (refMatch) {
    const n = Number(refMatch[1]);
    const unit = (refMatch[2] || "s").toLowerCase();
    const factor = unit === "h" ? 3_600_000 : unit === "m" ? 60_000 : 1_000;
    if (Number.isFinite(n) && n > 0) refreshMs = n * factor;
  }
  // Clamp the floor so a typo `refresh="1"` doesn't DDOS upstream.
  if (refreshMs !== null && refreshMs < 1_000) refreshMs = 1_000;
  return { url, refreshMs };
}

export function useFetchSource(
  inlineSource: string,
  meta?: string,
): FetchedSource {
  const { url, refreshMs } = useMemo(() => parseSrcFromMeta(meta), [meta]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [remoteBody, setRemoteBody] = useState<string | null>(null);
  const [tick, setTick] = useState(0);

  const refetch = useCallback(() => setTick((t) => t + 1), []);

  useEffect(() => {
    if (!url) {
      setRemoteBody(null);
      setError(null);
      return;
    }
    let cancelled = false;
    const controller = new AbortController();
    setLoading(true);
    setError(null);
    fetchWithRetry(
      url,
      { signal: controller.signal },
      { label: "plugin.fetchSource", maxRetries: 2, baseDelayMs: 700, maxDelayMs: 2000 },
    )
      .then(async (res) => {
        if (!res.ok) throw new Error(`${res.status} ${res.statusText}`);
        return res.text();
      })
      .then((text) => {
        if (cancelled) return;
        setRemoteBody(text);
        setLoading(false);
      })
      .catch((e: Error) => {
        if (cancelled || e.name === "AbortError") return;
        log.warn(`fetch ${url} failed`, e);
        setError(explainError(e, "fetch"));
        setLoading(false);
      });
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [url, tick]);

  // Auto-refresh interval.
  useEffect(() => {
    if (!url || !refreshMs) return;
    const id = window.setInterval(() => setTick((t) => t + 1), refreshMs);
    return () => window.clearInterval(id);
  }, [url, refreshMs]);

  const effectiveSource = url
    ? remoteBody ?? (loading ? "" : inlineSource)
    : inlineSource;

  return {
    effectiveSource,
    loading,
    error,
    remote: !!url && remoteBody !== null,
    url,
    refreshMs,
    refetch,
  };
}
