/**
 * Content frame (plan W4.15): where the app shows what another site serves
 * into a note — once the user allowed it.
 *
 * The app's own policy has no `https:` in img-src / media-src and frame-src
 * is 'self' alone. An image, video or audio file from another site, an embed
 * (the embed block, a raw <iframe> in a note) and a GitHub Gist render
 * instead inside /content-frame.html (public/content-frame.html + .js): a
 * same-origin page with its own policy (security/policy.json, route
 * content-frame), which allows https: images and media and the embed
 * providers' frames, and nothing else.
 *
 * Nothing here decides *whether* something may load: the callers render
 * the remote-content placeholder until the user allows it
 * (src/lib/remoteImages.ts), so the privacy promise of plan 2.2 holds.
 *
 * The request goes in the #fragment (never sent to a server, not part of
 * the service worker's cache key). The frame reports the size its content
 * wants with postMessage; this module sizes the <iframe> to it.
 */

export const CONTENT_FRAME_PATH = "/content-frame.html";
export const CONTENT_FRAME_MESSAGE = "lumen-content-frame";

/**
 * The content frame's own site (plan W6.40, review E52): the deployment's
 * `VITE_CONTENT_FRAME_URL`, the page's URL on a second static site that
 * serves only public/content-frame.{html,js} (scripts/content-frame-site.mjs;
 * the official one is https://lumen-md-frame.pages.dev/, on the Public Suffix
 * List, so it is another *site* as well as another origin). There the frame
 * has its own storage and can't touch the app's: an embed's player keeps the
 * `allow-same-origin` it needs, and that origin is the frame site's.
 *
 * Without one, the frame stays on the app's host, where it is always opaque:
 * the iframe's sandbox has no allow-same-origin, and the host's policy for
 * /content-frame.html adds `sandbox` (security/policy.json), so even a
 * top-level visit can't run it with the app's origin. Embeds, which need an
 * origin of their own, are then a link instead of a player.
 */
const ENV_URL: string | undefined = import.meta.env.VITE_CONTENT_FRAME_URL;
let urlOverride: string | null | undefined;

/** Tests: pretend the build was made with this frame site URL (undefined: back to the build's). */
export function __setContentFrameUrl(url: string | null | undefined): void {
  urlOverride = url;
}

export interface ContentFrameSite {
  origin: string;
  /** The page's URL without a fragment, e.g. `https://lumen-md-frame.pages.dev/`. */
  page: string;
}

/**
 * The frame site, or null when there is none to use: unset, not an https:
 * URL (http: only on a loopback host, for dev and e2e), with a query or a
 * fragment, or on the app's own origin (that would isolate nothing).
 */
export function contentFrameSite(appOrigin: string = typeof location === "undefined" ? "" : location.origin): ContentFrameSite | null {
  const raw = (urlOverride !== undefined ? urlOverride : ENV_URL)?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return null;
  }
  if (url.search || url.hash || url.username || url.password || raw.includes("#") || raw.includes("?")) return null;
  const loopback = url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && loopback)) return null;
  if (url.origin === appOrigin) return null;
  return { origin: url.origin, page: url.origin + url.pathname };
}

/** The frame site's origin (see contentFrameSite). */
export function contentFrameOrigin(appOrigin?: string): string | null {
  return contentFrameSite(appOrigin)?.origin ?? null;
}

export type ContentFrameRequest =
  | { kind: "img"; src: string; srcset?: string; alt?: string; title?: string; width?: number; height?: number }
  | { kind: "video" | "audio"; src: string; title?: string; loop?: boolean; muted?: boolean }
  | { kind: "embed"; src: string; title: string; allow?: string; referrerPolicy?: "no-referrer" | "strict-origin-when-cross-origin" }
  | { kind: "gist"; user: string; id: string };

/**
 * Sandbox flags per kind. Images, media and Gists get an opaque origin
 * (no allow-same-origin): nothing in them can reach the app — a Gist is
 * GitHub's script writing into the page. Embeds keep the flags the embed
 * block always gave the provider's frame: a nested frame inherits its
 * parent's sandbox, and the providers need their own origin (storage,
 * cookies, a referrer) to play. Only the content frame's own script runs
 * at the app's origin there, and it builds elements, never HTML.
 * Embeds get allow-popups (a provider's "Watch on YouTube" link): airplane
 * mode's frame guard takes it away while the switch is on, and at the switch
 * counts a frame that had it as a window that may have reached the network
 * (review 8 of #451, RR8-451-2).
 */
