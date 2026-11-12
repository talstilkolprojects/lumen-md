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
 * No frame gets allow-popups (airplane mode's frame guard, review 6 of #451:
 * a frame must not open a window this page can't reach and close).
 */
export function contentFrameSandbox(kind: ContentFrameRequest["kind"]): string {
  if (kind === "embed") return "allow-scripts allow-same-origin allow-presentation allow-forms";
  if (kind === "gist") return "allow-scripts";
  return "allow-scripts";
}

/** The frame's URL: the page plus the request in the fragment. */
export function contentFrameSrc(req: ContentFrameRequest): string {
  return `${CONTENT_FRAME_PATH}#${encodeURIComponent(JSON.stringify(req))}`;
}

/** The request a content frame's URL carries (null when it is not one). */
export function contentFrameRequest(src: string): ContentFrameRequest | null {
  const i = src.indexOf("#");
  if (i < 0 || !src.slice(0, i).endsWith(CONTENT_FRAME_PATH)) return null;
  try {
    return JSON.parse(decodeURIComponent(src.slice(i + 1))) as ContentFrameRequest;
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

/** A content frame for `req`, ready to insert (the preview and the WYSIWYG editor). */
export function createContentFrame(req: ContentFrameRequest, doc: Document = document): HTMLIFrameElement {
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
