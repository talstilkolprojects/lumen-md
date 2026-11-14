/**
 * Sweep all Lumen-owned localStorage keys.
 *
 * Lumen stores state under two prefixes:
 *   "lumen-*"  — flat keys (e.g. "lumen-md", "lumen-tour-done").
 *   "lumen.*"  — namespaced subsystems (collab, canvas, OAuth tokens for
 *                gdrive/dropbox, search history, template downloads,
 *                entitlement overrides, publish mock).
 *
 * Resetting all of them — and re-asserting only the tour-done flag —
 * gives us a deterministic "clean second launch" snapshot. The e2e
 * suite uses this via the shared init script, but it's also useful as a
 * one-shot "reset everything" affordance the app can expose to power
 * users from settings.
 *
 * The function intentionally swallows storage exceptions: callers may
 * invoke it from contexts where `localStorage` is unavailable (private
 * windows, server-side renders, broken quotas).
 */
export function clearAllLumenLocalStorage(options?: {
  keepTourDone?: boolean;
}): readonly string[] {
  const keepTourDone = options?.keepTourDone ?? true;
  const cleared: string[] = [];
  try {
    if (typeof localStorage === "undefined") return [];
    const toRemove: string[] = [];
    for (let i = 0; i < localStorage.length; i += 1) {
      const k = localStorage.key(i);
      if (!k) continue;
      if (k.startsWith("lumen-") || k.startsWith("lumen.")) toRemove.push(k);
    }
    for (const k of toRemove) {
      localStorage.removeItem(k);
      cleared.push(k);
    }
    if (keepTourDone) localStorage.setItem("lumen-tour-done", "1");
  } catch {
    /* why: localStorage may be unavailable — silent no-op. */
  }
  return cleared;
}
