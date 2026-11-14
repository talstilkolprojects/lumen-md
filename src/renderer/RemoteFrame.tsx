/**
 * Click-to-load for embeds (plan W4.15): the embed block and a raw <iframe>
 * in a note make no request until the user allows the embed's host, the
 * same choice as for images (src/lib/remoteImages.ts: "Load" for this one,
 * "Always allow" for the host). Then the embed renders inside the content
 * frame (src/lib/contentFrame.ts): the app's own policy frames nothing but
 * itself.
 *
 * Loaded lazily (src/renderer/components.tsx, src/plugins/EmbedBlock.tsx),
 * with its strings (./contentFrameStrings).
 */
import "./contentFrameStrings";
import { useSyncExternalStore, type CSSProperties } from "react";
import { t } from "../i18n";
import {
  allowRemoteImageHosts,
  loadRemoteImagesOnce,
  remoteContentAllowed,
  remoteImageHost,
  remoteImagesVersion,
  subscribeRemoteImages,
} from "../lib/remoteImages";
import type { ContentFrameRequest } from "../lib/contentFrame";
import ContentFrame from "./ContentFrame";

interface GateProps {
  /** The URL whose host the user allows (the provider's player URL, the iframe's src). */
  gateUrl: string;
  request: ContentFrameRequest;
  /** What the placeholder calls the embed (a provider name, an iframe title). */
  label?: string;
  /** The frame's box once it loads (the placeholder keeps its own size). */
  box?: CSSProperties;
}

export function RemoteFrameGate({ gateUrl, request, label, box }: GateProps) {
  useSyncExternalStore(subscribeRemoteImages, remoteImagesVersion, remoteImagesVersion);
  if (remoteContentAllowed(gateUrl)) {
    return box ? (
      <span style={{ display: "block", ...box }}>
        <ContentFrame request={request} />
      </span>
    ) : (
      <ContentFrame request={request} />
    );
  }
  const host = remoteImageHost(gateUrl) ?? "";
  return (
    <span className="lumen-remote-image" role="group" aria-label={t("remoteFrame.label", { host })} data-remote-frame={host}>
      <span className="lumen-remote-image-text">
        <span className="lumen-remote-image-alt" dir="auto">{label?.trim() || t("remoteFrame.label", { host })}</span>
        <span className="lumen-remote-image-host" dir="auto">{t("remoteFrame.blocked", { host })}</span>
      </span>
      <button type="button" title={t("remoteFrame.loadHint", { host })} onClick={() => loadRemoteImagesOnce([gateUrl])}>
        {t("remoteImage.load")}
      </button>
      <button type="button" title={t("remoteFrame.allowHint", { host })} onClick={() => allowRemoteImageHosts([host])}>
        {t("remoteImage.allowHost", { host })}
      </button>
    </span>
  );
}

const size = (v: unknown): number | null => {
  const n = typeof v === "number" ? v : typeof v === "string" && /^\s*\d+(?:px)?\s*$/.test(v) ? parseInt(v, 10) : NaN;
  return Number.isFinite(n) && n > 0 ? Math.min(n, 10_000) : null;
};

/**
 * A raw `<iframe src="https://…">` in a note (the sanitizer kept only
 * https sources, src/renderer/rehypeSanitizeRaw.ts): click-to-load, then
 * the content frame. Its width / height attributes size the box; a host
 * the content frame's policy does not frame stays blank there, and the
 * link under it opens the page.
 */
export default function RawFrame(props: { src?: unknown; title?: unknown; width?: unknown; height?: unknown }) {
  const src = typeof props.src === "string" ? props.src.trim() : "";
  const host = remoteImageHost(src);
  if (!/^https:\/\//i.test(src) || !host) return null;
  const title = typeof props.title === "string" && props.title.trim() ? props.title.trim() : host;
  const w = size(props.width);
  const h = size(props.height);
  return (
    <span className="lumen-raw-frame" style={{ display: "block" }}>
      <RemoteFrameGate
        gateUrl={src}
        label={title}
        request={{ kind: "embed", src, title, referrerPolicy: "no-referrer" }}
        box={{ width: w ? `${w}px` : "100%", maxWidth: "100%", aspectRatio: w && h ? `${w} / ${h}` : "16 / 9" }}
      />
    </span>
  );
}
