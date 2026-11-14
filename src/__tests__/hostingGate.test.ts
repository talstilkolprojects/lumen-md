// @vitest-environment node
/**
 * Plan W6.9: no first payment while production is on Vercel Hobby
 * (deploy/hosting.json, scripts/lib/hostingGate.mjs, `npm run hosting:gate`).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
// @ts-expect-error -- plain .mjs script, no types
import { currentHost, hostingGate } from "../../scripts/lib/hostingGate.mjs";

const ROOT = resolve(__dirname, "..", "..");
const hosting = JSON.parse(readFileSync(join(ROOT, "deploy/hosting.json"), "utf8"));
const PAY = { VITE_BILLING_ENDPOINT: "https://billing.lumen-test.dev/checkout" };

describe("hosting gate", () => {
  it("the checked-in declaration: production on Vercel Hobby, not commercial", () => {
    expect(hosting.production).toBe("vercel");
    expect(hosting.hosts.vercel).toMatchObject({ plan: "hobby", commercial: false });
    expect(hosting.hosts["cloudflare-pages"].commercial).toBe(true);
  });

  it("a build without payments passes on every host", () => {
    for (const env of [{}, { VERCEL: "1" }, { CF_PAGES: "1" }]) expect(hostingGate(hosting, env).ok).toBe(true);
  });

  it("a Vercel Hobby build that takes payments fails", () => {
    const r = hostingGate(hosting, { VERCEL: "1", ...PAY });
    expect(r.ok).toBe(false);
    expect(r.commercialVars).toEqual(["VITE_BILLING_ENDPOINT"]);
    expect(r.problems.join("\n")).toContain("vercel (hobby) does not allow commercial use");
  });

  it("payments on the second host still fail while production is on Hobby, and pass after the cut-over", () => {
    expect(hostingGate(hosting, PAY, ["--host", "cloudflare-pages"]).ok).toBe(false);
    const moved = { ...hosting, production: "cloudflare-pages" };
    expect(hostingGate(moved, PAY, ["--host", "cloudflare-pages"]).ok).toBe(true);
    expect(hostingGate(moved, { VERCEL: "1", ...PAY }).ok).toBe(false);
  });

  it("LUMEN_COMMERCIAL=1 counts; placeholders and 0 do not", () => {
    expect(hostingGate(hosting, { VERCEL: "1", LUMEN_COMMERCIAL: "1" }).ok).toBe(false);
    expect(hostingGate(hosting, { VERCEL: "1", LUMEN_COMMERCIAL: "0" }).ok).toBe(true);
    expect(hostingGate(hosting, { VERCEL: "1", VITE_BILLING_ENDPOINT: "https://your-edge.example.com/checkout" }).ok).toBe(true);
  });

  it("knows the host from the environment or --host", () => {
    expect(currentHost({ VERCEL: "1" })).toBe("vercel");
    expect(currentHost({ CF_PAGES: "1" })).toBe("cloudflare-pages");
    expect(currentHost({}, ["--host", "cloudflare-pages"])).toBe("cloudflare-pages");
    expect(currentHost({})).toBeNull();
  });
});
