import { describe, it, expect, beforeEach } from "vitest";
import { searchWeb } from "../research/client";

beforeEach(() => localStorage.clear());

function capture() {
  const bodies: Record<string, unknown>[] = [];
  const fetchImpl = (async (_i: RequestInfo | URL, o?: RequestInit) => {
    bodies.push(JSON.parse(String(o?.body)));
    return new Response(JSON.stringify({ results: [] }), { status: 200 });
  }) as typeof fetch;
  return { bodies, fetchImpl };
}

describe("#205 P1: a leftover Brave/Tavily key never rides along with a SearXNG search", () => {
  it("searchWeb omits the key for a keyless provider", async () => {
    const { bodies, fetchImpl } = capture();
    await searchWeb("q", { provider: "searxng", key: "brave-secret" }, 5, undefined, "http://localhost:8787", fetchImpl);
    expect(bodies[0]).not.toHaveProperty("key");
    expect(JSON.stringify(bodies[0])).not.toContain("brave-secret");
  });

  it("searchWeb still sends the key to a keyed provider", async () => {
    const { bodies, fetchImpl } = capture();
    await searchWeb("q", { provider: "brave", key: "brave-secret" }, 5, undefined, "http://localhost:8787", fetchImpl);
    expect(bodies[0]).toMatchObject({ key: "brave-secret" });
  });

});
