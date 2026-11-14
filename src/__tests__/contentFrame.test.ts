// @vitest-environment node
/**
 * Plan W4.15 — a tighter app CSP and the content frame that takes over what
 * it no longer allows.
 *
 *   - the app policy has no `https:` in img-src / media-src on any host,
 *     and frame-src is 'self' alone (acceptance: ≤ 3 sources);
 *   - /content-frame.html gets its own policy on every host, framed by the
 *     app only, and frames every provider the embed block produces;
 *   - the hosts the app no longer contacts are gone from connect-src.
 *
 * src/lib/contentFrame.ts itself: contentFrameDom.test.ts.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join } from "node:path";
// @ts-expect-error — plain .mjs build script without types
import { loadPolicy, renderCsp, renderMeta, parseCsp } from "../../scripts/headers.mjs";

const root = join(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(root, f), "utf8");
type Policy = ReturnType<typeof loadPolicy>;
const policy: Policy = loadPolicy(root);
const directives = (route: string, host: string): Map<string, string[]> => parseCsp(renderCsp(policy, route, host));

const WEB_HOSTS = ["cloudflare", "vercel", "deploy-nginx", "meta"];

/** The inline scripts of an HTML page: [attributes, text]. */
const inlineScripts = (html: string) => [...html.matchAll(/<script([^>]*)>([\s\S]*?)<\/script>/g)].map((m) => ({ attrs: m[1], text: m[2] }));
/** A CSP hash-source of `text`, as a browser computes it (UTF-8, base64). */
const sha256Source = (text: string) => `'sha256-${createHash("sha256").update(text, "utf8").digest("base64")}'`;

