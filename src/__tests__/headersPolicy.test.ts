// @vitest-environment node
/**
 * Plan 0.17 — security headers from one source.
 *
 * security/policy.json is rendered into every file that carries a copy of
 * a policy (scripts/headers.mjs). These tests cover the renderers, the
 * repo staying in sync, and that drift in any single source is caught.
 */
import { describe, it, expect, afterAll } from "vitest";
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import {
  loadPolicy,
  renderCsp,
  renderHeaderLine,
  renderMeta,
  renderNginx,
  renderVercel,
  renderTauri,
  tauriConfigWithOrigins,
  parseCsp,
  cspDiff,
  run,
  // @ts-expect-error — plain .mjs script without type declarations
} from "../../scripts/headers.mjs";
import { addConnectSrc, extendHeadersFileCsp } from "../build/cspEndpoints";

const ROOT = resolve(__dirname, "..", "..");
const policy = loadPolicy(ROOT);

const fixture = {
  routes: {
    app: {
      kind: "document",
      samples: ["/"],
      csp: {
        "default-src": ["'self'"],
        "script-src": ["'self'", "'wasm-unsafe-eval'"],
        "img-src": ["'self'", "https://tiles.example", "https:"],
        "connect-src": ["'self'", "https://api.example"],
        "frame-ancestors": ["'none'"],
        "require-trusted-types-for": ["'script'"],
      },
    },
    runner: {
      kind: "document",
      frameable: true,
      samples: ["/runner.html"],
      csp: { "default-src": ["'none'"], "connect-src": ["'none'"], "frame-ancestors": ["'self'"] },
    },
  },
  headers: {},
  hosts: {
    meta: { csp: [{ routes: "*", omit: ["frame-ancestors"] }] },
    tauri: {
      csp: [
        { routes: ["app"], omit: ["frame-ancestors", "require-trusted-types-for"], add: { "connect-src": ["ipc:"] } },
        { routes: ["app"], remove: { "img-src": ["https:"], "media-src": ["https:"] } },
      ],
    },
    "docker-nginx": { csp: [{ routes: ["app"], add: { "connect-src": ["__CSP_CONNECT_EXTRA__"] } }] },
  },
  sources: {},
};

describe("renderers", () => {
  const app =
    "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://tiles.example https:; connect-src 'self' https://api.example; frame-ancestors 'none'; require-trusted-types-for 'script'";

  it("header text: directives in policy order, `; `-separated, no trailing separator", () => {
    expect(renderCsp(fixture, "app", "cloudflare")).toBe(app);
    expect(renderHeaderLine(fixture, "app")).toBe(`Content-Security-Policy: ${app}`);
  });

  it("meta: no frame-ancestors (ignored in <meta>)", () => {
    expect(renderMeta(fixture, "app")).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://tiles.example https:; connect-src 'self' https://api.example; require-trusted-types-for 'script'",
    );
    expect(renderMeta(fixture, "runner")).toBe("default-src 'none'; connect-src 'none'");
  });

  it("nginx add_header, with the docker image's build-time placeholder", () => {
    expect(renderNginx(fixture, "app")).toBe(
      `add_header Content-Security-Policy "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://tiles.example https:; connect-src 'self' https://api.example __CSP_CONNECT_EXTRA__; frame-ancestors 'none'; require-trusted-types-for 'script'" always;`,
    );
    expect(renderNginx(fixture, "app", "deploy-nginx")).toBe(`add_header Content-Security-Policy "${app}" always;`);
  });

  it("vercel JSON header object", () => {
    expect(renderVercel(fixture, "runner")).toEqual({
      key: "Content-Security-Policy",
      value: "default-src 'none'; connect-src 'none'; frame-ancestors 'self'",
    });
    expect(JSON.parse(JSON.stringify(renderVercel(fixture, "app"))).value).toBe(app);
  });

  it("Tauri: host exceptions omit, remove single sources, and add", () => {
    expect(renderTauri(fixture)).toBe(
      "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://tiles.example; connect-src 'self' https://api.example ipc:",
    );
  });

  it("webR's jsDelivr fallback is in the web policies only, never the desktop app's (review 13.5)", () => {
    const policy = loadPolicy(ROOT);
    const connect = (host: string) => parseCsp(renderCsp(policy, "app", host)).get("connect-src") as string[];
    for (const host of ["meta", "cloudflare", "vercel", "deploy-nginx"]) expect(connect(host), host).toContain("https://cdn.jsdelivr.net");
    expect(connect("tauri")).not.toContain("https://cdn.jsdelivr.net");
    expect(connect("tauri")).toContain("https://webr.r-wasm.org");
    expect(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).not.toContain("cdn.jsdelivr.net");
  });

  it("Tauri: --tauri-config adds the build's endpoint origins to connect-src only", () => {
    expect(tauriConfigWithOrigins(fixture, ["https://sso.acme.example", "https://api.example"])).toEqual({
      app: {
        security: {
          csp: "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; img-src 'self' https://tiles.example; connect-src 'self' https://api.example ipc: https://sso.acme.example",
        },
      },
    });
  });

  it("parse ↔ render round trip and a readable directive diff", () => {
    expect([...parseCsp(app).keys()]).toEqual(Object.keys(fixture.routes.app.csp));
    expect(cspDiff("default-src 'self'; script-src 'self' 'unsafe-eval'", "default-src 'self'; script-src 'self'; object-src 'none'")).toEqual([
      "- script-src 'unsafe-eval'",
      "+ object-src 'none'",
    ]);
    expect(cspDiff("a x;", "a x")).toEqual(["~ formatting only (separators / directive order)"]);
  });
});

