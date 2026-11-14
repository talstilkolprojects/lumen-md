// @vitest-environment node
/**
 * Plan 0.20 — Vercel gets the deployment's endpoint origins. vercel.ts runs
 * at build time, loads deploy/vercel.base.json (rendered from
 * security/policy.json) and fills the app policy's placeholder. These tests
 * emulate Vercel's header matching on the generated config: a worker that
 * calls a configured endpoint is not blocked by the header.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { ENDPOINT_ENV_VARS as VITE_VARS, endpointOrigins as viteOrigins } from "../build/cspEndpoints";
import { ENDPOINT_ENV_VARS, PLACEHOLDER, endpointOrigins, vercelConfig } from "../../vercel";
// @ts-expect-error — plain .mjs script without type declarations
import { loadPolicy, renderCsp } from "../../scripts/headers.mjs";

const ROOT = resolve(__dirname, "..", "..");
const base = JSON.parse(readFileSync(join(ROOT, "deploy/vercel.base.json"), "utf8"));
const policy = loadPolicy(ROOT);

type Entry = { source: string; headers: { key: string; value: string }[] };

/** The headers Vercel sends for `path`: every matching entry, later ones winning. */
function served(config: { headers?: Entry[] }, path: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const e of config.headers ?? []) {
    if (!new RegExp(`^${e.source}$`).test(path)) continue;
    for (const h of e.headers) out.set(h.key.toLowerCase(), h.value);
  }
  return out;
}

const connectSrc = (csp: string) =>
  csp
    .split(";")
    .map((p) => p.trim().split(/\s+/))
    .find(([d]) => d === "connect-src")
    ?.slice(1) ?? [];

const ENV = {
  VITE_PUBLISH_ENDPOINT: "https://publish.lumen-test.dev/v1/publish",
  VITE_SUPABASE_URL: "https://abcd.supabase.co",
  VITE_LANGUAGETOOL_URL: "http://lt.lan:8081/v2",
  VITE_CSP_CONNECT_EXTRA: "wss://sync.lumen-test.dev, https://ollama.lan:11434",
  VITE_AUDIT_ENDPOINT: "https://audit.example.com",
};

describe("vercel.ts", () => {
  it("uses the same endpoint variables and rules as the Vite build", () => {
    expect(ENDPOINT_ENV_VARS).toEqual([...VITE_VARS]);
    for (const env of [ENV, {}, { VITE_WORKOS_ENDPOINT: "not a url" }, { VITE_BILLING_ENDPOINT: "https://your-billing.workers.dev" }]) {
      expect(endpointOrigins(env)).toEqual(viteOrigins(env));
    }
  });

  it("puts the endpoint origins in the app policy for pages, workers and the service worker", () => {
    const config = vercelConfig(base, endpointOrigins(ENV));
    const paths = [
      ...policy.routes.app.samples,
      "/assets/search.worker-AbC123.js",
      "/assets/webllm.worker-AbC123.js",
      "/assets/transformers.worker-AbC123.js",
      "/sw.js",
    ];
    for (const path of paths) {
      const csp = served(config, path).get("content-security-policy") ?? "";
      const connect = connectSrc(csp);
      for (const origin of ["https://publish.lumen-test.dev", "https://abcd.supabase.co", "http://lt.lan:8081", "wss://sync.lumen-test.dev", "https://ollama.lan:11434"]) {
        expect(connect, `${path}: ${origin}`).toContain(origin);
      }
      expect(connect).not.toContain("https://audit.example.com"); // placeholder hosts are ignored
      expect(csp).not.toContain(PLACEHOLDER);
    }
  });

  it("leaves no placeholder and the policy's own value when nothing is configured", () => {
    const config = vercelConfig(base, endpointOrigins({}));
    expect(JSON.stringify(config)).not.toContain(PLACEHOLDER);
    const app = renderCsp(policy, "app", "vercel")
      .replace(` ${PLACEHOLDER}`, "");
    expect(served(config, "/").get("content-security-policy")).toBe(app);
  });

  it("changes nothing but the placeholder: other routes and headers are as rendered", () => {
    const config = vercelConfig(base, endpointOrigins(ENV));
    const { $schema: _schema, headers: baseHeaders, ...rest } = base;
    const { headers, ...restOut } = config;
    expect(restOut).toEqual(rest);
    for (const [i, entry] of (baseHeaders as Entry[]).entries()) {
      for (const [j, h] of entry.headers.entries()) {
        if (!h.value.includes(PLACEHOLDER)) expect(headers![i].headers[j]).toEqual(h);
      }
    }
    // The runners and the eval / OCR workers keep their own policies.
    for (const route of ["playground-runner", "livejs-runner", "tesseract", "eval-workers"]) {
      for (const sample of policy.routes[route].samples) {
        expect(served(config, sample).get("content-security-policy")).toBe(renderCsp(policy, route, "vercel"));
      }
    }
  });

  it("is what Vercel reads: no static vercel.json next to it", () => {
    expect(() => readFileSync(join(ROOT, "vercel.json"))).toThrow();
  });
});
