/**
 * The app end of the clipper bridge (plan 4.15.2), kept import-free so it
 * costs nothing at start-up: it only listens. The extraction stack
 * (Defuddle, Readability, Turndown) loads when a clip actually arrives.
 *
 * Protocol (mirrored by extension/bridge.js):
 *   page ← bridge   { type: "lumen-clip-v2", payload: ClipPayload }   (same window, same origin)
 *   page → bridge   { type: "lumen-clip-v2:ack", url }
 *   desktop         `lumen-deep-link` CustomEvent, detail = "lumen://clip?data=<json>"
 *   fallback        `#clip=<json>` in the address
 */
import type { ClipPayload } from "./clipV2";

export const CLIP_MESSAGE = "lumen-clip-v2";

export function startClipBridge(onClip: (p: ClipPayload) => void): () => void {
  const deliver = async (raw: unknown, kind: "payload" | "deep" | "hash") => {
    const m = await import("./clipV2");
    const p = kind === "payload" ? m.parsePayload(raw) : kind === "deep" ? m.parseDeepLink(String(raw ?? "")) : m.takeHashPayload();
    if (!p) return;
    onClip(p);
    if (kind === "payload") window.postMessage({ type: `${CLIP_MESSAGE}:ack`, url: p.url }, location.origin);
  };
  const onMessage = (e: MessageEvent) => {
    // The bridge content script shares this window and posts with its origin.
    if (e.source !== window || e.origin !== location.origin) return;
    const d = e.data as { type?: unknown; payload?: unknown } | null;
    if (d && d.type === CLIP_MESSAGE) void deliver(d.payload, "payload");
  };
  const onDeep = (e: Event) => void deliver((e as CustomEvent).detail, "deep");
  window.addEventListener("message", onMessage);
  window.addEventListener("lumen-deep-link", onDeep);
  if (/[#&]clip=/.test(location.hash)) void deliver(null, "hash");
  // Desktop: the Rust shell emits `lumen-deep-link` with the lumen:// URL.
  let offTauri: (() => void) | undefined;
  let stopped = false;
  if ("__TAURI_INTERNALS__" in window) {
    void import("@tauri-apps/api/event")
      .then(({ listen }) => listen<string>("lumen-deep-link", (e) => void deliver(e.payload, "deep")))
      .then((off) => (stopped ? off() : (offTauri = off)))
      .catch(() => undefined);
  }
  document.documentElement.dataset.lumenClipReady = "1";
  return () => {
    stopped = true;
    offTauri?.();
    window.removeEventListener("message", onMessage);
    window.removeEventListener("lumen-deep-link", onDeep);
    delete document.documentElement.dataset.lumenClipReady;
  };
}
