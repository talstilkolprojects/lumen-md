/**
 * CSP alignment gate.
 *
 * The page is served with BOTH the <meta> CSP in index.html and the
 * response-header CSP (public/_headers, served as dist/_headers by both
 * Cloudflare Pages and Netlify; deploy/vercel.base.json (Vercel, via vercel.ts); the two nginx images;
 * netlify.toml deliberately has no CSP). Browsers enforce every policy, so
 * a host has to be allowed in all of them — drift silently breaks shipped
 * features (this is how the AI providers, Drive sync and the WebGPU model
 * download were blocked). All of them are rendered from
 * security/policy.json by scripts/headers.mjs (see headersPolicy.test.ts);
 * this file checks what the app's code needs from that policy.
 *
 * Asserts:
 *  (a) every app policy (meta, Cloudflare, Vercel, both nginx images)
 *      shares the same connect-src host set;
 *  (b) every provider base URL constant in src/ai/*Provider.ts is allowed;
 *  plus Trusted Types / script-src invariants for the header policies.
 */
import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { TRUSTED_TYPES_POLICY_NAMES } from "../lib/trustedTypes";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");

type Policy = Map<string, string[]>;

function parsePolicy(csp: string): Policy {
  const out: Policy = new Map();
  for (const part of csp.split(";")) {
    const tokens = part.trim().split(/\s+/).filter(Boolean);
    if (!tokens.length) continue;
    const [name, ...values] = tokens;
    out.set(name.toLowerCase(), values);
  }
  return out;
}

function cspFromIndexHtml(): Policy {
  const m = read("index.html").match(
    /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]+)"/i,
  );
  if (!m) throw new Error("index.html: CSP meta tag not found");
  return parsePolicy(m[1]);
}

function cspFromHeadersFile(): Policy {
  const m = read("public/_headers").match(/^\s*Content-Security-Policy:\s*(.+)$/m);
  if (!m) throw new Error("public/_headers: CSP header not found");
  return parsePolicy(m[1]);
}


/** The app document's CSP in an nginx config (`location /` or the http level). */
function cspFromNginx(file: string, block: RegExp): Policy {
  const text = read(file);
  const at = text.search(block);
  if (at < 0) throw new Error(`${file}: app block not found`);
  const m = text.slice(at).match(/add_header Content-Security-Policy "([^"]+)"/);
  if (!m) throw new Error(`${file}: app CSP not found`);
  const policy = parsePolicy(m[1]);
  // The build-time placeholder for deployment worker origins isn't a host.
  const connect = policy.get("connect-src");
  if (connect) policy.set("connect-src", connect.filter((t) => t !== "__CSP_CONNECT_EXTRA__"));
  return policy;
}

function cspFromVercel(): Policy {
  const vercel = JSON.parse(read("deploy/vercel.base.json")) as { headers: { source: string; headers: { key: string; value: string }[] }[] };
  const entry = vercel.headers.find((h) => h.headers.some((x) => x.key === "X-Frame-Options"));
  const value = entry?.headers.find((x) => x.key === "Content-Security-Policy")?.value;
  if (!value) throw new Error("deploy/vercel.base.json: app CSP not found");
  const policy = parsePolicy(value);
  // The placeholder vercel.ts fills with the deployment's worker origins isn't a host.
  const connect = policy.get("connect-src");
  if (connect) policy.set("connect-src", connect.filter((t) => t !== "__CSP_CONNECT_EXTRA__"));
  return policy;
}