export function contentFrameSandbox(kind: ContentFrameRequest["kind"], frameOrigin: string | null = contentFrameOrigin()): string | null {
  // W6.40: the origin an embed keeps must be the frame site's, never the app's.
  if (kind === "embed") return frameOrigin ? "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms" : null;
  if (kind === "gist") return "allow-scripts";
  return "allow-scripts";
}

/**
 * The frame's URL: the page (on the frame site when there is one) plus the
 * request in the fragment. On the frame site the request also names the
 * app's origin, the only one the page posts its size to.
 */
export function contentFrameSrc(req: ContentFrameRequest, site: ContentFrameSite | null = contentFrameSite()): string {
  if (!site) return `${CONTENT_FRAME_PATH}#${encodeURIComponent(JSON.stringify(req))}`;
  return `${site.page}#${encodeURIComponent(JSON.stringify({ ...req, parent: location.origin }))}`;
}

/** An https: URL, as the content frame's page accepts it (public/content-frame.js `httpsUrl`). */
const isHttps = (v: unknown): v is string => {
  if (typeof v !== "string") return false;
  try {
    return new URL(v).protocol === "https:";
  } catch {
    return false;
  }
};
const optString = (v: unknown) => v === undefined || typeof v === "string";
const optNumber = (v: unknown) => v === undefined || (typeof v === "number" && Number.isFinite(v) && v > 0);
const optBoolean = (v: unknown) => v === undefined || typeof v === "boolean";
/** Keep the fields that are there (so a request comes back equal to itself). */
const present = <T extends object>(o: T): T => Object.fromEntries(Object.entries(o).filter(([, v]) => v !== undefined)) as T;

/**
 * A request as the content frame's page would show it, or null (blind tests,
 * F-6): one of the five kinds, every source https: (the frame's page accepts
 * nothing else, blob: and data: included), fields of the right types.
 * Unknown fields are dropped.
 */
export function validContentFrameRequest(v: unknown): ContentFrameRequest | null {
  if (!v || typeof v !== "object" || Array.isArray(v)) return null;
  const r = v as Record<string, unknown>;
  switch (r.kind) {
    case "img": {
      if (!isHttps(r.src) || !optString(r.srcset) || !optString(r.alt) || !optString(r.title) || !optNumber(r.width) || !optNumber(r.height)) return null;
      if (typeof r.srcset === "string" && !r.srcset.split(",").every((c) => !c.trim() || isHttps(c.trim().split(/\s+/)[0]))) return null;
      return present({ kind: "img" as const, src: r.src, srcset: r.srcset as string | undefined, alt: r.alt as string | undefined, title: r.title as string | undefined, width: r.width as number | undefined, height: r.height as number | undefined });
    }
    case "video":
    case "audio":
      if (!isHttps(r.src) || !optString(r.title) || !optBoolean(r.loop) || !optBoolean(r.muted)) return null;
      return present({ kind: r.kind as "video" | "audio", src: r.src, title: r.title as string | undefined, loop: r.loop as boolean | undefined, muted: r.muted as boolean | undefined });
    case "embed":
      if (!isHttps(r.src) || typeof r.title !== "string" || !optString(r.allow)) return null;
      if (r.referrerPolicy !== undefined && r.referrerPolicy !== "no-referrer" && r.referrerPolicy !== "strict-origin-when-cross-origin") return null;
      return present({ kind: "embed" as const, src: r.src, title: r.title, allow: r.allow as string | undefined, referrerPolicy: r.referrerPolicy as "no-referrer" | "strict-origin-when-cross-origin" | undefined });
    case "gist":
      // The same patterns as the frame's page.
      if (typeof r.user !== "string" || !/^[\w-]{1,100}$/.test(r.user) || typeof r.id !== "string" || !/^\w{1,100}$/.test(r.id)) return null;
      return { kind: "gist", user: r.user, id: r.id };
    default:
      return null;
  }
}

/** The request a content frame's URL carries (null when it is not one, or not one the frame would show). */
export function contentFrameRequest(src: string): ContentFrameRequest | null {
  const i = src.indexOf("#");
  if (i < 0) return null;
  const page = src.slice(0, i);
  const site = contentFrameSite();
  if (!page.endsWith(CONTENT_FRAME_PATH) && !(site && page === site.page)) return null;
  try {
    return validContentFrameRequest(JSON.parse(decodeURIComponent(src.slice(i + 1))));
  } catch {
    return null;
  }
}

function frameTitle(req: ContentFrameRequest): string {
  if (req.kind === "gist") return `GitHub Gist ${req.user}/${req.id}`;
  if (req.kind === "embed") return req.title;
  return (req.kind === "img" ? req.alt || req.title : req.title) || new URL(req.src, "https://x.invalid").host;
}

