/**
 * src/plugins/EmbedBlock.tsx — an ```embed block turns a pasted link into
 * the provider's embeddable player URL. Nothing loads until the user clicks
 * "Load"; then the player runs inside the content frame (plan W4.15), whose
 * #fragment carries the request.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup, fireEvent, waitFor } from "@testing-library/react";
import EmbedBlock from "../plugins/EmbedBlock";
import { contentFrameRequest, CONTENT_FRAME_PATH, type ContentFrameRequest } from "../lib/contentFrame";
import { __resetRemoteImagesForTests } from "../lib/remoteImages";

afterEach(() => {
  cleanup();
  __resetRemoteImagesForTests();
  localStorage.clear();
});

/** The content frame after "Load", and the request it carries (the gate loads lazily). */
async function loaded(source: string): Promise<{ el: HTMLIFrameElement; req: ContentFrameRequest }> {
  const { container } = render(<EmbedBlock source={source} />);
  const load = await screen.findByRole("button", { name: "Load" });
  expect(container.querySelector("iframe"), `${source} framed before Load`).toBeNull();
  fireEvent.click(load);
  await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
  const el = container.querySelector("iframe");
  if (!el) throw new Error(`no iframe for ${source}`);
  const src = el.getAttribute("src") ?? "";
  expect(src.startsWith(`${CONTENT_FRAME_PATH}#`)).toBe(true);
  const req = contentFrameRequest(src);
  if (!req) throw new Error(`no request in ${src}`);
  return { el, req };
}

async function frame(source: string): Promise<HTMLIFrameElement & { req: ContentFrameRequest }> {
  const { el, req } = await loaded(source);
  return Object.assign(el, { req });
}

const playerSrc = (req: ContentFrameRequest) => (req.kind === "embed" ? req.src : null);

