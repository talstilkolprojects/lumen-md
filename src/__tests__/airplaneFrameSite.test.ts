/**
 * Review t5 (L4): a deployment's own frame site (VITE_CONTENT_FRAME_URL) must keep its embeds'
 * `allow-same-origin`, as the official one does: the frame guard trusts the build's frame origin.
 */
import { afterEach, describe, expect, it } from "vitest";
import { EMBED_ORIGINS, guardedSandbox, isKnownEmbedOrigin } from "../privacy/airplaneEmbeds";
import { __setContentFrameUrl, contentFrameSandbox } from "../lib/contentFrame";
import { contentFrameOrigins } from "../build/cspEndpoints";

const base = "https://lumen.example.org/note";
const embed = contentFrameSandbox("embed", "https://frames.example.net")!;

describe("the frame guard and a self-hosted frame site (review t5, L4)", () => {
  afterEach(() => __setContentFrameUrl(undefined));

  it("keeps allow-same-origin for the build's own frame site, not for any other site", () => {
    __setContentFrameUrl("https://frames.example.net/content-frame.html");
    expect(embed).toContain("allow-same-origin");
    expect(guardedSandbox(embed, "https://frames.example.net/content-frame.html#x", base, false)).toBe(embed);
    expect(isKnownEmbedOrigin("https://frames.example.net")).toBe(true);
    expect(guardedSandbox(embed, "https://other.example.net/content-frame.html", base, false)).not.toContain("allow-same-origin");
    // The CSP side (frame-src) derives the same origin from the same variable.
    expect(contentFrameOrigins({ VITE_CONTENT_FRAME_URL: "https://frames.example.net/content-frame.html" })).toEqual(["https://frames.example.net"]);
  });

  it("without the variable only EMBED_ORIGINS are trusted; a bad URL adds nothing", () => {
    __setContentFrameUrl(null);
    expect(guardedSandbox(embed, "https://frames.example.net/content-frame.html", base, false)).not.toContain("allow-same-origin");
    expect(guardedSandbox(embed, "https://lumen-md-frame.pages.dev/", base, false)).toBe(embed);
    for (const bad of ["http://frames.example.net/", "https://frames.example.net/?x=1", "https://u:p@frames.example.net/", "not a url"]) {
      __setContentFrameUrl(bad);
      expect(isKnownEmbedOrigin("https://frames.example.net"), bad).toBe(false);
      expect(isKnownEmbedOrigin("http://frames.example.net"), bad).toBe(false);
    }
    expect(EMBED_ORIGINS.has("https://frames.example.net")).toBe(false);
  });

  it("a loopback frame site (dev, e2e) is trusted over http", () => {
    __setContentFrameUrl("http://127.0.0.1:5173/content-frame.html");
    expect(guardedSandbox(embed, "http://127.0.0.1:5173/content-frame.html", "http://localhost:5173/", false)).toBe(embed);
  });
});