describe("the app policy (plan W4.15 acceptance)", () => {
  it.each([...WEB_HOSTS, "tauri"])("%s: no https: in img-src or media-src", (host) => {
    const d = directives("app", host);
    expect(d.get("img-src"), host).not.toContain("https:");
    expect(d.get("media-src"), host).not.toContain("https:");
    expect(d.get("img-src")).toEqual(["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org", "https://avatars.githubusercontent.com", "https://*.googleusercontent.com"]);
    expect(d.get("media-src")).toEqual(["'self'", "blob:"]);
  });

  it.each(WEB_HOSTS)("%s: frame-src is 'self' and the content frame's own site (≤ 3 sources, W6.40)", (host) => {
    const frame = directives("app", host).get("frame-src")!;
    expect(frame.length).toBeLessThanOrEqual(3);
    expect(frame).toEqual(["'self'", "https://lumen-md-frame.pages.dev"]);
  });

  it("connect-src no longer lists hosts the app does not use", () => {
    for (const host of [...WEB_HOSTS, "tauri"]) {
      const connect = directives("app", host).get("connect-src")!;
      for (const gone of [
        "wss://y-webrtc-signaling-eu.herokuapp.com",
        "https://cdn-lfs.huggingface.co",
        "https://www.gstatic.com",
        "https://*.supabase.co",
      ]) {
        expect(connect, `${host}: ${gone}`).not.toContain(gone);
      }
      // Covered by the wildcard; the fonts stay for the service worker's runtime cache.
      for (const kept of ["https://*.huggingface.co", "https://fonts.googleapis.com", "https://fonts.gstatic.com"]) expect(connect, `${host}: ${kept}`).toContain(kept);
    }
  });

  it("the public signaling servers are the ones y-webrtc itself uses, and both are listed", () => {
    const block = /const PUBLIC_SIGNALING_FALLBACK = \[([\s\S]*?)\];/.exec(read("src/collab/yjs.ts"))![1];
    const urls = [...block.matchAll(/"(wss:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(urls).toEqual(["wss://signaling.yjs.dev", "wss://y-webrtc-eu.fly.dev"]);
    for (const u of urls) expect(directives("app", "cloudflare").get("connect-src")).toContain(u);
  });
});

/** The player origins src/plugins/EmbedBlock.tsx produces (one per provider). */
const PROVIDERS = [
  "https://www.youtube-nocookie.com",
  "https://player.vimeo.com",
  "https://www.loom.com",
  "https://codepen.io",
  "https://codesandbox.io",
  "https://www.figma.com",
  "https://open.spotify.com",
  "https://www.google.com",
  "https://www.openstreetmap.org",
  "https://platform.twitter.com",
  "https://www.facebook.com",
  "https://www.instagram.com",
  "https://www.tiktok.com",
  "https://www.redditmedia.com",
  "https://www.linkedin.com",
  "https://w.soundcloud.com",
];

describe("the content frame's own policy", () => {
  it("is a frameable document, framed by the app only, with no network and no eval", () => {
    const def = policy.routes["content-frame"];
    expect(def.kind).toBe("document");
    expect(def.frameable).toBe(true);
    const d = directives("content-frame", "cloudflare");
    expect(d.get("frame-ancestors")).toEqual(["'self'"]);
    expect(d.get("default-src")).toEqual(["'none'"]);
    expect(d.get("connect-src")).toEqual(["'none'"]);
    // Its one inline script by hash and the Gist host — no 'self', no nonce (W10.D1).
    const html = read("public/content-frame.html");
    expect(d.get("script-src")).toEqual([...inlineScripts(html).map((s) => sha256Source(s.text)), "https://gist.github.com"]);
    expect(d.get("img-src")).toContain("https:");
    expect(d.get("media-src")).toContain("https:");
  });

  it("on the app's hosts it is sandboxed by its own header, so it never runs with the app's origin, even opened top-level (W6.40)", () => {
    for (const host of ["cloudflare", "vercel", "netlify", "deploy-nginx"]) {
      const sandbox = directives("content-frame", host).get("sandbox");
      expect(sandbox, host).toEqual(["allow-scripts", "allow-popups", "allow-popups-to-escape-sandbox"]);
    }
    // <meta> can't carry sandbox (CSP3 ignores it there): the header does it.
    expect(directives("content-frame", "meta").has("sandbox")).toBe(false);
  });

  it("its own site serves it unsandboxed, framed only by the apps, with no frame denial (W6.40)", () => {
    const d = directives("content-frame", "content-frame-site");
    expect(d.has("sandbox")).toBe(false);
    expect(d.get("frame-ancestors")).toEqual(["https://lumen-md.vercel.app", "https://lumen-md.pages.dev", "tauri://localhost", "http://tauri.localhost", "capacitor://localhost", "https://localhost"]);
    expect(d.get("connect-src")).toEqual(["'none'"]);
    const file = read("deploy/content-frame/_headers");
    // One block for the whole site: it holds only the frame's page (served at /) and its script.
    expect(file.match(/^[^\s#].*$/gm)).toEqual(["/*"]);
    expect(/Content-Security-Policy: (.+)/.exec(file)![1]).toBe(renderCsp(policy, "content-frame", "content-frame-site"));
    expect(file).not.toContain("X-Frame-Options");
  });

  it("frames every provider the embed block produces, and nothing open", () => {
    const frame = directives("content-frame", "cloudflare").get("frame-src")!;
    for (const p of PROVIDERS) expect(frame, p).toContain(p);
    expect(frame.filter((s) => ["https:", "http:", "*", "data:", "blob:"].includes(s))).toEqual([]);
  });

  it("the desktop policy frames the same providers (Tauri sends it with every .html asset)", () => {
    const frame = directives("app", "tauri").get("frame-src")!;
    for (const p of PROVIDERS) expect(frame, p).toContain(p);
    expect(directives("app", "tauri").get("script-src")).not.toContain("https://gist.github.com");
  });

  it("every host serves it its own policy without the app's frame denial", () => {
    const headers = read("public/_headers");
    const block = headers.slice(headers.indexOf("\n/content-frame.html\n"));
    expect(block).toMatch(/^\n\/content-frame\.html\n {2}! Content-Security-Policy\n {2}! X-Frame-Options\n {2}Content-Security-Policy: (.+)\n/);
    expect(/Content-Security-Policy: (.+)/.exec(block)![1]).toBe(renderCsp(policy, "content-frame", "cloudflare"));

    const vercel = JSON.parse(read("deploy/vercel.base.json")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
    const own = vercel.headers.find((h) => h.source === "/content-frame.html")!;
    expect(own.headers.find((h) => h.key === "Content-Security-Policy")!.value).toBe(renderCsp(policy, "content-frame", "vercel"));
    for (const h of vercel.headers.filter((x) => x.headers.some((y) => y.key === "X-Frame-Options"))) {
      expect(new RegExp(`^${h.source}$`).test("/content-frame.html"), h.source).toBe(false);
    }

    const nginx = read("deploy/nginx.conf");
    const loc = nginx.slice(nginx.indexOf("location = /content-frame.html {"));
    const body = loc.slice(0, loc.indexOf("}"));
    expect(body).toContain(`add_header Content-Security-Policy "${renderCsp(policy, "content-frame", "deploy-nginx")}" always;`);
    expect(body).not.toContain("X-Frame-Options");

    expect(read("netlify.toml")).toMatch(/\[\[edge_functions\]\]\n {2}path = "\/content-frame\.html"\n {2}function = "runner-headers"/);
    expect(read("netlify/edge-functions/runner-headers.ts")).toContain('"/content-frame.html"');

    const html = read("public/content-frame.html");
    expect(/<meta http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(html)![1]).toBe(renderMeta(policy, "content-frame"));
    // One classic inline script (a Gist needs document.write), with no src and no nonce.
    const scripts = inlineScripts(html);
    expect(scripts).toHaveLength(1);
    expect(scripts[0].attrs).toBe("");
  });

  it("allows its script by the script's own sha256 on every host and in the meta copy, and by no nonce (W10.D1)", () => {
    const [script] = inlineScripts(read("public/content-frame.html"));
    const hash = sha256Source(script.text);
    for (const host of ["cloudflare", "vercel", "netlify", "deploy-nginx", "content-frame-site", "meta"]) {
      const src = directives("content-frame", host).get("script-src")!;
      expect(src, host).toContain(hash);
      expect(src.filter((s) => s.startsWith("'nonce-")), host).toEqual([]);
      // Nothing else of this origin: the hash is the only script of ours that runs.
      expect(src, host).not.toContain("'self'");
      expect(src.filter((s) => s.startsWith("'sha")), host).toEqual([hash]);
    }
    // A changed script no longer matches: the hash is of the text, byte for byte.
    expect(sha256Source(script.text + " ")).not.toBe(hash);
    // The frame site serves the page only; the script is not a file of its own any more.
    expect(existsSync(join(root, "public/content-frame.js"))).toBe(false);
    expect(read("scripts/content-frame-site.mjs")).not.toMatch(/content-frame\.js/);
  });

  it("its script builds elements, never HTML, and writes a Gist only in an opaque-origin frame", () => {
    // The code, without its comments (they describe document.write too).
    const js = inlineScripts(read("public/content-frame.html"))[0].text.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
    expect(js).not.toMatch(/innerHTML|outerHTML|insertAdjacentHTML|srcdoc|\beval\(|new Function/);
    // The one document.write is the Gist script, behind the opaque-origin check.
    expect(js.match(/document\.write\(/g)).toHaveLength(1);
    expect(js).toMatch(/if \(!user \|\| !id \|\| !opaque\) return fallback/);
    expect(js).toContain('var opaque = self.origin === "null";');
  });
});