describe("the real policy", () => {
  it("meta copies carry neither frame-ancestors nor Trusted Types; the header carries both", () => {
    const meta = parseCsp(renderMeta(policy, "app"));
    const header = parseCsp(renderCsp(policy, "app", "cloudflare"));
    expect(meta.has("frame-ancestors")).toBe(false);
    expect(meta.has("trusted-types")).toBe(false);
    expect(header.get("frame-ancestors")).toEqual(["'none'"]);
    expect(header.get("require-trusted-types-for")).toEqual(["'script'"]);
    // Apart from those, meta and header are the same policy.
    for (const d of ["frame-ancestors", "require-trusted-types-for", "trusted-types"]) header.delete(d);
    expect(meta).toEqual(header);
  });

  it("no route but the runners and the eval workers allows eval", () => {
    for (const [route, def] of Object.entries(policy.routes as Record<string, { csp: Record<string, string[]> }>)) {
      const evals = def.csp["script-src"]?.includes("'unsafe-eval'");
      expect(evals, route).toBe(["playground-runner", "livejs-runner", "eval-workers"].includes(route));
    }
    for (const host of ["meta", "tauri", "cloudflare", "vercel", "docker-nginx", "deploy-nginx"]) {
      expect(parseCsp(renderCsp(policy, "app", host)).get("script-src"), host).toEqual(["'self'", "'wasm-unsafe-eval'"]);
    }
  });

  it("build-time endpoint origins extend the app policy but never connect-src 'none'", () => {
    const origin = "https://lumen-auth.acme.workers.dev";
    const runner = renderHeaderLine(policy, "livejs-runner");
    expect(extendHeadersFileCsp(`  ${runner}`, [origin])).toBe(`  ${runner}`);
    expect(addConnectSrc(renderCsp(policy, "app", "cloudflare"), [origin])).toContain(`https://fonts.gstatic.com ${origin};`);
  });
});

