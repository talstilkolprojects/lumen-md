/**
 * src/plugins/EmbedBlock.tsx — an ```embed block turns a pasted link into
 * the provider's embeddable player URL inside a sandboxed iframe.
 */
import { describe, it, expect, afterEach } from "vitest";
import { render, screen, cleanup } from "@testing-library/react";
import EmbedBlock from "../plugins/EmbedBlock";

afterEach(cleanup);

function frame(source: string): HTMLIFrameElement {
  const { container } = render(<EmbedBlock source={source} />);
  const el = container.querySelector("iframe");
  if (!el) throw new Error(`no iframe for ${source}`);
  return el;
}

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
    ["https://example.com/page", "Embed", "https://example.com/page"],
  ])("%s → %s player", (url, title, src) => {
    const el = frame(url);
    expect(el.getAttribute("src")).toBe(src);
    expect(el.getAttribute("title")).toBe(title);
    expect(screen.getByText(title).tagName).toBe("SPAN");
  });

  it("uses Figma's embed endpoint with the original URL encoded", () => {
    const url = "https://www.figma.com/file/AbC/Design";
    expect(frame(url).getAttribute("src")).toBe(`https://www.figma.com/embed?embed_host=lumen&url=${encodeURIComponent(url)}`);
  });

  it("frames an OpenStreetMap view with a bounding box around the centre", () => {
    const src = frame("https://www.openstreetmap.org/#map=12/32.0853/34.7818").getAttribute("src") ?? "";
    expect(src.startsWith("https://www.openstreetmap.org/export/embed.html?bbox=")).toBe(true);
    expect(src).toContain("marker=32.0853,34.7818");
  });

  it("embeds Facebook posts through the post plugin", () => {
    const url = "https://www.facebook.com/page/posts/123";
    expect(frame(url).getAttribute("src")).toBe(
      `https://www.facebook.com/plugins/post.php?href=${encodeURIComponent(url)}&show_text=true&width=500`,
    );
  });

  it("wraps a GitHub gist in a data: page that loads the gist script", () => {
    const src = frame("https://gist.github.com/someone/abc123").getAttribute("src") ?? "";
    expect(src.startsWith("data:text/html;base64,")).toBe(true);
    expect(atob(src.slice("data:text/html;base64,".length))).toContain('src="https://gist.github.com/someone/abc123.js"');
  });

  it("SoundCloud gets the audio-only permissions", () => {
    const el = frame("https://soundcloud.com/artist/track");
    expect(el.getAttribute("src")?.startsWith("https://w.soundcloud.com/player/?url=")).toBe(true);
    expect(el.getAttribute("allow")).toBe("autoplay; encrypted-media");
  });

  it("is sandboxed, lazy, and links to the original", () => {
    const el = frame("\n\n  https://vimeo.com/1  \nhttps://vimeo.com/2");
    expect(el.getAttribute("src")).toBe("https://player.vimeo.com/video/1");
    expect(el.getAttribute("loading")).toBe("lazy");
    expect(el.getAttribute("sandbox")).toContain("allow-scripts");
    expect(el.getAttribute("referrerpolicy")).toBe("strict-origin-when-cross-origin");
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
