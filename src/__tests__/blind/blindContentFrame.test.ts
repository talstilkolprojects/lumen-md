/**
 * Blind tests (plan W6.15, lane B): the tighter CSP and the content frame (#444).
 *
 * Written from the spec only: PR #444's body, security/policy.json (the policy is the
 * spec's own data) and the public API of src/lib/contentFrame.ts (declarations emitted
 * by tsc, no function bodies). The test list (C1–C9) was written before any
 * implementation was read; the implementation was then opened only to check the import
 * path. Failing cases are `it.fails` entries that link to a finding in the W6.15
 * findings list (PR body of test/blind-tests). The DOM half (C8, C9) is
 * blindContentFrameDom.test.ts.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import {
  CONTENT_FRAME_PATH,
  contentFrameRequest,
  contentFrameSandbox,
  contentFrameSrc,
  type ContentFrameRequest,
} from "../../lib/contentFrame";

const root = fileURLToPath(new URL("../../../", import.meta.url));
type Csp = Record<string, string[]>;
const policy = JSON.parse(readFileSync(`${root}security/policy.json`, "utf8")) as {
  routes: Record<string, { csp: Csp }>;
  hosts: Record<string, { csp?: Array<{ routes: string | string[]; add?: Csp; omit?: string[] }> }>;
};

/** The app's policy as a host renders it: the route's directives plus the host's additions. */
function appPolicyFor(host: string): Csp {
  const out: Csp = JSON.parse(JSON.stringify(policy.routes.app.csp));
  for (const rule of policy.hosts[host]?.csp ?? []) {
    const applies = rule.routes === "*" || (Array.isArray(rule.routes) && rule.routes.includes("app"));
    if (!applies) continue;
    for (const [k, v] of Object.entries(rule.add ?? {})) out[k] = [...(out[k] ?? []), ...v];
    for (const k of rule.omit ?? []) delete out[k];
  }
  return out;
}

const PROVIDERS = policy.routes["content-frame"].csp["frame-src"];

describe("the app policy (C1)", () => {
  for (const host of ["vercel", "meta", "tauri", "deploy-nginx", "cloudflare", "netlify"]) {
    it(`${host}: no blanket https:, http: or * in img-src and media-src`, () => {
      const p = appPolicyFor(host);
      for (const d of ["img-src", "media-src"]) {
        for (const s of p[d] ?? []) expect(["https:", "http:", "*", "https://*", "http://*"]).not.toContain(s);
      }
    });
  }

  for (const host of ["vercel", "meta", "deploy-nginx", "cloudflare", "netlify"]) {
    it(`${host}: frame-src has at most 3 sources and no blanket scheme`, () => {
      const fs = appPolicyFor(host)["frame-src"] ?? appPolicyFor(host)["default-src"];
      expect(fs.length).toBeLessThanOrEqual(3);
      for (const s of fs) expect(["https:", "http:", "*", "data:", "blob:"]).not.toContain(s);
    });
  }

  it("the app's script-src has no 'unsafe-inline' or 'unsafe-eval'", () => {
    const s = policy.routes.app.csp["script-src"];
    expect(s).not.toContain("'unsafe-inline'");
    expect(s).not.toContain("'unsafe-eval'");
  });
});

describe("the content frame's own policy (C2, C3)", () => {
  const cf = policy.routes["content-frame"].csp;
  it("can't call out, can only be framed by the app, and runs no inline or eval'd script", () => {
    expect(cf["connect-src"]).toEqual(["'none'"]);
    expect(cf["frame-ancestors"]).toEqual(["'self'"]);
    expect(cf["script-src"]).not.toContain("'unsafe-inline'");
    expect(cf["script-src"]).not.toContain("'unsafe-eval'");
    expect(cf["script-src"]).not.toContain("https:");
    expect(cf["form-action"] ?? cf["default-src"]).toEqual(["'none'"]);
  });

  it("frames only https provider hosts, never a blanket source", () => {
    expect(PROVIDERS.length).toBeGreaterThan(0);
    for (const s of PROVIDERS) expect(s).toMatch(/^https:\/\/[a-z0-9.-]+$/);
  });

  it("every rendered copy of the policy matches security/policy.json", () => {
    const out = execFileSync(process.execPath, [`${root}scripts/headers.mjs`, "--check"], { cwd: root, encoding: "utf8" });
    expect(out).toMatch(/match/i);
  });
});

