/** Whether this is a Mac (⌘ vs Ctrl in shortcut labels). Its own module so the palette doesn't pull in the shortcuts overlay. */
export function detectIsMac(): boolean {
  if (typeof navigator === "undefined") return false;
  // Modern API — Chromium 90+, Edge, Opera.
  const ua = (navigator as Navigator & {
    userAgentData?: { platform?: string };
  }).userAgentData;
  if (ua?.platform) return /mac/i.test(ua.platform);
  // Fallback: userAgent string ("Macintosh" is the canonical token).
  if (navigator.userAgent) {
    if (/Macintosh|Mac OS X|Mac_PowerPC/i.test(navigator.userAgent)) return true;
  }
  // Last resort: deprecated `platform`. Some build pipelines (sandboxed
  // iframes, headless without ua) still expose it.
  if (navigator.platform && /mac/i.test(navigator.platform)) return true;
  return false;
}