describe("EmbedBlock", () => {
  it.each([
    ["https://www.youtube.com/watch?v=dQw4w9WgXcQ", "YouTube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://youtu.be/dQw4w9WgXcQ", "YouTube", "https://www.youtube-nocookie.com/embed/dQw4w9WgXcQ"],
    ["https://vimeo.com/76979871", "Vimeo", "https://player.vimeo.com/video/76979871"],
    ["https://www.loom.com/share/abc123", "Loom", "https://www.loom.com/embed/abc123"],
    ["https://codepen.io/someone/pen/xyzAB", "CodePen", "https://codepen.io/someone/embed/xyzAB?default-tab=result&theme-id=dark"],
    ["https://codesandbox.io/s/my-box-1", "CodeSandbox", "https://codesandbox.io/embed/my-box-1?view=preview"],
    ["https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC", "Spotify", "https://open.spotify.com/embed/track/4uLU6hMCjMI75M1A2tKUQC"],
    ["https://www.google.com/maps/embed?pb=xyz", "Google Maps", "https://www.google.com/maps/embed?pb=xyz"],
    ["https://www.google.com/maps/place/X/@32.0853,34.7818,15z", "Google Maps", "https://www.google.com/maps?q=32.0853,34.7818&z=15&output=embed"],
    ["https://www.google.com/maps/@32.0853,34.7818", "Google Maps", "https://www.google.com/maps?q=32.0853,34.7818&z=13&output=embed"],
    ["https://www.google.com/maps?q=Tel+Aviv", "Google Maps", "https://www.google.com/maps?q=Tel+Aviv&output=embed"],
    ["https://www.google.com/maps/dir", "Google Maps", "https://www.google.com/maps/dir?output=embed"],
    ["https://twitter.com/user/status/1234567890", "X (Twitter)", "https://platform.twitter.com/embed/Tweet.html?id=1234567890&theme=dark"],
    ["https://x.com/user/status/42", "X (Twitter)", "https://platform.twitter.com/embed/Tweet.html?id=42&theme=dark"],
    ["https://www.instagram.com/reel/AbC-12/", "Instagram", "https://www.instagram.com/p/AbC-12/embed/"],
    ["https://www.tiktok.com/@some.one/video/7000000000", "TikTok", "https://www.tiktok.com/embed/v2/7000000000"],
    ["https://www.reddit.com/r/typescript/comments/abc12/title", "Reddit", "https://www.redditmedia.com/r/typescript/comments/abc12/?embed=true&theme=dark"],
    ["https://www.linkedin.com/embed/feed/update/urn:li:share:123", "LinkedIn", "https://www.linkedin.com/embed/feed/update/urn:li:share:123"],
    ["https://www.linkedin.com/posts/dana_some-slug-activity-7123456789-abcd", "LinkedIn", "https://www.linkedin.com/embed/feed/update/urn:li:activity:7123456789"],
  ])("%s → %s player", async (url, title, src) => {
    const el = await frame(url);
    expect(playerSrc(el.req)).toBe(src);
    expect(el.req.kind === "embed" && el.req.title).toBe(title);
    expect(el.getAttribute("title")).toBe(title);
    expect(screen.getByText(title).tagName).toBe("SPAN");
  });

  it("a link to a site no policy frames stays a link", () => {
    const { container } = render(<EmbedBlock source={"https://example.com/page"} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(screen.queryByRole("button", { name: "Load" })).toBeNull();
    expect(container.textContent).toContain("example.com is not one of the sites Lumen can embed");
    expect(screen.getByRole("link").getAttribute("href")).toBe("https://example.com/page");
  });

  it("asks before loading, names the host, and Always allow keeps the host", async () => {
    const { container } = render(<EmbedBlock source={"https://vimeo.com/7"} />);
    fireEvent.click(await screen.findByRole("button", { name: "Always allow player.vimeo.com" }));
    expect(container.querySelector("[data-remote-frame]")).toBeNull();
    await waitFor(() => expect(container.querySelector("iframe")).not.toBeNull());
    expect(localStorage.getItem("lumen.remoteImages.allowedHosts")).toBe(JSON.stringify(["player.vimeo.com"]));
    cleanup();
    // Allowed host: the next embed from it loads with no question.
    const again = render(<EmbedBlock source={"https://vimeo.com/8"} />);
    await waitFor(() => expect(again.container.querySelector("iframe")).not.toBeNull());
    expect(again.container.querySelector("[data-remote-frame]")).toBeNull();
  });

  it("uses Figma's embed endpoint with the original URL encoded", async () => {
    const url = "https://www.figma.com/file/AbC/Design";
    expect(playerSrc((await frame(url)).req)).toBe(`https://www.figma.com/embed?embed_host=lumen&url=${encodeURIComponent(url)}`);
  });

  it("frames an OpenStreetMap view with a bounding box around the centre", async () => {
    const src = playerSrc((await frame("https://www.openstreetmap.org/#map=12/32.0853/34.7818")).req) ?? "";
    expect(src.startsWith("https://www.openstreetmap.org/export/embed.html?bbox=")).toBe(true);
    expect(src).toContain("marker=32.0853,34.7818");
  });

  it("embeds Facebook posts through the post plugin", async () => {
    const url = "https://www.facebook.com/page/posts/123";
    expect(playerSrc((await frame(url)).req)).toBe(
      `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&show_text=true&width=500`,
    );
  });

  it("a GitHub gist runs its embed script in an opaque-origin content frame", async () => {
    const el = await frame("https://gist.github.com/someone/abc123");
    expect(el.req).toEqual({ kind: "gist", user: "someone", id: "abc123" });
    expect(el.getAttribute("sandbox")?.split(" ")).not.toContain("allow-same-origin");
    expect(el.getAttribute("sandbox")?.split(" ")).toContain("allow-scripts");
  });

  it("SoundCloud gets the audio-only permissions, delegated through the content frame", async () => {
    const el = await frame("https://soundcloud.com/artist/track");
    expect(playerSrc(el.req)?.startsWith("https://w.soundcloud.com/player/?url=")).toBe(true);
    expect(el.req.kind === "embed" && el.req.allow).toBe("autoplay; encrypted-media");
    expect(el.getAttribute("allow")).toBe("autoplay; encrypted-media");
  });

  it("is sandboxed, lazy, and links to the original", async () => {
    const el = await frame("\n\n  https://vimeo.com/1  \nhttps://vimeo.com/2");
    expect(playerSrc(el.req)).toBe("https://player.vimeo.com/video/1");
    expect(el.req.kind === "embed" && el.req.referrerPolicy).toBe("strict-origin-when-cross-origin");
    expect(el.getAttribute("loading")).toBe("lazy");
    // The providers' players need their own origin; no frame opens windows (review 6 of #451).
    expect(el.getAttribute("sandbox")).toBe("allow-scripts allow-same-origin allow-presentation allow-forms");
    const open = screen.getByRole("link");
    expect(open.getAttribute("href")).toBe("https://vimeo.com/1");
    expect(open.getAttribute("rel")).toContain("noopener");
  });

  it("explains when the text is not a link", () => {
    const { container } = render(<EmbedBlock source={"not a url"} />);
    expect(container.querySelector("iframe")).toBeNull();
    expect(container.textContent).toContain("Could not recognize the embed URL.");
  });

  it("an empty block is not a link either", () => {
    const { container } = render(<EmbedBlock source={"   \n"} />);
    expect(container.querySelector("iframe")).toBeNull();
  });
});
