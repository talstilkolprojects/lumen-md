/**
 * W4.4 / 15.18: the live secret scan, the VITE_* allowlist and the build
 * gate that fails on a VITE_* not on the list.
 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { checkViteEnv, formatViteEnvError, isAllowedViteName, loadAllowlist } from "../../scripts/lib/viteEnvAllowlist.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { assetRefs, masked, scanText } from "../../scripts/lib/liveSecrets.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { renderReport, scanUrl, selfTest } from "../../scripts/secrets-scan-live.mjs";
import { viteEnvGatePlugin } from "../build/viteEnvGate";

const ROOT = fileURLToPath(new URL("../..", import.meta.url));

type Finding = { level: string; kind: string; value: string; context: string };
const kinds = (text: string, level = "secret"): string[] =>
  (scanText("x.js", text).findings as Finding[]).filter((f) => f.level === level).map((f) => f.kind);

// Built at run time: no token-shaped literal in the repository.
const fake = {
  openai: "sk-" + "proj-" + "Ab12".repeat(8),
  github: "gh" + "p_" + "x9Y8z7".repeat(6),
  google: "AI" + "za" + "Sy" + "Q1".repeat(16) + "w",
  jwt: (role: string) =>
    [Buffer.from('{"alg":"HS256"}').toString("base64url"), Buffer.from(JSON.stringify({ role, ref: "abc" })).toString("base64url"), "sig".repeat(8)].join("."),
};

describe("token shapes", () => {
  it("finds provider tokens and service JWTs as secrets", () => {
    expect(kinds(`a="${fake.openai}"`)).toEqual(["openai-key"]);
    expect(kinds(`a='${fake.github}'`)).toEqual(["github-token"]);
    expect(kinds(`a=\`${fake.google}\``)).toEqual(["google-api-key"]);
    expect(kinds(`a="${fake.jwt("service_role")}"`)).toEqual(["jwt"]);
  });

  it("an anon JWT and a 32+ hex string are for review, not failures", () => {
    expect(kinds(`a="${fake.jwt("anon")}"`)).toEqual([]);
    expect(kinds(`a="${fake.jwt("anon")}"`, "review")).toEqual(["jwt-anon"]);
    expect(kinds('u="https://www.loom.com/share/' + "0123456789abcdef".repeat(2) + '"', "review")).toEqual(["hex32"]);
  });

  it("does not flag a PEM header alone, or code that merely names the prefixes", () => {
    expect(kinds('const h="-----BEGIN PRIVATE KEY-----";')).toEqual([]);
    expect(kinds('if(k.startsWith("sk-")||k.startsWith("ghp_")||k.startsWith("AIza"))x()')).toEqual([]);
  });

  it("never reports a whole value, nor a piece of a neighbouring one", () => {
    const text = `a="${fake.openai}",b="${fake.github}"`;
    const { findings } = scanText("x.js", text) as { findings: Finding[] };
    for (const f of findings) {
      for (const v of [fake.openai, fake.github]) {
        expect(f.value.includes(v)).toBe(false);
        expect(f.context.includes(v.slice(4, 20))).toBe(false);
      }
    }
    expect(masked(fake.openai)).toBe(`sk-p… (${fake.openai.length} chars)`);
  });
});

describe("inlined VITE_* values", () => {
  it("reads an inlined import.meta.env object (the pre-#243 shape)", () => {
    const text = "const e={BASE_URL:`/`,VITE_VERCEL_ENV:`production`,VITE_SUPABASE_URL:`https://x.supabase.co`,VITE_OPENAI_KEY:`abc123`,VITE_DOCS_URL:``};";
    const { findings, viteEnv } = scanText("x.js", text) as { findings: Finding[]; viteEnv: { name: string; allowed: boolean; set: boolean }[] };
    expect(findings.filter((f) => f.level === "secret").map((f) => f.kind)).toEqual(["vite-unlisted"]);
    expect(viteEnv.find((v) => v.name === "VITE_OPENAI_KEY")).toEqual({ name: "VITE_OPENAI_KEY", allowed: false, set: true });
    expect(viteEnv.find((v) => v.name === "VITE_DOCS_URL")).toMatchObject({ allowed: true, set: false });
  });

  it("reads src/lib/publicEnv.ts's switch after inlining", () => {
    const text = "function t(e){switch(e){case`VITE_DOCS_URL`:return`https://docs.example`;case`VITE_SENTRY_DSN`:return}}";
    const { viteEnv } = scanText("x.js", text) as { viteEnv: { name: string; set: boolean }[] };
    expect(viteEnv.map((v) => [v.name, v.set])).toEqual([["VITE_DOCS_URL", true]]);
  });
});

describe("crawl", () => {
  it("collects index.html scripts and chunk imports", () => {
    expect(assetRefs('<script type="module" src="/assets/main-A1.js"></script><link rel="modulepreload" href="/assets/x-B2.js"><link rel="stylesheet" href="/assets/a.css">')).toEqual([
      "/assets/main-A1.js",
      "/assets/x-B2.js",
      "/assets/a.css",
    ]);
    expect(assetRefs('import{t as e}from"./app-Pd.js";const m=()=>import("./lazy-Q.js"),d=["assets/dep-R.js"];')).toEqual([
      "/assets/app-Pd.js",
      "/assets/lazy-Q.js",
      "/assets/dep-R.js",
    ]);
  });

  it("scans a deployment from / through every chunk it reaches", async () => {
    const site: Record<string, string> = {
      "/": '<script type="module" src="/assets/main-1.js"></script>',
      "/assets/main-1.js": 'import"./app-2.js";',
      "/assets/app-2.js": `const l=()=>import("./lazy-3.js");`,
      "/assets/lazy-3.js": `const k="${fake.github}";`,
    };
    const seen: string[] = [];
    const fetchImpl = async (url: string) => {
      const path = new URL(url).pathname;
      seen.push(path);
      return site[path] ? new Response(site[path]) : new Response("", { status: 404 });
    };
    const r = await scanUrl("https://example.test/", { fetchImpl });
    expect(seen).toEqual(["/", "/assets/main-1.js", "/assets/app-2.js", "/assets/lazy-3.js"]);
    expect(r.findings.map((f: Finding) => [f.kind, f.level])).toEqual([["github-token", "secret"]]);
    const md = renderReport({ generatedAt: "t", targets: [r], env: { names: [], allowed: [], disallowed: [] } });
    expect(md).toContain("Secrets: **1**");
    expect(md).not.toContain(fake.github);
  });

  it("self-test: a token of each kind planted in a local build is found, all masked", () => {
    const r = selfTest();
    expect(r.missing).toEqual([]);
    expect(r.leaked).toBe(false);
    expect(r.ok).toBe(true);
  });
});

describe("the VITE_* allowlist", () => {
  const allow = loadAllowlist();

  it("allows listed names, Vercel system variables and CI canaries; nothing else", () => {
    const r = checkViteEnv({
      VITE_SUPABASE_URL: "https://x.supabase.co",
      VITE_VERCEL_GIT_COMMIT_SHA: "abc",
      VITE_CI_CANARY_SECRET: "ci-canary-vite-secret-8d2f7a",
      VITE_OPENAI_API_KEY: "sk-whatever",
      VITE_RESEARCH_TOKEN: "real-looking-token",
      VITE_EMPTY_UNLISTED: "",
      PATH: "/bin",
    });
    expect(r.allowed).toEqual(["VITE_CI_CANARY_SECRET", "VITE_SUPABASE_URL", "VITE_VERCEL_GIT_COMMIT_SHA"]);
    expect(r.disallowed).toEqual(["VITE_OPENAI_API_KEY", "VITE_RESEARCH_TOKEN"]);
    const msg = formatViteEnvError(r.disallowed);
    expect(msg).toContain("VITE_OPENAI_API_KEY");
    expect(msg).not.toContain("sk-whatever");
  });

  it("lists every VITE_* name the app and its build read, and none they do not", () => {
    const read = new Set<string>();
    const files = [
      "vite.config.ts",
      ...(readdirSync(join(ROOT, "src"), { recursive: true }) as string[])
        .filter((f) => /\.(ts|tsx)$/.test(f) && !f.includes("__tests__") && !/\.test\.tsx?$/.test(f))
        .map((f) => join("src", f)),
    ];
    for (const f of files) {
      // Comments may name examples (`VITE_X`); only code counts.
      const text = readFileSync(join(ROOT, f), "utf8").replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "");
      for (const m of text.matchAll(/import\.meta\.env\??\.(VITE_[A-Z0-9_]+)|["'`](VITE_[A-Z0-9_]*[A-Z0-9])["'`]/g)) read.add(m[1] ?? m[2]);
    }
    expect(read.size).toBeGreaterThan(10);
    for (const name of read) expect(isAllowedViteName(name, allow), name).toBe(true);
    for (const name of Object.keys(allow.names)) expect(/(TOKEN|SECRET|PASSWORD)/.test(name), name).toBe(false);
  });
});

describe("build gate", () => {
  let dir = "";
  const saved = { ...process.env };
  afterEach(() => {
    for (const k of Object.keys(process.env)) if (!(k in saved)) delete process.env[k];
    if (dir) rmSync(dir, { recursive: true, force: true });
    dir = "";
  });

  const run = (root: string) => {
    const plugin = viteEnvGatePlugin() as unknown as { apply: string; configResolved: (c: unknown) => void };
    expect(plugin.apply).toBe("build");
    return () => plugin.configResolved({ mode: "production", root, envDir: root });
  };

  it("passes with only allowed names", () => {
    dir = mkdtempSync(join(tmpdir(), "vite-env-"));
    writeFileSync(join(dir, ".env"), "VITE_DOCS_URL=https://docs.example\n");
    process.env.VITE_VERCEL_ENV = "preview";
    expect(run(dir)).not.toThrow();
  });

  it("fails on a VITE_* from an .env file or the environment that is not on the list", () => {
    dir = mkdtempSync(join(tmpdir(), "vite-env-"));
    writeFileSync(join(dir, ".env.production"), "VITE_STRIPE_SECRET_KEY=planted-value-1234\n");
    process.env.VITE_ANTHROPIC_KEY = "planted-value-5678";
    expect(run(dir)).toThrow(/VITE_ANTHROPIC_KEY, VITE_STRIPE_SECRET_KEY/);
    try {
      run(dir)();
    } catch (e) {
      expect(String(e)).not.toContain("planted-value");
    }
  });
});
