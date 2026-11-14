/**
 * React wrapper of the content frame (plan W4.15, src/lib/contentFrame.ts):
 * an allowed image, video, audio file, embed or Gist from another site,
 * shown inside /content-frame.html. Loaded lazily by the preview
 * (src/renderer/components.tsx) the first time one is allowed.
 *
 * The <iframe> is made by createContentFrame and mounted by an effect, so
 * the sizes the frame reports (inline styles) are never reset by a render.
 */
import { useEffect, useRef } from "react";
import { createContentFrame, type ContentFrameRequest } from "../lib/contentFrame";

export default function ContentFrame({ request }: { request: ContentFrameRequest }) {
  const host = useRef<HTMLSpanElement>(null);
  const key = JSON.stringify(request);
  useEffect(() => {
    const el = host.current;
    if (!el) return;
    el.replaceChildren(createContentFrame(JSON.parse(key) as ContentFrameRequest, el.ownerDocument));
    return () => el.replaceChildren();
  }, [key]);
  const block = request.kind !== "img";
  return (
    <span
      ref={host}
      className="lumen-content-frame"
      data-content-kind={request.kind}
      style={block ? { display: "block", width: "100%", height: request.kind === "embed" ? "100%" : undefined } : { display: "inline-block", maxWidth: "100%" }}
    />
  );
}
