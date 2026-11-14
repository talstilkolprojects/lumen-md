/**
 * Remote images in notes (plan 2.2).
 *
 * An image from another site in a note is a request the reader never chose:
 * a tracking pixel in a shared note tells its author who opened it, when,
 * and from where. The web CSP has to keep `img-src https:` (a static policy
 * cannot hold one user's choices), so the renderer enforces the choice
 * instead: an image whose host the user has not allowed renders as a
 * placeholder, and nothing is requested until the user clicks "Load" (this
 * image, this session) or "Always allow" (its host, kept in this browser).
 *
 * The desktop app's CSP has no `https:` in img-src (plan 2.1), so there the
 * placeholder offers no load at all — the request would be blocked anyway.
 *
 * Used by the preview's <img> (src/renderer/components.tsx), the raw-HTML
 * sanitizer (src/renderer/rehypeSanitizeRaw.ts) and the WYSIWYG editor's
 * image node (src/editor/remoteImageView.ts).
 */

export const ALLOWED_HOSTS_KEY = "lumen.remoteImages.allowedHosts";

const baseHref = (): string | undefined => (typeof location !== "undefined" ? location.href : undefined);

/**
 * The host (with port) of `src` when it is an http(s) URL on another origin
 * than the app's; null for relative paths, the app's own origin, data:,
 * blob: and anything that is not a URL.
 */
export function remoteImageHost(src: string | null | undefined, base: string | undefined = baseHref()): string | null {
  const raw = src?.trim();
  if (!raw) return null;
  let url: URL;
  try {
    url = new URL(raw, base);
  } catch {
    return null;
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") return null;
  if (base) {
    try {
      if (url.origin === new URL(base).origin) return null;
    } catch {
      /* why: unusable base: treat as remote */
    }
  }
  return url.host.toLowerCase();
}

/** URLs of a `srcset` value (descriptors dropped). */
export function srcSetUrls(srcSet: string | null | undefined): string[] {
  if (!srcSet) return [];
  return srcSet
    .split(",")
    .map((part) => part.trim().split(/\s+/)[0] ?? "")
    .filter(Boolean);
}

/* ─── state: allowed hosts (persisted) and images loaded this session ─── */

let allowed: Set<string> | null = null;
const loadedOnce = new Set<string>();
const listeners = new Set<() => void>();
let version = 0;

function readAllowed(): Set<string> {
  try {
    const raw = localStorage.getItem(ALLOWED_HOSTS_KEY);
    const list: unknown = raw ? JSON.parse(raw) : [];
    return new Set(Array.isArray(list) ? list.filter((h): h is string => typeof h === "string").map((h) => h.toLowerCase()) : []);
  } catch {
    return new Set();
  }
}

function allowedHosts(): Set<string> {
  if (!allowed) allowed = readAllowed();
  return allowed;
}

function persist() {
  try {
    localStorage.setItem(ALLOWED_HOSTS_KEY, JSON.stringify([...allowedHosts()].sort()));
  } catch {
    /* why: storage unavailable: the choice lasts for this session */
  }
}

function changed() {
  version++;
  for (const fn of [...listeners]) fn();
}

let storageListening = false;
function listenToOtherTabs() {
  if (storageListening || typeof window === "undefined") return;
  storageListening = true;
  window.addEventListener("storage", (e) => {
    if (e.key !== ALLOWED_HOSTS_KEY && e.key !== null) return;
    allowed = readAllowed();
    changed();
  });
}

/** Subscribe to changes of the allowed hosts / loaded images. */
export function subscribeRemoteImages(fn: () => void): () => void {
  listenToOtherTabs();
  listeners.add(fn);
  return () => {
    listeners.delete(fn);
  };
}

/** Changes on every allow / load: a snapshot for useSyncExternalStore. */
export function remoteImagesVersion(): number {
  return version;
}

/** The hosts the user chose "Always allow" for, sorted. */
export function allowedRemoteImageHosts(): string[] {
  return [...allowedHosts()].sort();
}

export function allowRemoteImageHosts(hosts: readonly string[]): void {
  const set = allowedHosts();
  let added = false;
  for (const h of hosts) {
    const host = h.trim().toLowerCase();
    if (host && !set.has(host)) {
      set.add(host);
      added = true;
    }
  }
  if (!added) return;
  persist();
  changed();
}

export function forgetRemoteImageHost(host: string): void {
  if (!allowedHosts().delete(host.trim().toLowerCase())) return;
  persist();
  changed();
}

/** "Load": these URLs only, until the page is reloaded. */
export function loadRemoteImagesOnce(urls: readonly string[]): void {
  let added = false;
  for (const u of urls) {
    if (u && !loadedOnce.has(u)) {
      loadedOnce.add(u);
      added = true;
    }
  }
  if (added) changed();
}

/** May the page request this URL now? Local and same-origin URLs always may. */
export function remoteImageAllowed(src: string | null | undefined): boolean {
  const host = remoteImageHost(src);
  if (!host) return true;
  if (remoteImagesUnavailable()) return false;
  return allowedHosts().has(host) || loadedOnce.has(src!.trim());
}

/**
 * True in the desktop app: its CSP loads no images from other sites
 * (plan 2.1), so offering "Load" would only produce a broken image.
 */
export function remoteImagesUnavailable(): boolean {
  return typeof window !== "undefined" && "__TAURI_INTERNALS__" in window;
}

export interface RemoteImageGate {
  /** Nothing may be requested yet: render the placeholder. */
  blocked: boolean;
  /** Other-site hosts this image would contact (src and srcset), in order. */
  hosts: string[];
  /** The URLs "Load" would allow (src and the srcset candidates). */
  urls: string[];
  /** srcset with only the candidates that may load (undefined when none). */
  srcSet: string | undefined;
}

/**
 * Decide what an <img> may request. `src` decides: when it may load, the
 * srcset keeps only the candidates that may load too; when it may not, the
 * image is blocked whatever its srcset says.
 */
export function remoteImageGate(src: string | null | undefined, srcSet?: string | null): RemoteImageGate {
  const candidates = srcSetUrls(srcSet);
  const all = [src ?? "", ...candidates].map((u) => u.trim()).filter(Boolean);
  const remote = all.filter((u) => remoteImageHost(u));
  const hosts = [...new Set(remote.map((u) => remoteImageHost(u)!))];
  const srcOk = remoteImageAllowed(src);
  const kept = srcSet
    ? srcSet
        .split(",")
        .map((p) => p.trim())
        .filter((p) => p && remoteImageAllowed(p.split(/\s+/)[0]))
        .join(", ")
    : "";
  const blocked = !srcOk || (!src && candidates.length > 0 && !kept);
  return { blocked, hosts, urls: remote, srcSet: blocked ? undefined : kept || undefined };
}

/** Test hook: forget the in-memory state (re-read storage on next use). */
export function __resetRemoteImagesForTests(): void {
  allowed = null;
  loadedOnce.clear();
  listeners.clear();
  version = 0;
}