describe("scripts/headers.mjs on the repo", () => {
  it("--check passes: every source matches security/policy.json", () => {
    const { problems, files } = run({ root: ROOT });
    expect(problems).toEqual([]);
    expect(files).toEqual(Object.keys(policy.sources));
  });

  it("the CLI exits 0 here", () => {
    const r = spawnSync(process.execPath, [join(ROOT, "scripts/headers.mjs"), "--check"], { encoding: "utf8" });
    expect(r.stderr).toBe("");
    expect(r.status).toBe(0);
  });

  it("--tauri-config prints the checked-in desktop policy plus the build's endpoint origins", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-tauri-cfg-"));
    try {
      const extra = join(dir, ".csp-connect-extra");
      writeFileSync(extra, "https://sso.acme.example wss://collab.acme.example\n");
      const r = spawnSync(process.execPath, [join(ROOT, "scripts/headers.mjs"), "--tauri-config", extra], { encoding: "utf8" });
      expect(r.status).toBe(0);
      const csp: string = JSON.parse(r.stdout).app.security.csp;
      const checkedIn: string = JSON.parse(readFileSync(join(ROOT, "src-tauri/tauri.conf.json"), "utf8")).app.security.csp;
      const connect = (c: string) => parseCsp(c).get("connect-src");
      expect(connect(csp)).toEqual([...connect(checkedIn)!, "https://sso.acme.example", "wss://collab.acme.example"]);
      const rest = (c: string) => [...parseCsp(c)].filter(([d]) => d !== "connect-src");
      expect(rest(csp)).toEqual(rest(checkedIn));
      const missing = spawnSync(process.execPath, [join(ROOT, "scripts/headers.mjs"), "--tauri-config", join(dir, "nope")], { encoding: "utf8" });
      expect(missing.status).toBe(1);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("drift is caught", () => {
  const tmp = mkdtempSync(join(tmpdir(), "lumen-headers-"));
  afterAll(() => rmSync(tmp, { recursive: true, force: true }));

  /** A fresh copy of every source + the policy. */
  const copy = (name: string): string => {
    const dir = join(tmp, name);
    for (const f of [...Object.keys(policy.sources), "security/policy.json", "playground-runner.html"]) {
      mkdirSync(dirname(join(dir, f)), { recursive: true });
      cpSync(join(ROOT, f), join(dir, f));
    }
    return dir;
  };

  it.each(Object.keys(policy.sources))("one changed directive in %s fails --check; --write restores it", (file) => {
    const dir = copy(file.replace(/\W/g, "_"));
    const path = join(dir, file);
    const original = readFileSync(path, "utf8");
    const changed = original.replace("script-src 'self'", "script-src 'self' https://cdn.evil.example");
    expect(changed).not.toBe(original);
    writeFileSync(path, changed);

    const before = run({ root: dir });
    expect(before.problems.length).toBe(1);
    expect(before.problems[0]).toContain(file);
    expect(before.problems[0]).toContain("- script-src https://cdn.evil.example");

    const cli = spawnSync(process.execPath, [join(ROOT, "scripts/headers.mjs"), "--root", dir], { encoding: "utf8" });
    expect(cli.status).toBe(1);
    expect(cli.stderr).toContain("cdn.evil.example");

    expect(run({ root: dir, write: true }).fixes).toBe(1);
    expect(readFileSync(path, "utf8")).toBe(original);
    expect(run({ root: dir }).problems).toEqual([]);
  });

  it("a route the Vercel catch-all no longer excludes is a conflict --write cannot paper over", () => {
    const dir = copy("vercel-route");
    const path = join(dir, "deploy/vercel.base.json");
    writeFileSync(path, readFileSync(path, "utf8").replace("|webr/", ""));
    const { problems } = run({ root: dir, write: true });
    expect(problems.join("\n")).toMatch(/\/webr\/webr-worker\.js \(route eval-workers\) gets two Content-Security-Policy headers/);
  });

  it("a runner that loses its own block gets the app's X-Frame-Options and is flagged", () => {
    const dir = copy("cf-runner");
    const path = join(dir, "public/_headers");
    writeFileSync(path, readFileSync(path, "utf8").replace("  ! X-Frame-Options\n", ""));
    expect(run({ root: dir }).problems.join("\n")).toContain("framed by the app but gets X-Frame-Options");
  });

  it("an nginx location that drops a required header is flagged", () => {
    const dir = copy("nginx-header");
    const path = join(dir, "deploy/nginx.conf");
    const text = readFileSync(path, "utf8");
    const at = text.indexOf("location = /sw.js {");
    writeFileSync(path, text.slice(0, at) + text.slice(at).replace(/\n\s*add_header X-Frame-Options "DENY" always;/, ""));
    expect(run({ root: dir }).problems.join("\n")).toContain('[location = /sw.js]: missing add_header X-Frame-Options "DENY" always;');
  });

  it("a <meta> CSP in a page the policy does not list is flagged", () => {
    const dir = copy("unlisted-meta");
    writeFileSync(
      join(dir, "preview-runner.html"),
      `<!doctype html><html><head>\n    <meta http-equiv="Content-Security-Policy" content="default-src 'none'" />\n</head></html>\n`,
    );
    expect(run({ root: dir }).problems.join("\n")).toContain("preview-runner.html: has a <meta> Content-Security-Policy");
  });
});
