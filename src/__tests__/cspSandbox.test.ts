/** T48 — the live-js runner's policy and the deploy security headers. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(__dirname, "..", "..");
const headers = readFileSync(join(root, "public/_headers"), "utf8");
const vercel = JSON.parse(readFileSync(join(root, "deploy/vercel.base.json"), "utf8")) as {
  headers: { source: string; headers: { key: string; value: string }[] }[];
};
const tauri = JSON.parse(readFileSync(join(root, "src-tauri/tauri.conf.json"), "utf8"));

function vercelHeader(source: string, key: string): string | undefined {
  return vercel.headers.find((h) => h.source === source)?.headers.find((x) => x.key === key)?.value;
}

describe("live-js runner CSP", () => {
  const block = headers.slice(headers.indexOf("/livejs-runner.html"));
  const csp = /Content-Security-Policy: (.*)/.exec(block)?.[1] ?? "";

  it("Cloudflare: no network, no framing by others, own policy instead of the app's", () => {
    expect(block).toMatch(/! Content-Security-Policy/);
    expect(block).toMatch(/! X-Frame-Options/);
    expect(csp).toContain("connect-src 'none'");
    expect(csp).toContain("frame-ancestors 'self'");
    expect(csp).toContain("default-src 'none'");
  });

  it("Vercel serves the same runner policy", () => {
    expect(vercelHeader("/livejs-runner.html", "Content-Security-Policy")).toBe(csp);
  });

  it("nginx serves the same runner policy", () => {
    const nginx = readFileSync(join(root, "deploy/nginx.conf"), "utf8");
    const loc = nginx.slice(nginx.indexOf("location = /livejs-runner.html"));
    expect(/Content-Security-Policy "([^"]*)"/.exec(loc)?.[1]).toBe(csp);
  });

  it("the runner page carries the policy itself (dev, Tauri, Capacitor serve no header)", () => {
    const html = readFileSync(join(root, "livejs-runner.html"), "utf8");
    const meta = /http-equiv="Content-Security-Policy" content="([^"]*)"/.exec(html)?.[1] ?? "";
    // frame-ancestors is ignored in <meta>; everything else must match.
    expect(meta).toBe(csp.replace(/ frame-ancestors 'self';/, ""));
  });

  it("build-time endpoint origins never widen connect-src 'none'", async () => {
    const { addConnectSrc, extendIndexHtmlCsp } = await import("../build/cspEndpoints");
    expect(addConnectSrc(csp, ["https://ai.example"])).toBe(csp);
    const html = readFileSync(join(root, "livejs-runner.html"), "utf8");
    expect(extendIndexHtmlCsp(html, ["https://ai.example"])).toBe(html);
    expect(addConnectSrc("connect-src 'self'", ["https://ai.example"])).toBe("connect-src 'self' https://ai.example");
  });
});

describe("Vercel security headers", () => {
  it("sends HSTS, nosniff, referrer and permissions policies everywhere", () => {
    for (const key of ["Strict-Transport-Security", "X-Content-Type-Options", "Referrer-Policy", "Permissions-Policy"]) {
      expect(vercelHeader("/(.*)", key)).toBeTruthy();
    }
  });

  it("frames and CSP for the app exclude the two runner pages", () => {
    const entry = vercel.headers.find((h) => h.headers.some((x) => x.key === "X-Frame-Options"))!;
    const re = new RegExp(`^${entry.source}$`);
    expect(re.test("/index.html")).toBe(true);
    expect(re.test("/livejs-runner.html")).toBe(false);
    expect(re.test("/playground-runner.html")).toBe(false);
    const csp = entry.headers.find((x) => x.key === "Content-Security-Policy")!.value;
    expect(csp).toContain("frame-ancestors 'none'");
    expect(csp).toContain("object-src 'none'");
  });
});

describe("Tauri CSP", () => {
  const csp: string = tauri.app?.security?.csp ?? tauri.tauri?.security?.csp;
  it("no inline scripts; objects and foreign bases blocked", () => {
    const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(script).not.toContain("'unsafe-inline'");
    expect(/default-src ([^;]*)/.exec(csp)?.[1]).not.toContain("'unsafe-inline'");
    expect(csp).toContain("object-src 'none'");
  });
  it("no eval either: Tauri sends this policy with .html assets only, so workers keep theirs", () => {
    const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
    expect(script.split(/\s+/)).toContain("'wasm-unsafe-eval'");
    expect(script.split(/\s+/)).not.toContain("'unsafe-eval'");
  });
  it("allows Tauri 2's IPC protocol", () => {
    const connect = (/connect-src ([^;]*)/.exec(csp)?.[1] ?? "").split(/\s+/);
    expect(connect).toEqual(expect.arrayContaining(["ipc:", "http://ipc.localhost"]));
  });
  const directive = (policy: string, name: string) =>
    (new RegExp(`(?:^|;)\\s*${name} ([^;]*)`).exec(policy)?.[1] ?? "").split(/\s+/).filter(Boolean);
  it("no open scheme in any fetch directive (plan 2.1): self plus known hosts only", () => {
    for (const d of ["default-src", "connect-src", "img-src", "media-src", "frame-src", "font-src", "style-src", "script-src", "worker-src"]) {
      const open = directive(csp, d).filter((s) => ["https:", "http:", "*", "ws:", "wss:"].includes(s));
      expect(open, d).toEqual([]);
    }
  });
  it("connect-src is the page's explicit list, without webR's jsDelivr fallback, plus the IPC protocol", () => {
    const html = readFileSync(join(root, "index.html"), "utf8");
    const meta = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/.exec(html)![1];
    // The web page keeps https://cdn.jsdelivr.net for webR's packages; the desktop
    // app never loads them from there (security/policy.json, review 13.5).
    expect(directive(meta, "connect-src")).toContain("https://cdn.jsdelivr.net");
    const expected = directive(meta, "connect-src").filter((s) => s !== "https://cdn.jsdelivr.net");
    expect(directive(csp, "connect-src")).toEqual([...expected, "ipc:", "http://ipc.localhost"]);
  });
  it("img-src keeps the hosts the app itself loads images from", () => {
    expect(directive(csp, "img-src")).toEqual(
      expect.arrayContaining(["'self'", "data:", "blob:", "https://*.tile.openstreetmap.org"]),
    );
    expect(directive(csp, "media-src")).toEqual(["'self'", "blob:"]);
  });
});

describe("no eval on the page (F4 / P3)", () => {
  const indexHtml = readFileSync(join(root, "index.html"), "utf8");
  const pageCsp = /Content-Security-Policy: (default-src 'self'.*)/.exec(headers)?.[1] ?? "";
  it("the page CSP allows WebAssembly but not eval — meta, Cloudflare and Vercel", () => {
    for (const csp of [pageCsp, /content="(default-src 'self'[^"]*)"/.exec(indexHtml)?.[1] ?? ""]) {
      const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
      expect(script).toContain("'wasm-unsafe-eval'");
      expect(script.split(/\s+/)).not.toContain("'unsafe-eval'");
    }
    const vercelApp = vercel.headers.find((h) => h.headers.some((x) => x.key === "X-Frame-Options"))!;
    expect(vercelApp.headers.find((x) => x.key === "Content-Security-Policy")!.value.split(/\s+/)).not.toContain("'unsafe-eval';");
  });
  it("the nginx image's page policy allows no eval", () => {
    for (const [file, block] of [["deploy/nginx.conf", /^http \{/m]] as const) {
      const text = readFileSync(join(root, file), "utf8");
      const csp = /add_header Content-Security-Policy "([^"]*)"/.exec(text.slice(text.search(block)))?.[1] ?? "";
      const script = /script-src ([^;]*)/.exec(csp)?.[1] ?? "";
      expect(script, file).toContain("'wasm-unsafe-eval'");
      expect(script.split(/\s+/), file).not.toContain("'unsafe-eval'");
    }
  });
  it("eval is granted only to the Graphviz, ruby, TypeScript and webR worker scripts", () => {
    for (const path of ["/assets/graphviz.worker-*", "/assets/ruby.worker-*", "/assets/tsCheck.worker-*", "/webr/*"]) {
      const block = headers.slice(headers.indexOf(`\n${path}\n`));
      expect(block, path).toMatch(/^\n\S+\n {2}! Content-Security-Policy\n/);
      expect(/Content-Security-Policy: ([^\n]*)/.exec(block)?.[1], path).toContain("'unsafe-eval'");
    }
    const entry = vercel.headers.find((h) => h.headers.some((x) => x.key === "X-Frame-Options"))!;
    const re = new RegExp(`^${entry.source}$`);
    expect(re.test("/assets/graphviz.worker-abc.js")).toBe(false);
    expect(re.test("/webr/webr-worker.js")).toBe(false);
    expect(re.test("/assets/app-abc.js")).toBe(true);
    expect(vercelHeader("/webr/(.*)", "Content-Security-Policy")).toContain("'unsafe-eval'");
  });
});
