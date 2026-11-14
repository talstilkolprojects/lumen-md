// @vitest-environment node
/**
 * Plan W6.9: Vercel and Cloudflare Pages serve the same headers and routes
 * (scripts/lib/hostParity.mjs, `npm run hosts:parity`).
 */
import { describe, expect, it } from "vitest";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import type { AddressInfo } from "node:net";
// @ts-expect-error -- plain .mjs script, no types
import { configReport } from "../../scripts/host-parity.mjs";
import {
  ACCEPTED,
  BUILT_FILES,
  PROBES,
  compareConfigs,
  fillVercel,
  liveProbe,
  pagesServe,
  parseHeadersRules,
  vercelServe,
  // @ts-expect-error -- plain .mjs script, no types
} from "../../scripts/lib/hostParity.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { combineCspParts, loadPolicy, parseCsp, renderCsp, renderCspParts } from "../../scripts/headers.mjs";
// @ts-expect-error -- plain .mjs script, no types
import { pagesProblems } from "../../scripts/lib/pagesLimits.mjs";
import { extendHeadersFileCsp } from "../build/cspEndpoints";
import { vercelConfig } from "../../vercel";

const ROOT = resolve(__dirname, "..", "..");
const read = (p: string) => readFileSync(join(ROOT, p), "utf8");
const vercelBase = JSON.parse(read("deploy/vercel.base.json"));
const headersText = read("public/_headers");
const policy = loadPolicy(ROOT);
// public/ files the probes ask for: the favicon and the content frame (plan W4.15).
const FILES: string[] = [...BUILT_FILES, "favicon.svg", "content-frame.html", "content-frame.js"];

type Probe = { path: string; same: boolean; accepted?: string; diffs: string[] };
type Report = { ok: boolean; same: number; accepted: number; failed: number; results: Probe[] };
const failing = (r: Report) => r.results.filter((x) => !x.same && !x.accepted).map((x) => `${x.path}: ${x.diffs.join("; ")}`);
const compare = (text: string, extra: { pagesExtra?: string[]; origins?: string[] } = {}): Report =>
  compareConfigs({ vercelBase, headersText: text, files: FILES, pagesExtra: extra.pagesExtra ?? ["assets/404.html"], origins: extra.origins ?? [] });

describe("host parity: the checked-in configs", () => {
  it("every probe is the same on both hosts, apart from the accepted ones", () => {
    const r: Report = configReport({ root: ROOT });
    expect(failing(r)).toEqual([]);
    expect(r.results.length).toBe(PROBES.length);
    expect(r.same + r.accepted).toBe(PROBES.length);
    for (const x of r.results.filter((y) => y.accepted)) expect(Object.keys(ACCEPTED)).toContain(x.path);
  });

  it("the runner pages and the content frame keep their own policy at the path Pages redirects them to", () => {
    const rules = parseHeadersRules(headersText);
    for (const page of ["playground-runner", "livejs-runner", "content-frame"]) {
      const r = pagesServe(rules, FILES, `/${page}.html`);
      expect(r.hops).toEqual([`/${page}.html`, `/${page}`]);
      expect(r.served).toBe(`${page}.html`);
      expect(r.headers.get("x-frame-options")).toBeUndefined();
      expect(r.headers.get("content-security-policy")).toBe(renderCsp(policy, page, "cloudflare"));
    }
  });

  it("a chunk of the previous deploy is a 404 on both, not the app's HTML", () => {
    const rules = parseHeadersRules(headersText);
    expect(pagesServe(rules, [...FILES, "assets/404.html"], "/assets/index-Gone99.js").status).toBe(404);
    expect(pagesServe(rules, FILES, "/assets/index-Gone99.js")).toMatchObject({ status: 200, served: "index.html" });
    expect(vercelServe(fillVercel(vercelBase), FILES, "/assets/index-Gone99.js").status).toBe(404);
  });

  it("Vercel's emulation fills the placeholder exactly as vercel.ts does", () => {
    const origins = ["https://auth.lumen-test.dev", "wss://sync.lumen-test.dev"];
    expect(fillVercel(vercelBase, origins).headers).toEqual(vercelConfig(vercelBase, origins).headers);
  });
});

describe("host parity catches what #484's configuration missed", () => {
  it("without the extension-less runner blocks the runners get the app policy and DENY on Pages", () => {
    const text = headersText.replace(/^\/playground-runner\n(?: {2}.*\n)+/m, "");
    expect(text).not.toBe(headersText);
    expect(failing(compare(text)).join("\n")).toMatch(/\/playground-runner\.html: content-security-policy: .*x-frame-options: \(none\) ≠ DENY/s);
  });

  it("without the Cache-Control rules the service worker and the chunks differ", () => {
    const text = headersText.replace(/^ {2}Cache-Control: .*\n/gm, "");
    const bad = failing(compare(text)).join("\n");
    expect(bad).toContain("/sw.js: cache-control: no-cache, no-store, must-revalidate");
    expect(bad).toContain("/assets/index-AbC123.js: cache-control: public, max-age=31536000, immutable");
  });

  it("without assets/404.html a missing chunk is the app's HTML on Pages", () => {
    expect(failing(compare(headersText, { pagesExtra: [] })).join("\n")).toContain("/assets/index-Gone99.js: status 404 ≠ 200");
  });
});

