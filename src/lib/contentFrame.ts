/**
 * Content frame (plan W4.15): where the app shows what another site serves
 * into a note — once the user allowed it.
 *
 * The app's own policy has no `https:` in img-src / media-src and frame-src
 * is 'self' alone. An image, video or audio file from another site and an
 * embed (the embed block, a raw <iframe> in a note) render instead inside
 * /content-frame.html (public/content-frame.html + .js): a same-origin page
 * with its own policy (security/policy.json, route content-frame), which
 * allows https: images and media and the embed providers' frames, and no
 * third-party script. A GitHub Gist is a link (W10.D2).
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

export type ContentFrameRequest =
  | { kind: "img"; src: string; srcset?: string; alt?: string; title?: string; width?: number; height?: number }
  | { kind: "video" | "audio"; src: string; title?: string; loop?: boolean; muted?: boolean }
  | { kind: "embed"; src: string; title: string; allow?: string; referrerPolicy?: "no-referrer" | "strict-origin-when-cross-origin" }
  | { kind: "gist"; user: string; id: string };

/**
 * The flags an embed's content frame gets: the ones the embed block always
 * gave the provider's frame, which inherits them.
 * allow-popups is for a provider's "Watch on YouTube" link: airplane mode's
 * frame guard takes it away while the switch is on, and at the switch counts
 * a frame that had it as a window that may have reached the network
 * (review 8 of #451, RR8-451-2).
 */
export const EMBED_SANDBOX = "allow-scripts allow-same-origin allow-popups allow-presentation allow-forms";

/**
 * Sandbox flags of the content frame per kind. Images and media get an
 * opaque origin (no allow-same-origin). Embeds keep the flags the embed block
 * always gave the provider's frame: a nested frame inherits its parent's
 * sandbox, and the providers need their own origin (storage, cookies, a
 * referrer) to play. Only the content frame's own script runs at the app's
 * origin there, and it builds elements, never HTML. A Gist is a link, not a
 * frame (W10.D2, see createContentFrame).
 */
export function contentFrameSandbox(kind: ContentFrameRequest["kind"]): string {
  if (kind === "embed") return EMBED_SANDBOX;
  return "allow-scripts";
}

/** A Gist's page on GitHub. */
export const gistUrl = (req: { user: string; id: string }) => `https://gist.github.com/${encodeURIComponent(req.user)}/${encodeURIComponent(req.id)}`;

/** The frame's URL: the page plus the request in the fragment. */
export function contentFrameSrc(req: ContentFrameRequest): string {
  return `${CONTENT_FRAME_PATH}#${encodeURIComponent(JSON.stringify(req))}`;
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
  if (i < 0 || !src.slice(0, i).endsWith(CONTENT_FRAME_PATH)) return null;
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
    // message's claims (opaque frames post with origin "null").
    for (const frame of win.document.querySelectorAll<HTMLIFrameElement>("iframe[data-content-frame]")) {
      if (frame.contentWindow === e.source) {
        applyContentFrameSize(frame, data);
        return;
      }
    }
  });
}

/**
 * What the app inserts for `req` (the preview and the WYSIWYG editor): a
 * content frame, or for a Gist a link to it. A Gist's embed is GitHub's
 * script document.write()ing into the page, so it never runs in a page of
 * ours (W10.D2): the content frame's policy has no gist.github.com either.
 */
export function createContentFrame(req: ContentFrameRequest, doc: Document = document): HTMLIFrameElement | HTMLAnchorElement {
  if (req.kind === "gist") {
    const a = doc.createElement("a");
    a.href = gistUrl(req);
    a.textContent = `gist.github.com/${req.user}/${req.id}`;
    a.title = frameTitle(req);
    a.target = "_blank";
    a.rel = "noopener noreferrer";
    a.dataset.contentFrame = "gist";
    return a;
  }
  if (doc.defaultView) listen(doc.defaultView);
  const frame = doc.createElement("iframe");
  frame.dataset.contentFrame = req.kind;
  if (req.kind === "img" && req.width && req.height) frame.dataset.fixedSize = "1";
  frame.title = frameTitle(req);
  frame.setAttribute("sandbox", contentFrameSandbox(req.kind));
  frame.setAttribute("referrerpolicy", "strict-origin-when-cross-origin");
  frame.setAttribute("loading", "lazy");
  // Permissions the provider's player gets are delegated through this frame.
  if (req.kind === "embed" && req.allow) frame.setAttribute("allow", req.allow);
  if (req.kind === "embed" || req.kind === "video") frame.setAttribute("allowfullscreen", "");
  initialSize(frame, req);
  frame.src = contentFrameSrc(req);
  return frame;
}
