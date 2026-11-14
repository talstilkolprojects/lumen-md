/**
 * No secret comes from VITE_*: the hygiene rules that keep secret-named
 * VITE_* reads and whole import.meta.env reads out of src, the bundle
 * canary scanner, and the research token now coming from the secret store.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// @ts-expect-error — plain .mjs script without type declarations
import { findViolations } from "../../scripts/check-code-hygiene.mjs";
// @ts-expect-error — plain .mjs script without type declarations
import { scanViteSecrets } from "../../scripts/check-vite-secrets.mjs";

const rules = (src: string): string[] => findViolations("x.ts", src).map((v: { rule: string }) => v.rule);

afterEach(() => {
  vi.unstubAllGlobals();
  vi.resetModules();
});

describe("hygiene: secrets never come from VITE_*", () => {
  it("flags a secret-named VITE_* read, by property or by name", () => {
    expect(rules("const t = import.meta.env.VITE_RESEARCH_TOKEN;")).toEqual(["vite-secret"]);
    expect(rules('const t = readEnv("VITE_API_SECRET");')).toEqual(["vite-secret"]);
    expect(rules("const k = (import.meta as M).env?.VITE_OPENAI_KEY;")).toEqual(["vite-secret"]);
  });

  it("allows public names and ordinary config", () => {
    expect(rules("const a = import.meta.env.VITE_SUPABASE_ANON_KEY;")).toEqual([]);
    expect(rules("const a = import.meta.env.VITE_DROPBOX_APP_KEY;")).toEqual([]);
    expect(rules("const u = import.meta.env.VITE_RESEARCH_ENDPOINT;")).toEqual([]);
  });

  it("flags reading import.meta.env as a whole object, not one name at a time", () => {
    expect(rules("const env = import.meta.env;")).toEqual(["env-whole"]);
    expect(rules("const env = (import.meta as M).env; env?.VITE_DOCS_URL;")).toEqual(["env-whole"]);
    expect(rules("const v = import.meta.env[key];")).toEqual(["env-whole"]);
    expect(rules('const v = import.meta.env["VITE_DOCS_URL"];')).toEqual([]);
    expect(rules("const v = (import.meta as M).env?.VITE_DOCS_URL;")).toEqual([]);
    expect(rules("const b = import.meta.env?.BASE_URL;")).toEqual([]);
  });
});

describe("check-vite-secrets", () => {
  it("finds a secret-named VITE_* value in the bundle, ignores public and unset ones", () => {
    const dir = mkdtempSync(join(tmpdir(), "lumen-vite-secrets-"));
    try {
      mkdirSync(join(dir, "assets"));
      writeFileSync(join(dir, "assets", "a.js"), 'const x={VITE_CI_CANARY_SECRET:"canary-123456",VITE_SUPABASE_ANON_KEY:"anon-public-123"}');
      const env = { VITE_CI_CANARY_SECRET: "canary-123456", VITE_SUPABASE_ANON_KEY: "anon-public-123", VITE_RESEARCH_TOKEN: "canary-not-there", PATH: "/bin" };
      const { findings, checked } = scanViteSecrets(dir, env);
      expect(checked.sort()).toEqual(["VITE_CI_CANARY_SECRET", "VITE_RESEARCH_TOKEN"]);
      expect(findings).toEqual([{ file: join("assets", "a.js"), name: "VITE_CI_CANARY_SECRET" }]);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe("research service token", () => {
  it("is sent from the secret store, and not at all when unset", async () => {
    const secrets = new Map<string, string>();
    vi.doMock("../lib/secretStore", () => ({
      getSecret: (k: string) => secrets.get(k) ?? null,
      setSecret: (k: string, v: string | null) => (v ? secrets.set(k, v) : secrets.delete(k)),
    }));
    const calls: Array<Record<string, string>> = [];
    vi.stubGlobal(
      "fetch",
      vi.fn(async (_u: string, init?: RequestInit) => {
        calls.push({ ...(init?.headers as Record<string, string>) });
        return new Response(JSON.stringify({ url: "https://a.example/", finalUrl: "https://a.example/", title: "t", text: "x" }), { status: 200 });
      }),
    );
    const { extractPage, RESEARCH_SERVICE_TOKEN } = await import("../research/client");
    await extractPage("https://a.example/", undefined, "https://research.example");
    secrets.set(RESEARCH_SERVICE_TOKEN, "user-entered-token");
    await extractPage("https://a.example/", undefined, "https://research.example");
    expect(calls[0]["X-Lumen-Research-Token"]).toBeUndefined();
    expect(calls[1]["X-Lumen-Research-Token"]).toBe("user-entered-token");
  });
});