describe("the 2,000-character line limit of Cloudflare's _headers", () => {
  // Twenty: on train 2 the app policy is shorter (no https: in img-src or frame-src, plan W4.15), so a dozen origins no longer
  // reach the limit on one line; the split layout still has to hold well past it.
  const origins = Array.from({ length: 20 }, (_, i) => `https://endpoint-${i}.lumen-workers.example.dev`);

  it("the split app policy is enforced as exactly the policy", () => {
    const parts: string[] = renderCspParts(policy, "app", "cloudflare");
    expect(parts.length).toBe(2);
    const { policy: enforced, conflicts } = combineCspParts([parts.join(", ")]);
    expect(conflicts).toEqual([]);
    expect(Object.fromEntries(enforced)).toEqual(Object.fromEntries(parseCsp(renderCsp(policy, "app", "cloudflare"))));
  });

  it("with twenty endpoint origins every built line still fits, and both hosts match", () => {
    const built = extendHeadersFileCsp(headersText, origins);
    expect(pagesProblems([{ path: "index.html", bytes: 1 }], built, "").problems).toEqual([]);
    expect(failing(compare(built, { origins }))).toEqual([]);
  });

  it("on one line (#484's layout) the built policy is over the limit and Pages sends no header CSP", () => {
    const one = headersText.replace(
      /^ {2}Content-Security-Policy: default-src 'self';.*\n {2}Content-Security-Policy: connect-src .*$/m,
      `  Content-Security-Policy: ${renderCsp(policy, "app", "cloudflare")}`,
    );
    expect(one).not.toBe(headersText);
    const built = extendHeadersFileCsp(one, origins);
    expect(pagesProblems([{ path: "index.html", bytes: 1 }], built, "").problems.join("\n")).toMatch(/_headers:\d+ is \d{4} characters: Cloudflare skips lines over 2000/);
    expect(failing(compare(built, { origins })).join("\n")).toMatch(/^\/: content-security-policy: .* ≠ \(none\)/m);
  });

  it("a top-level 404.html is a problem: it turns the SPA fallback off", () => {
    expect(pagesProblems([{ path: "404.html", bytes: 10 }], "", "").problems.join("\n")).toContain("single-page fallback");
  });
});

describe("host parity --live", () => {
  /** A server that answers like the emulated host. */
  const serve = (handler: (path: string) => { status: number; served: string | null; headers: Map<string, string> }) =>
    new Promise<Server>((done) => {
      const s = createServer((req: IncomingMessage, res: ServerResponse) => {
        const path = new URL(req.url ?? "/", "http://x").pathname;
        const r = handler(path);
        if (r.status === 308) {
          res.writeHead(308, { location: r.served ?? "/" }).end();
          return;
        }
        const headers: Record<string, string> = Object.fromEntries(r.headers);
        if (r.served?.endsWith(".html")) headers["content-type"] = "text/html; charset=utf-8";
        res.writeHead(r.status, headers).end(r.status === 200 ? `file:${r.served}` : "");
      }).listen(0, "127.0.0.1", () => done(s));
    });
  const url = (s: Server) => `http://127.0.0.1:${(s.address() as AddressInfo).port}`;

  it("two origins serving the same build compare equal; a dropped header fails", async () => {
    const vercel = fillVercel(vercelBase);
    const rules = parseHeadersRules(headersText);
    const pagesFiles = [...FILES, "assets/404.html"];
    const pagesHandler = (path: string) => {
      const r = pagesServe(rules, pagesFiles, path, 0);
      // One hop at a time, as a real server: a redirect answers 308 with its target.
      if (r.hops.length === 1 && pagesServe(rules, pagesFiles, path).hops.length > 1)
        return { status: 308, served: pagesServe(rules, pagesFiles, path).hops[1], headers: new Map() };
      return r;
    };
    const a = await serve((p) => vercelServe(vercel, FILES, p));
    const b = await serve(pagesHandler);
    const c = await serve((p) => {
      const r = pagesHandler(p);
      r.headers.delete("x-frame-options");
      return r;
    });
    try {
      const probes = PROBES.filter(([p]: [string]) => !p.endsWith(".png"));
      const same: Report = await liveProbe(url(a), url(b), { probes });
      expect(failing(same)).toEqual([]);
      const bad: Report = await liveProbe(url(a), url(c), { probes });
      expect(failing(bad).join("\n")).toMatch(/^\/: x-frame-options: DENY ≠ \(none\)/m);
    } finally {
      for (const s of [a, b, c]) s.close();
    }
  });
});
