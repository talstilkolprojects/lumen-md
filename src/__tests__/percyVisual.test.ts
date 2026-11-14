/**
 * Plan W7.25: the Percy snapshot list and the client that talks to `percy exec`.
 */
import { describe, expect, it } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { CLIENT_INFO, percyEnabled, percySnapshot, snapshotPayload } from "../../visual/percy";
import { BASE_SURFACE_IDS, COMMAND_SURFACES, PERCY_SCREEN_IDS, RTL_CANARY_CSS, percySurfaces } from "../../visual/percy-surfaces";
import { PERCY_CLI, percyCommand } from "../../scripts/visual/percy-run.mjs";

const ROOT = resolve(__dirname, "..", "..");

function sources(dir: string, out: string[] = []): string[] {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) sources(p, out);
    else if (/\.(ts|tsx)$/.test(e.name)) out.push(readFileSync(p, "utf8"));
  }
  return out;
}

describe("Percy visual regression (W7.25)", () => {
  it("30 screens × 4 variants; every id once; the ten are harness.ts's own", () => {
    expect(PERCY_SCREEN_IDS.length).toBe(30);
    expect(new Set(PERCY_SCREEN_IDS).size).toBe(30);
    const harness = readFileSync(join(ROOT, "visual/harness.ts"), "utf8");
    const block = harness.slice(harness.indexOf("export const SURFACES"), harness.indexOf("/** The note every shot shows"));
    expect([...block.matchAll(/^\s+(?:\{ )?id: "([^"]+)"/gm)].map((m) => m[1])).toEqual([...BASE_SURFACE_IDS]);
    const variants = harness.slice(harness.indexOf("export const VARIANTS"), harness.indexOf("export interface Surface"));
    expect([...variants.matchAll(/id: "([^"]+)"/g)].map((m) => m[1])).toEqual(["en-light", "en-dark", "he-light", "he-dark"]);
    const fake = BASE_SURFACE_IDS.map((id) => ({ id, open: async () => undefined, ready: "body" }));
    expect(percySurfaces(fake).map((s) => s.id)).toEqual([...PERCY_SCREEN_IDS]);
    expect(() => percySurfaces(fake.slice(1))).toThrow(/SURFACES changed/);
  });

  it("every command a screen opens is a registered palette command", () => {
    const src = sources(join(ROOT, "src/commands")).join("\n");
    for (const s of COMMAND_SURFACES) expect(src, s.command).toContain(`id: "${s.command}"`);
  });

  it("the canary moves RTL preview text by 2px and nothing else", () => {
    expect(RTL_CANARY_CSS).toMatch(/^\[dir="rtl"\] \.prose-lumen \{/);
    expect(RTL_CANARY_CSS).toContain("+ 2px");
  });

  it("outside `percy exec` nothing is sent", async () => {
    const calls: string[] = [];
    const f = (async (u: string) => {
      calls.push(String(u));
      throw new TypeError("connection refused");
    }) as unknown as typeof fetch;
    const page = { evaluate: async () => undefined, url: () => "http://localhost:4181/", context: () => ({ browser: () => null }) };
    expect(await percySnapshot(page as never, "x", {}, f, "http://127.0.0.1:5999")).toBe(false);
    expect(calls).toEqual(["http://127.0.0.1:5999/percy/healthcheck"]);
  });

  it("inside it: the CLI's serializer runs in the page and the snapshot is posted with its name, URL and widths", async () => {
    const posted: Array<{ url: string; body: Record<string, unknown> }> = [];
    const f = (async (u: string, init?: RequestInit) => {
      if (String(u).endsWith("/percy/healthcheck")) return new Response("{}", { status: 200 });
      if (String(u).endsWith("/percy/dom.js")) return new Response("window.PercyDOM={serialize:()=>({html:'<p>x</p>'})}", { status: 200 });
      posted.push({ url: String(u), body: JSON.parse(String(init?.body)) });
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const evaluated: unknown[] = [];
    const page = {
      evaluate: async (fn: unknown, arg?: unknown) => {
        evaluated.push(typeof fn === "string" ? "dom.js" : arg);
        return typeof fn === "string" ? undefined : { html: "<p>x</p>" };
      },
      url: () => "http://localhost:4181/",
      context: () => ({ browser: () => ({ version: () => "141.0" }) }),
    };
    expect(await percySnapshot(page as never, "split — he-dark", { widths: [1280] }, f, "http://127.0.0.1:5338")).toBe(true);
    expect(evaluated).toEqual(["dom.js", { enableJavaScript: false }]);
    expect(posted).toEqual([{ url: "http://127.0.0.1:5338/percy/snapshot", body: snapshotPayload("split — he-dark", "http://localhost:4181/", { html: "<p>x</p>" }, { widths: [1280] }, "playwright/141.0") }]);
    expect(posted[0].body.clientInfo).toBe(CLIENT_INFO);
    expect(await percyEnabled("http://127.0.0.1:5338", f)).toBe(true);
  });

  it("the runner pins the CLI, needs the token, and makes the canary a build of its own", () => {
    expect(PERCY_CLI).toMatch(/^@percy\/cli@\d+\.\d+\.\d+$/);
    expect(() => percyCommand([], {})).toThrow(/PERCY_TOKEN/);
    const c = percyCommand(["--canary"], { PERCY_TOKEN: "t" }, new Date("2026-11-14T00:00:00Z"));
    expect(c.args.slice(0, 4)).toEqual(["-y", PERCY_CLI, "exec", "--"]);
    expect(c.env.LUMEN_PERCY_CANARY).toBe("1");
    expect(c.env.PERCY_BRANCH).toBe("percy-canary/2026-11-14");
    expect(percyCommand([], { PERCY_TOKEN: "t" }).env.LUMEN_PERCY_CANARY).toBeUndefined();
  });
});
