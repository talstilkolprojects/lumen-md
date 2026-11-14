// @vitest-environment node
/** PW_CHROMIUM works with the repo's playwright.config.ts, not only a lane's generated config. */
import { describe, it, expect, vi, afterEach } from "vitest";

type Project = { name: string; use: { launchOptions?: { executablePath?: string } } };
async function chromium(): Promise<Project> {
  vi.resetModules();
  const { default: config } = await import("../../playwright.config");
  return (config.projects as Project[]).find((p) => p.name === "chromium")!;
}

describe("playwright.config.ts", () => {
  afterEach(() => vi.unstubAllEnvs());

  it("uses PW_CHROMIUM as the chromium project's executable", async () => {
    vi.stubEnv("PW_CHROMIUM", "/opt/chromium/chrome");
    expect((await chromium()).use.launchOptions?.executablePath).toBe("/opt/chromium/chrome");
  });

  it("leaves Playwright's own Chromium alone without it", async () => {
    vi.stubEnv("PW_CHROMIUM", "");
    expect((await chromium()).use.launchOptions?.executablePath).toBeUndefined();
  });
});