const POLICIES: Record<string, Policy> = {
  "index.html": cspFromIndexHtml(),
  "public/_headers": cspFromHeadersFile(),
  "deploy/vercel.base.json": cspFromVercel(),
  "deploy/nginx.conf": cspFromNginx("deploy/nginx.conf", /^http \{/m),
};
const HEADER_POLICIES = Object.keys(POLICIES).filter((f) => f !== "index.html");

const sorted = (xs: string[]) => [...new Set(xs)].sort();

/** CSP source-expression match for an absolute URL (subset of CSP3 §6.7.2). */
function sourceAllows(source: string, rawUrl: string): boolean {
  const url = new URL(rawUrl);
  if (source === "*") return /^(https?|wss?):$/.test(url.protocol);
  if (/^[a-z][a-z0-9+.-]*:$/i.test(source)) return url.protocol === source.toLowerCase();
  const m = source.match(/^(?:([a-z][a-z0-9+.-]*):\/\/)?(\*\.)?([^/:]+)(?::(\d+|\*))?(\/.*)?$/i);
  if (!m) return false;
  const [, scheme, wildcard, host, port, path] = m;
  if (scheme) {
    const upgraded =
      (scheme === "http" && url.protocol === "https:") ||
      (scheme === "ws" && url.protocol === "wss:");
    if (`${scheme}:` !== url.protocol && !upgraded) return false;
  } else if (url.protocol !== "https:" && url.protocol !== "http:") {
    return false;
  }
  if (wildcard) {
    if (!url.hostname.endsWith(`.${host}`)) return false;
  } else if (url.hostname !== host.toLowerCase()) {
    return false;
  }
  const defaultPort = url.protocol === "https:" || url.protocol === "wss:" ? "443" : "80";
  const urlPort = url.port || defaultPort;
  if (port === "*") {
    /* any */
  } else if (port) {
    if (port !== urlPort) return false;
  } else if (urlPort !== (scheme === "http" || scheme === "ws" ? "80" : defaultPort) && url.port) {
    return false;
  }
  if (path && path !== "/" && !url.pathname.startsWith(path)) return false;
  return true;
}

function connectAllows(policy: Policy, url: string): boolean {
  const list = policy.get("connect-src") ?? policy.get("default-src") ?? [];
  return list.some((s) => sourceAllows(s, url));
}

/** Base URL string constants declared in src/ai/*Provider.ts. */
function providerBaseUrls(): { file: string; url: string }[] {
  const dir = join(ROOT, "src", "ai");
  const out: { file: string; url: string }[] = [];
  for (const file of readdirSync(dir).filter((f) => /Provider\.ts$/.test(f))) {
    const text = readFileSync(join(dir, file), "utf8");
    const re = /^\s*(?:export\s+)?const\s+[A-Z][A-Z0-9_]*\s*=\s*["'`](https?:\/\/[^"'`$]+)["'`]/gm;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text)) !== null) out.push({ file, url: m[1] });
  }
  return out;
}

describe("CSP alignment", () => {
  it("netlify.toml sets no CSP of its own (it would be enforced alongside dist/_headers)", () => {
    expect(read("netlify.toml")).not.toMatch(/Content-Security-Policy\s*=/);
  });

  it("(a) every app policy shares one connect-src set", () => {
    const sets = Object.entries(POLICIES).map(([name, p]) => {
      const list = p.get("connect-src");
      expect(list, `${name} has no connect-src`).toBeDefined();
      return [name, sorted(list!)] as const;
    });
    const [, reference] = sets[0];
    for (const [name, set] of sets) expect(set, name).toEqual(reference);
  });

  it("(a) deploy/nginx.conf keeps the placeholder the image build fills in", () => {
    expect(read("deploy/nginx.conf")).toMatch(/connect-src [^"]*__CSP_CONNECT_EXTRA__/);
  });

  it("(a) connect-src lists explicit hosts, not a blanket https:/http:/ws:/wss:/*", () => {
    for (const [name, p] of Object.entries(POLICIES)) {
      const list = p.get("connect-src")!;
      expect(list.filter((s) => ["https:", "http:", "ws:", "wss:", "*"].includes(s)), name).toEqual([]);
    }
  });

  it("(a) the WebSockets the app opens are listed (plan 2.2): collab signaling", () => {
    // src/collab/yjs.ts PUBLIC_SIGNALING_FALLBACK: the public servers, used when
    // the user opts in. Deployment servers come from the build.
    const yjs = read("src/collab/yjs.ts");
    const block = /const PUBLIC_SIGNALING_FALLBACK = \[([\s\S]*?)\];/.exec(yjs)![1];
    const urls = [...block.matchAll(/"(wss?:\/\/[^"]+)"/g)].map((m) => m[1]);
    expect(urls).toContain("wss://signaling.yjs.dev");
    for (const [name, p] of Object.entries(POLICIES)) {
      for (const url of urls) expect(connectAllows(p, url), `${name} blocks ${url}`).toBe(true);
    }
  });

  const urls = providerBaseUrls();

  it("finds the provider base URL constants (sanity)", () => {
    const hosts = urls.map((u) => new URL(u.url).host);
    expect(hosts).toEqual(
      expect.arrayContaining([
        "api.anthropic.com",
        "generativelanguage.googleapis.com",
        "api.mistral.ai",
        "localhost:11434",
      ]),
    );
  });

  it.each(urls.map((u) => [u.file, u.url]))(
    "(b) %s base URL %s is allowed by every connect-src",
    (_file, url) => {
      for (const [name, p] of Object.entries(POLICIES)) {
        expect(connectAllows(p, url), `${name} blocks ${url}`).toBe(true);
      }
    },
  );

  it("(b) other first-party endpoints the app fetches are allowed", () => {
    const endpoints = [
      "https://api.openai.com/v1/chat/completions", // llm.ts, transcribe, embeddings, fineTune
      "http://127.0.0.1:11434/api/tags", // Ollama via loopback IP
      "https://api.languagetool.org/v2/check",
      "https://kroki.io/plantuml/svg",
      "https://www.sefaria.org/api/v3/texts/Genesis%201%3A1", // sources/sefaria (W5.1)
      "https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_IsraelLaw?$top=1", // sources/knesset (W7.5)
      "https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_IsraelLaw?$format=json", // V3 fallback
      "https://data.gov.il/api/3/action/datastore_search?resource_id=x", // sources/datagov (W7.6)
      "https://apis.cbs.gov.il/series/data/list?id=120010&format=json&download=false",
      "https://oauth2.googleapis.com/token",
      "https://www.googleapis.com/drive/v3/files",
      "https://api.dropboxapi.com/2/files/list_folder",
      "https://content.dropboxapi.com/2/files/upload",
      "https://github.com/login/device/code",
      "https://api.github.com/gists",
      "https://huggingface.co/mlc-ai/model/resolve/main/x.bin",
      "https://cdn-lfs.huggingface.co/repos/x",
      "https://cas-bridge.xethub.hf.co/x",
      "https://raw.githubusercontent.com/mlc-ai/binary-mlc-llm-libs/main/x.wasm",
    ];
    for (const [name, p] of Object.entries(POLICIES)) {
      for (const url of endpoints) expect(connectAllows(p, url), `${name} blocks ${url}`).toBe(true);
    }
  });

  it("no longer references unpkg (Leaflet CSS + model-viewer are self-hosted)", () => {
    for (const file of ["index.html", "public/_headers", "netlify.toml", "deploy/nginx.conf"]) {
      expect(read(file), file).not.toContain("unpkg.com");
    }
  });
});

describe("CSP script-src / Trusted Types invariants", () => {
  it("script-src is identical everywhere and has no 'unsafe-inline'", () => {
    const ref = sorted(POLICIES["index.html"].get("script-src")!);
    for (const [name, p] of Object.entries(POLICIES)) {
      const list = p.get("script-src")!;
      expect(list, name).not.toContain("'unsafe-inline'");
      expect(sorted(list), name).toEqual(ref);
    }
  });

  it("index.html has no inline executable <script> (only external + JSON data blocks)", () => {
    const html = read("index.html");
    const scripts = [...html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)];
    for (const [, attrs, body] of scripts) {
      const isData = /type="application\/(ld\+)?json"/i.test(attrs);
      const isExternal = /\bsrc=/.test(attrs) && body.trim() === "";
      expect(isData || isExternal, `inline script: <script${attrs}>`).toBe(true);
    }
    expect(html).not.toMatch(/\son[a-z]+="/i);
  });

  it.each(HEADER_POLICIES)(
    "%s enforces Trusted Types and allows exactly the app's policy names",
    (file) => {
      const p = POLICIES[file];
      expect(p.get("require-trusted-types-for")).toEqual(["'script'"]);
      const tt = p.get("trusted-types")!;
      expect(tt).toContain("'allow-duplicates'");
      expect(sorted(tt.filter((x) => !x.startsWith("'")))).toEqual(sorted([...TRUSTED_TYPES_POLICY_NAMES]));
    },
  );
});
