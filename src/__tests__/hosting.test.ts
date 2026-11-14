// @vitest-environment node
/**
 * Plan 13.2 — unified hosting. The "what works where" table in
 * docs/self-hosting/hosting is held to the configuration files: every host
 * gives the runner pages their own policy (Netlify through its edge
 * function), the compose bundle and Fly build the one Dockerfile with the
 * one nginx config, and the image has its slim variant.
 */
import { describe, it, expect } from "vitest";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { loadPolicy, renderCsp, run } from "../../scripts/headers.mjs";

const ROOT = resolve(__dirname, "..", "..");
const read = (f: string) => readFileSync(join(ROOT, f), "utf8");
const policy = loadPolicy(ROOT);

const HOSTS = ["Cloudflare Pages", "Netlify", "Vercel", "Docker image (compose, Fly)"];
/** Rows of the table that must be ✅ on every host. */
const EVERYWHERE = [
  "The editor under the full policy",
  "Deep links",
  "Web Playground",
  "live-js runner",
  "Workers that need eval",
  "On-device OCR",
  "Same-origin WebAssembly runtimes",
  "Your endpoint origins",
];

function table(markdown: string): Map<string, string[]> {
  const rows = new Map<string, string[]>();
  for (const line of markdown.split("\n")) {
    if (!line.startsWith("|") || /^\|\s*-/.test(line)) continue;
    const cells = line.split("|").slice(1, -1).map((c) => c.trim());
    rows.set(cells[0], cells.slice(1));
  }
  return rows;
}

describe("hosting: one policy on every host", () => {
  it("every header source matches security/policy.json", () => {
    expect(run({ root: ROOT }).problems).toEqual([]);
  });

  it("Netlify: the edge function gives both runner pages and the content frame their policy and drops the frame denial", () => {
    const fn = read("netlify/edge-functions/runner-headers.ts");
    for (const [path, route] of [
      ["/playground-runner.html", "playground-runner"],
      ["/livejs-runner.html", "livejs-runner"],
      ["/content-frame.html", "content-frame"],
    ]) {
      expect(fn).toContain(`"${path}": ${JSON.stringify(renderCsp(policy, route, "netlify"))}`);
      expect(read("netlify.toml")).toMatch(new RegExp(`path = "${path}"\\n\\s*function = "runner-headers"`));
    }
    expect(fn).toContain('headers.delete("x-frame-options")');
    expect(fn).toContain('headers.set("content-security-policy", csp)');
    expect(fn).toMatch(/export const config = \{ path: \["\/playground-runner\.html", "\/livejs-runner\.html", "\/content-frame\.html"\] \}/);
    // Netlify's own _headers sets no CSP of its own (dist/_headers does).
    expect(read("netlify.toml")).not.toMatch(/Content-Security-Policy/i);
  });

  it("one image: compose and Fly build the root Dockerfile with deploy/nginx.conf", () => {
    expect(existsSync(join(ROOT, "docker/Dockerfile.web"))).toBe(false);
    expect(existsSync(join(ROOT, "docker/nginx.conf"))).toBe(false);
    expect(read("docker-compose.yml")).toMatch(/dockerfile: Dockerfile\n/);
    expect(read("docker-compose.yml")).toMatch(/- "80:8080"/);
    expect(read("fly.toml")).toMatch(/dockerfile = "Dockerfile"/);
    const docker = read("Dockerfile");
    expect(docker).toContain("COPY deploy/nginx.conf /etc/nginx/nginx.conf");
    expect(docker).toContain("COPY deploy/lumen-runtime-headers.conf /etc/nginx/lumen-runtime-headers.conf");
    expect(read("deploy/nginx.conf")).toMatch(/listen 8080;/);
    const sources = Object.values(policy.sources as Record<string, { format: string; host: string }>);
    expect(sources.filter((s) => s.format === "nginx").map((s) => s.host)).toEqual(["deploy-nginx", "deploy-nginx"]);
  });

  it("the image's slim variant drops exactly the same-origin runtimes the copy scripts stage", () => {
    const docker = read("Dockerfile");
    expect(docker).toMatch(/^ARG LUMEN_RUNTIMES=full$/m);
    const slim = /slim\) rm -rf ([^;]*);;/.exec(docker)?.[1].trim().split(/\s+/) ?? [];
    const staged = read("package.json")
      .match(/"prebuild": "([^"]*)"/)![1]
      .split("&&")
      .map((s) => /copy-([\w-]+)\.mjs/.exec(s)?.[1])
      // What slim keeps, being the editor rather than a runtime: the
      // playground's vendor files, the plugin engine (QuickJS, ~0.5 MB; plugins
      // are an editor feature) and the canvas fonts (Excalidraw).
      .filter((s): s is string => !!s && !["playground-vendor", "quickjs", "excalidraw"].includes(s));
    expect(slim.sort()).toEqual(staged.map((s) => `dist/${s}`).sort());
    expect(read("docker-compose.yml")).toMatch(/LUMEN_RUNTIMES: \$\{LUMEN_RUNTIMES:-full\}/);
    expect(read(".env.onprem.example")).toMatch(/^LUMEN_RUNTIMES=full$/m);
  });

  it("the docs table says what the configuration does, in English and Hebrew", () => {
    const en = table(read("docs/src/content/docs/self-hosting/hosting.md"));
    const he = table(read("docs/src/content/docs/he/self-hosting/hosting.md"));
    expect([...en.keys()][0]).toBe("Capability");
    expect(en.get("Capability")).toEqual(HOSTS);
    for (const row of EVERYWHERE) {
      const key = [...en.keys()].find((k) => k.startsWith(row));
      expect(key, row).toBeDefined();
      expect(en.get(key!)!.map((c) => c.startsWith("✅")), `${row}: every host`).toEqual(HOSTS.map(() => true));
    }
    // The two documented differences.
    const hsts = en.get("HSTS")!;
    expect(hsts.map((c) => c.startsWith("✅"))).toEqual([true, true, true, false]);
    const coop = [...en.keys()].find((k) => k.startsWith("Cross-origin isolation"))!;
    expect(en.get(coop)!.map((c) => c.startsWith("✅"))).toEqual([false, false, false, true]);
    expect(policy.headers["Strict-Transport-Security"].hosts).not.toContain("deploy-nginx");
    expect(policy.headers["Cross-Origin-Opener-Policy"].hosts).toEqual(["deploy-nginx"]);
    // Same shape in Hebrew: the same number of rows and the same ✅ / — pattern per row.
    const pattern = (t: Map<string, string[]>) => [...t.values()].slice(1).map((cells) => cells.map((c) => c.startsWith("✅")));
    expect(pattern(he).slice(0, pattern(en).length)).toEqual(pattern(en));
    expect(read("docs/astro.config.mjs")).toContain('slug: "self-hosting/hosting"');
  });
});