/** Size a frame before its content reports one. */
function initialSize(frame: HTMLIFrameElement, req: ContentFrameRequest) {
  const s = frame.style;
  s.border = "0";
  s.maxWidth = "100%";
  s.background = "transparent";
  switch (req.kind) {
    case "img":
      s.display = "inline-block";
      s.verticalAlign = "middle";
      if (req.width && req.height) {
        s.width = `${req.width}px`;
        s.aspectRatio = `${req.width} / ${req.height}`;
        s.height = "auto";
      } else {
        s.width = "1.5em";
        s.height = "1.5em";
      }
      break;
    case "video":
      s.display = "block";
      s.width = "100%";
      s.aspectRatio = "16 / 9";
      s.height = "auto";
      break;
    case "audio":
      s.display = "block";
      s.width = "100%";
      s.height = "54px";
      break;
    case "gist":
      s.display = "block";
      s.width = "100%";
      s.height = "120px";
      break;
    case "embed":
      s.display = "block";
      s.width = "100%";
      s.height = "100%";
      break;
  }
}

const clamp = (n: unknown): number | null => (typeof n === "number" && Number.isFinite(n) && n >= 1 ? Math.min(Math.round(n), 10_000) : null);

/** Apply a size the frame reported. Exported for tests. */
export function applyContentFrameSize(frame: HTMLIFrameElement, data: { width?: unknown; height?: unknown }): void {
  const w = clamp(data.width);
  const h = clamp(data.height);
  const kind = frame.dataset.contentFrame;
  const s = frame.style;
  if (!h) return;
  if ((kind === "img" && frame.dataset.fixedSize !== "1") || kind === "video") {
    if (!w) return;
    s.width = `${w}px`;
    s.aspectRatio = `${w} / ${h}`;
    s.height = "auto";
  } else if (kind === "audio" || kind === "gist") {
    s.height = `${h}px`;
  }
}

let listening = false;
function listen(win: Window) {
  if (listening) return;
  listening = true;
  win.addEventListener("message", (e: MessageEvent) => {
    const data = e.data as { type?: unknown; width?: unknown; height?: unknown } | null;
    if (!data || typeof data !== "object" || data.type !== CONTENT_FRAME_MESSAGE || !e.source) return;
    // Only a frame this module made, matched by its window — never by the
    // message's claims — and only from the origin that frame has: "null" for
    // an opaque one, the frame site's for an embed there (W6.40).
    for (const frame of win.document.querySelectorAll<HTMLIFrameElement>("iframe[data-content-frame]")) {
      if (frame.contentWindow === e.source) {
        if (e.origin !== frame.dataset.frameOrigin) return;
        applyContentFrameSize(frame, data);
        return;
      }
    }
  });
}

/**
 * An embed with no frame site to play in (W6.40): a link that opens the
 * player in a new tab, never a frame with the app's origin.
 */
function embedLink(req: Extract<ContentFrameRequest, { kind: "embed" }>, doc: Document): HTMLAnchorElement {
  const a = doc.createElement("a");
  a.href = req.src;
  a.target = "_blank";
  a.rel = "noopener noreferrer";
  a.dir = "auto";
  a.dataset.contentFrameLink = "embed";
  a.title = new URL(req.src).host;
  a.textContent = `${req.title || a.title} ↗`;
  return a;
}

/** A content frame for `req`, ready to insert (the preview and the WYSIWYG editor). */
export function createContentFrame(req: ContentFrameRequest, doc: Document = document): HTMLIFrameElement | HTMLAnchorElement {
  const site = contentFrameSite(doc.defaultView?.location.origin);
  const frameOrigin = site?.origin ?? null;
  const sandbox = contentFrameSandbox(req.kind, frameOrigin);
  if (sandbox === null && req.kind === "embed") return embedLink(req, doc);
  if (doc.defaultView) listen(doc.defaultView);
  const frame = doc.createElement("iframe");
  frame.dataset.contentFrame = req.kind;
  // The origin its messages come from: its own (frame site) only for an embed.
  frame.dataset.frameOrigin = req.kind === "embed" && frameOrigin ? frameOrigin : "null";
  if (req.kind === "img" && req.width && req.height) frame.dataset.fixedSize = "1";
  frame.title = frameTitle(req);
  frame.setAttribute("sandbox", sandbox ?? "allow-scripts");
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.setAttribute("loading", "lazy");
  // Permissions the provider's player gets are delegated through this frame.
  if (req.kind === "embed" && req.allow) frame.setAttribute("allow", req.allow);
  if (req.kind === "embed" || req.kind === "video") frame.setAttribute("allowfullscreen", "");
  initialSize(frame, req);
  frame.src = contentFrameSrc(req, site);
  return frame;
}
