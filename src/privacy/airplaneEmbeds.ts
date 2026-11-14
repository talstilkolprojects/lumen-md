/**
 * The pure parts of airplane mode (src/privacy/airplane.ts): where a request
 * goes, and the sandbox a frame keeps. Split out so airplane.ts stays under
 * the 800-line limit (W6.25); airplane.ts re-exports them. Nothing here
 * records an attempt or reads the switch: airplane.ts passes it in.
 */

/** Origin + path only. */
export function egressTarget(url: string, base: string = typeof location !== "undefined" ? location.href : "http://localhost/"): string {
  try {
    const u = new URL(url, base);
    if (u.protocol === "blob:" || u.protocol === "data:") return `${u.protocol}…`;
    return `${u.origin}${u.pathname}`;
  } catch {
    return String(url).split(/[?#]/)[0].slice(0, 200);
  }
}

/**
 * The sites whose embeds keep `allow-same-origin`: the https origins of
 * public/_headers' frame-src, which are the providers of
 * src/plugins/EmbedBlock.tsx and the embed codes they hand out (review 8,
 * RR8-451-2: one list; a test keeps them equal). A frame from any other site
 * loses it, so it has no storage and no service worker of its own (review 6,
 * RR6-451-2). W6.40: the content frame's own site (src/lib/contentFrame.ts),
 * another site by design, in whose frame an embed player keeps an origin
 * that is never the app's; it is the app policy's frame-src entry.
 */
export const EMBED_ORIGINS: ReadonlySet<string> = new Set([
  "https://codepen.io",
  "https://codesandbox.io",
  "https://gist.github.com",
  "https://lumen-md-frame.pages.dev",
  "https://maps.google.com",
  "https://open.spotify.com",
  "https://platform.twitter.com",
  "https://player.vimeo.com",
  "https://w.soundcloud.com",
  "https://www.facebook.com",
  "https://www.figma.com",
  "https://www.google.com",
  "https://www.instagram.com",
  "https://www.linkedin.com",
  "https://www.loom.com",
  "https://www.openstreetmap.org",
  "https://www.reddit.com",
  "https://www.redditmedia.com",
  "https://www.tiktok.com",
  "https://www.youtube.com",
  "https://www.youtube-nocookie.com",
]);

const NO_POPUPS = new Set(["allow-popups", "allow-popups-to-escape-sandbox"]);

/**
 * A frame's sandbox as `guardFrames` leaves it: no popups while the switch is
 * on (`stripPopups`, review 8, RR8-451-2: before it, an embed's links still
 * open their page); same-origin powers only for the app and the known embeds.
 */
export function guardedSandbox(sandbox: string, src: string | null, base: string, stripPopups: boolean): string {
  let foreign = false;
  if (src) {
    try {
      const u = new URL(src, base);
      foreign = /^https?:$/.test(u.protocol) && u.origin !== new URL(base).origin && !EMBED_ORIGINS.has(u.origin);
    } catch {
      foreign = true; // why: a URL that doesn't parse gets no powers
    }
  }
  return sandbox
    .split(/[\t\n\f\r ]+/)
    .filter((t) => t && !(stripPopups && NO_POPUPS.has(t.toLowerCase())) && !(foreign && t.toLowerCase() === "allow-same-origin"))
    .join(" ");
}
