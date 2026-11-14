/**
 * Plan W8.7: one source for the embed providers. security/policy.json's
 * embedProviders is rendered into every frame-src, read by the embed block
 * and by the airplane switch; `npm run headers` fails a second list.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
// @ts-expect-error — plain .mjs script, no type declarations
import { directivesFor, embedProviderProblems, EMBED_PROVIDERS, run } from "../../scripts/headers.mjs";
import { EMBED_ORIGINS, isEmbedProvider } from "../lib/embedProviders";
import { EMBED_ORIGINS as AIRPLANE_ORIGINS } from "../privacy/airplane";
import { embedFor } from "../plugins/embedUrl";

const ROOT = process.cwd();
const policy = JSON.parse(readFileSync(resolve(ROOT, "security/policy.json"), "utf8"));
const clone = () => JSON.parse(JSON.stringify(policy));
const httpsOf = (list: string[]) => list.filter((t) => t.startsWith("https://")).sort();

describe("embed providers: one list (W8.7)", () => {
  it("the policy's frame-src names the list, and the app, the airplane switch and public/_headers have exactly it", () => {
    expect(policy.routes.app.csp["frame-src"]).toContain(EMBED_PROVIDERS);
    const list = [...policy.embedProviders].sort();
    expect([...EMBED_ORIGINS].sort()).toEqual(list);
    expect(AIRPLANE_ORIGINS).toBe(EMBED_ORIGINS);
    const headers = readFileSync(resolve(ROOT, "public/_headers"), "utf8");
    const frameSrc = /frame-src ([^;]+);/.exec(headers)?.[1] ?? "";
    expect(httpsOf(frameSrc.split(" "))).toEqual(list);
    for (const host of ["vercel", "cloudflare", "netlify", "deploy-nginx", "meta", "tauri"]) {
      if (!policy.hosts?.[host]) continue;
      expect(httpsOf((directivesFor(policy, "app", host) as Map<string, string[]>).get("frame-src") ?? []), host).toEqual(list);
    }
  });

  it("every frame the embed block makes is on the list; a site outside it gets no frame", () => {
    const links = [
      "https://www.youtube.com/watch?v=dQw4w9WgXcQ",
      "https://vimeo.com/76979871",
      "https://www.loom.com/share/abc123",
      "https://codepen.io/someone/pen/xyzAB",
      "https://codesandbox.io/s/my-box-1",
      "https://www.figma.com/file/AbC/Design",
      "https://open.spotify.com/track/4uLU6hMCjMI75M1A2tKUQC",
      "https://www.google.com/maps?q=Tel+Aviv",
      "https://www.openstreetmap.org/#map=12/32.0853/34.7818",
      "https://twitter.com/user/status/1234567890",
      "https://www.facebook.com/page/posts/123",
      "https://www.instagram.com/reel/AbC-12/",
      "https://www.tiktok.com/@some.one/video/7000000000",
      "https://www.reddit.com/r/typescript/comments/abc12/title",
      "https://www.linkedin.com/embed/feed/update/urn:li:share:123",
      "https://soundcloud.com/artist/track",
    ];
    for (const link of links) {
      const e = embedFor(link);
      expect(e, link).not.toBeNull();
      expect(isEmbedProvider(e!.src), `${link} → ${e!.src}`).toBe(true);
    }
    expect(embedFor("https://gist.github.com/someone/abc123")?.src.startsWith("data:text/html;base64,")).toBe(true);
    for (const link of ["https://example.com/page", "http://www.youtube.com/embed/x", "https://www.google.co.il/maps/embed?pb=1", "https://evil.example/www.youtube.com"]) {
      expect(embedFor(link), link).toBeNull();
    }
  });

  it("headers --check fails a gap: an https site named in frame-src itself, or added by a host rule", () => {
    expect(embedProviderProblems(policy)).toEqual([]);
    const own = clone();
    own.routes.app.csp["frame-src"].push("https://example.com");
    const a = run({ root: ROOT, policy: own }).problems as string[];
    expect(a.some((p) => p.includes("frame-src names https://example.com itself"))).toBe(true);
    const host = clone();
    host.hosts.vercel.csp = [...(host.hosts.vercel.csp ?? []), { routes: ["app"], add: { "frame-src": ["https://example.com"] } }];
    expect((run({ root: ROOT, policy: host }).problems as string[]).some((p) => p.includes("adds https://example.com to frame-src"))).toBe(true);
  });

  it("headers --check fails when the list and the rendered headers part: a provider added to the list but not rendered", () => {
    const more = clone();
    more.embedProviders.push("https://www.example.org");
    const problems = run({ root: ROOT, policy: more }).problems as string[];
    expect(problems.length).toBeGreaterThan(0);
    expect(problems.join("\n")).toContain("https://www.example.org");
  });

  it("the list holds bare https origins, once each", () => {
    for (const bad of [["https://www.youtube.com/embed"], ["http://player.vimeo.com"], ["https://codepen.io", "https://codepen.io"], []]) {
      const p = clone();
      p.embedProviders = bad;
      expect(embedProviderProblems(p).length, JSON.stringify(bad)).toBeGreaterThan(0);
    }
  });
});
