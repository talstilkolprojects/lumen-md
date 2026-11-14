// @vitest-environment node
/**
 * Build-time CSP extension for deployment worker origins (VITE_*_ENDPOINT).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  endpointOrigins,
  addConnectSrc,
  extendIndexHtmlCsp,
  extendHeadersFileCsp,
  ENDPOINT_ENV_VARS,
  EXTRA_CONNECT_ENV_VAR,
  WEBSOCKET_ENV_VARS,
  devServerOrigins,
  cspEndpointsPlugin,
  NGINX_PLACEHOLDER,
  addFrameSrc,
  contentFrameOrigins,
} from "../build/cspEndpoints";

const ROOT = resolve(__dirname, "..", "..");

describe("endpointOrigins", () => {
  it("collects origins of configured endpoints, deduped and sorted", () => {
    expect(
      endpointOrigins({
        VITE_WORKOS_ENDPOINT: "https://lumen-auth.acme.workers.dev",
        VITE_ENTITLEMENT_ENDPOINT: "https://billing.acme.dev/entitlements",
        VITE_BILLING_ENDPOINT: "https://billing.acme.dev",
        VITE_PUBLISH_ENDPOINT: "http://localhost:8787/p",
      }),
    ).toEqual(["http://localhost:8787", "https://billing.acme.dev", "https://lumen-auth.acme.workers.dev"]);
  });

  it("ignores empty, invalid, placeholder and non-HTTP values", () => {
    expect(
      endpointOrigins({
        VITE_WORKOS_ENDPOINT: "",
        VITE_BILLING_ENDPOINT: "not a url",
        VITE_PUBLISH_ENDPOINT: "https://your-worker.workers.dev",
        VITE_AUDIT_ENDPOINT: "https://example.com/audit",
        VITE_MARKETPLACE_URL: "ftp://files.acme.dev",
      }),
    ).toEqual([]);
  });
});

describe("collab WebSocket servers (plan 2.2: no bare ws: / wss: in the policies)", () => {
  it("adds the signaling list and the persistent server, ws/wss only", () => {
    expect(
      endpointOrigins({
        VITE_WEBRTC_SIGNALING_URL: "wss://signal.acme.dev, ws://localhost:4444/ ,https://not-a-socket.acme.dev",
        VITE_YJS_WEBSOCKET_URL: "wss://collab.acme.dev:8443/rooms",
      }),
    ).toEqual(["ws://localhost:4444", "wss://collab.acme.dev:8443", "wss://signal.acme.dev"]);
  });

  it("skips the example placeholders (.env.onprem.example)", () => {
    expect(endpointOrigins({ VITE_YJS_WEBSOCKET_URL: "wss://collab.example.com", VITE_WEBRTC_SIGNALING_URL: "" })).toEqual([]);
  });

  it("the plugin warns about an IPv6 collab server instead of adding an invalid source", () => {
    const warnings: string[] = [];
    const plugin = cspEndpointsPlugin();
    plugin.configResolved({
      env: { VITE_YJS_WEBSOCKET_URL: "ws://[::1]:1234" },
      build: { outDir: "dist" },
      root: ROOT,
      command: "build",
      logger: { warn: (m) => warnings.push(m) },
    });
    const html = plugin.transformIndexHtml(readFileSync(resolve(ROOT, "index.html"), "utf8"));
    expect(html).not.toContain("[::1]");
    expect(warnings).toEqual([expect.stringContaining("ws://[::1]:1234")]);
  });

  it("the dev server's page names its HMR socket; a build never does", () => {
    expect(devServerOrigins({ port: 5173 })).toEqual(["ws://*:5173", "wss://*:5173"]);
    expect(devServerOrigins({ port: 5173, hmr: { clientPort: 443 } })).toEqual(["ws://*:443", "wss://*:443"]);
    expect(devServerOrigins({ hmr: false })).toEqual([]);
    const html = readFileSync(resolve(ROOT, "index.html"), "utf8");
    const connect = (out: string) => out.match(/connect-src ([^;"]*)/)![1].split(" ");
    const base = { env: {}, build: { outDir: "dist" }, root: ROOT, server: { port: 5173 } };
    const dev = cspEndpointsPlugin();
    dev.configResolved({ ...base, command: "serve" });
    expect(connect(dev.transformIndexHtml(html))).toEqual(expect.arrayContaining(["ws://*:5173", "wss://*:5173"]));
    const build = cspEndpointsPlugin();
    build.configResolved({ ...base, command: "build" });
    expect(connect(build.transformIndexHtml(html)).filter((s) => s.startsWith("ws://"))).toEqual([]);
  });
});

describe("addConnectSrc", () => {
  it("appends to connect-src only, without duplicates", () => {
    const csp = "default-src 'self'; connect-src 'self' https://a.dev; img-src 'self'";
    expect(addConnectSrc(csp, ["https://b.dev", "https://a.dev"])).toBe(
      "default-src 'self'; connect-src 'self' https://a.dev https://b.dev; img-src 'self'",
    );
    expect(addConnectSrc(csp, [])).toBe(csp);
  });
});

describe("applied to the real policy files", () => {
  const origins = ["https://lumen-auth.acme.workers.dev"];
  it("index.html meta CSP gains the origin", () => {
    const html = extendIndexHtmlCsp(readFileSync(resolve(ROOT, "index.html"), "utf8"), origins);
    const csp = html.match(/http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i)![1];
    expect(csp).toMatch(/connect-src [^;]*https:\/\/lumen-auth\.acme\.workers\.dev/);
  });
  it("_headers CSP gains the origin", () => {
    const text = extendHeadersFileCsp(readFileSync(resolve(ROOT, "public/_headers"), "utf8"), origins);
    expect(text).toMatch(/Content-Security-Policy:[^\n]*connect-src [^;]*https:\/\/lumen-auth\.acme\.workers\.dev/);
  });
  it("the one image passes every endpoint variable to the build (.env* is not in the context)", () => {
    const vars = [...ENDPOINT_ENV_VARS, ...WEBSOCKET_ENV_VARS, EXTRA_CONNECT_ENV_VAR];
    const text = readFileSync(resolve(ROOT, "Dockerfile"), "utf8");
    const build = text.slice(0, text.indexOf("RUN npm run build"));
    for (const v of vars) expect(build, `Dockerfile: ARG ${v} before the build`).toMatch(new RegExp(`^ARG ${v}$`, "m"));
    expect(readFileSync(resolve(ROOT, ".dockerignore"), "utf8")).toMatch(/^\.env\*$/m);
  });

  it("nginx.conf carries the placeholder the image build fills in", () => {
    // The eval-workers include allows the app's own origin only, so it has no placeholder.
    expect(readFileSync(resolve(ROOT, "deploy/nginx.conf"), "utf8")).toContain(NGINX_PLACEHOLDER);
    expect(readFileSync(resolve(ROOT, "Dockerfile"), "utf8")).toContain(NGINX_PLACEHOLDER);
  });
});

describe("VITE_CSP_CONNECT_EXTRA", () => {
  it("adds explicitly listed origins (http/https/ws/wss) and ignores junk", async () => {
    const { endpointOrigins } = await import("../build/cspEndpoints");
    expect(
      endpointOrigins({ VITE_CSP_CONNECT_EXTRA: "http://192.168.1.20:11434, https://market.acme.dev/api wss://collab.acme.dev javascript:x nope" }),
    ).toEqual(["http://192.168.1.20:11434", "https://market.acme.dev", "wss://collab.acme.dev"]);
  });
});

describe("the error tracker (plan 12.4)", () => {
  it("is allowed only through the build's DSN: its host, without the key", () => {
    expect(endpointOrigins({ VITE_SENTRY_DSN: "https://publickey@o1234.ingest.us.sentry.io/5678" })).toEqual(["https://o1234.ingest.us.sentry.io"]);
    expect(endpointOrigins({ VITE_SENTRY_DSN: "https://key@glitchtip.acme.dev/3" })).toEqual(["https://glitchtip.acme.dev"]);
    expect(endpointOrigins({ VITE_SENTRY_DSN: "" })).toEqual([]);
  });

  it("no policy file hard-codes an error-tracker host or wildcard", () => {
    for (const file of ["index.html", "public/_headers", "deploy/vercel.base.json", "deploy/nginx.conf"]) {
      expect(readFileSync(resolve(ROOT, file), "utf8"), file).not.toMatch(/sentry|glitchtip/i);
    }
  });
});

describe("the content frame's own site (plan W6.40)", () => {
  it("takes the origin of an https: page URL, or http: on loopback; nothing else", () => {
    expect(contentFrameOrigins({ VITE_CONTENT_FRAME_URL: "https://lumen-md-frame.pages.dev/" })).toEqual(["https://lumen-md-frame.pages.dev"]);
    expect(contentFrameOrigins({ VITE_CONTENT_FRAME_URL: "http://127.0.0.1:5173/content-frame.html" })).toEqual(["http://127.0.0.1:5173"]);
    for (const bad of ["http://frame.example.org/", "https://frame.example.org/?x=1", "https://frame.example.org/#x", "https://u:p@frame.example.org/", "not a url", ""]) {
      expect(contentFrameOrigins({ VITE_CONTENT_FRAME_URL: bad }), bad).toEqual([]);
    }
  });

  it("adds it to frame-src where the policy frames the app itself, and nowhere else", () => {
    expect(addFrameSrc("default-src 'self'; frame-src 'self'", ["http://127.0.0.1:5173"])).toBe("default-src 'self'; frame-src 'self' http://127.0.0.1:5173");
    const html = '<meta http-equiv="Content-Security-Policy" content="frame-src \'self\'; connect-src \'self\'">';
    expect(extendIndexHtmlCsp(html, [], ["http://127.0.0.1:5173"])).toContain("frame-src 'self' http://127.0.0.1:5173;");
    const headers = "/*\n  Content-Security-Policy: frame-src 'self'\n/content-frame.html\n  Content-Security-Policy: frame-src https://www.youtube.com\n";
    const out = extendHeadersFileCsp(headers, [], ["http://127.0.0.1:5173"]);
    expect(out).toContain("frame-src 'self' http://127.0.0.1:5173\n");
    expect(out).toContain("frame-src https://www.youtube.com\n");
  });
});