const requests: ContentFrameRequest[] = [
  { kind: "img", src: "https://img.example/a b.png?x=1&y=\"2\"", alt: "<script>alert(1)</script> שלום", title: "כותרת 'ציטוט'", width: 40, height: 30, srcset: "https://img.example/a.png 2x" },
  { kind: "video", src: "https://media.example/v.mp4", title: "וידאו", loop: true, muted: true },
  { kind: "audio", src: "https://media.example/a.mp3" },
  { kind: "embed", src: "https://www.youtube-nocookie.com/embed/abc?start=10", title: "YouTube", allow: "autoplay", referrerPolicy: "strict-origin-when-cross-origin" },
  { kind: "gist", user: "octocat", id: "6cad326836d38bd3a7ae" },
];

describe("the request travels in the fragment (C4, C5)", () => {
  for (const req of requests) {
    it(`${req.kind}: the page is ${CONTENT_FRAME_PATH} with no query, and the request comes back intact`, () => {
      const src = contentFrameSrc(req);
      const u = new URL(src, "https://app.test/");
      expect(u.pathname).toBe(CONTENT_FRAME_PATH);
      expect(u.search).toBe("");
      const beforeHash = src.split("#")[0];
      const needle = "src" in req ? req.src : req.id;
      expect(beforeHash).not.toContain(needle);
      expect(contentFrameRequest(src)).toEqual(req);
    });
  }

  it("is null for other pages and for garbage fragments", () => {
    for (const s of ["https://app.test/", "/content-frame.htm#x", "/other.html#" + contentFrameSrc(requests[0]).split("#")[1], `${CONTENT_FRAME_PATH}`, `${CONTENT_FRAME_PATH}#`, `${CONTENT_FRAME_PATH}#%E0%A4%A`]) {
      expect(contentFrameRequest(s)).toBeNull();
    }
  });

  // F-6 (Low): "null when it is not one", but a fragment with an unknown kind comes back as a request.
  it("is null for a fragment whose kind is not one of the five (F-6)", () => {
    const fragment = contentFrameSrc(requests[2]).split("#")[1].replace("audio", "nope");
    expect(contentFrameRequest(`${CONTENT_FRAME_PATH}#${fragment}`)).toBeNull();
    expect(contentFrameRequest(`${CONTENT_FRAME_PATH}#${encodeURIComponent('{"kind":"nope"}')}`)).toBeNull();
  });
});

describe("hostile requests fail closed (C6, adversarial)", () => {
  const bad: ContentFrameRequest[] = [
    { kind: "img", src: "javascript:alert(1)" },
    { kind: "video", src: "data:text/html,<script>alert(1)</script>" },
    { kind: "embed", src: "javascript:alert(document.domain)", title: "x" },
    { kind: "embed", src: "http://www.youtube.com/embed/x", title: "x" },
  ];
  // F-6 (Low, defence in depth): the parser hands back javascript:, data: and http: sources.
  // CSP (no 'unsafe-inline' script, frame-src = the providers) still stops them running.
  for (const req of bad) {
    it(`(F-6) a ${req.kind} with src ${"src" in req ? req.src.slice(0, 24) : ""}… does not come out of the fragment`, () => {
      let src: string | null = null;
      try {
        src = contentFrameSrc(req);
      } catch {
        return; // refused at the source: fine
      }
      expect(contentFrameRequest(src)).toBeNull();
    });
  }
});

describe("sandbox (C7)", () => {
  it("images, media and Gists get an opaque origin; embeds keep their own", () => {
    for (const k of ["img", "video", "audio", "gist"] as const) {
      const flags = contentFrameSandbox(k).split(/\s+/);
      expect(flags).not.toContain("allow-same-origin");
      expect(flags).not.toContain("allow-top-navigation");
    }
    expect(contentFrameSandbox("embed").split(/\s+/)).toContain("allow-same-origin");
    expect(contentFrameSandbox("embed").split(/\s+/)).not.toContain("allow-top-navigation");
  });
});
