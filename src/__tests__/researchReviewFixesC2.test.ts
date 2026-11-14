import { describe, it, expect, beforeEach } from "vitest";
import { readFileSync } from "node:fs";
import { getResearchSettings, usableResearchEndpoint } from "../research/client";

beforeEach(() => localStorage.clear());

describe("C2 review fixes", () => {
  it("an explicit local-only policy keeps the keyless SearXNG default despite a leftover Anthropic key", () => {
    localStorage.setItem("lumen.ai.key.anthropic", "sk-ant-x");
    expect(getResearchSettings().provider).toBe("claude");
    localStorage.setItem("lumen.ai.policy", "local-only");
    expect(getResearchSettings().provider).toBe("searxng");
  });

  it("validates a research endpoint before it is stored", () => {
    expect(usableResearchEndpoint("http://localhost:8787/")).toBe("http://localhost:8787");
    expect(usableResearchEndpoint("not a url")).toBeNull();
    expect(usableResearchEndpoint("ftp://localhost:8787")).toBeNull();
  });

  it("the local worker accepts the canonical, hosted and desktop origins, and the list is configurable", () => {
    const yml = readFileSync("docker/local-ai.yml", "utf8");
    for (const o of ["https://lumen-md.vercel.app", "tauri://localhost"]) expect(yml).toContain(o);
    expect(yml).toContain("${LUMEN_ORIGINS:-");
  });

  it("the desktop CSP allows the local Ollama, research and grammar ports", () => {
    const csp = JSON.parse(readFileSync("src-tauri/tauri.conf.json", "utf8")).app?.security?.csp ?? readFileSync("src-tauri/tauri.conf.json", "utf8");
    for (const port of [11434, 8787, 8010]) expect(String(csp)).toContain(`http://localhost:${port}`);
  });
});
