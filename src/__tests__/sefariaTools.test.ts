/**
 * W11.H17 — Sefaria's four MCP tools (Sivan22/mcp-sefaria-server, MIT)
 * rewritten in TypeScript over the W5.1 client, as a built-in server of the
 * MCP servers screen. The responses are fixtures written from Sefaria's
 * OpenAPI schema (fixtures/sefaria-tools/SOURCES.md), not captured ones:
 * recording real responses is owed.
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { getText, getCommentaries, searchTexts, getDailyLearnings, sefariaAgentTools, SEFARIA_SERVER } from "../agents/mcp/sefariaTools";
import { serverAgentTools } from "../agents/mcp/tools";
import { SUGGESTED_SERVERS, type McpServerConfig } from "../agents/mcp/servers";
import type { ToolContext } from "../agents/types";

const fx = (n: string) => JSON.parse(readFileSync(`src/__tests__/fixtures/sefaria-tools/${n}`, "utf8"));

/** A fetch that answers from the fixtures and records every request. */
function recorder() {
  const calls: { url: string; method: string; body?: unknown }[] = [];
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, method: init?.method ?? "GET", body: init?.body ? JSON.parse(String(init.body)) : undefined });
    const file = url.includes("/api/v3/texts/") ? "texts-genesis-1-1.json" : url.includes("/api/links/") ? "links-genesis-1-1.json" : url.includes("/api/search-wrapper") ? "search-love.json" : url.includes("/api/calendars") ? "calendars.json" : null;
    if (!file) return new Response("not found", { status: 404 });
    return new Response(JSON.stringify(fx(file)), { status: 200, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("the four tools against the API shapes", () => {
  it("get_text: each version with its licence; a non-free version without its text", async () => {
    const { f, calls } = recorder();
    const a = await getText({ reference: "Genesis 1:1" }, f);
    expect(calls[0].url).toBe("https://www.sefaria.org/api/v3/texts/Genesis%201%3A1?version=source&version=translation&return_format=text_only");
    expect(a.heRef).toBe("בראשית א׳:א׳");
    expect(a.versions.map((v) => [v.language, v.license.rights, v.text === null])).toEqual([
      ["he", "cc-by-sa", false],
      ["en", "link-only", true],
    ]);
    expect(a.license.rights).toBe("link-only");
    const he = await getText({ reference: "Genesis 1:1", version_language: "he" }, f);
    expect(he.versions).toHaveLength(1);
    expect(he.license.rights).toBe("cc-by-sa");
  });
  it("get_commentaries: Commentary links only, de-duplicated, as references", async () => {
    const { f, calls } = recorder();
    const a = await getCommentaries({ reference: "Genesis 1:1" }, f);
    expect(calls[0].url).toBe("https://www.sefaria.org/api/links/Genesis%201%3A1?with_text=0&category=Commentary");
    expect(a.commentaries.map((c) => [c.commentator, c.ref])).toEqual([
      ["Rashi", "Rashi on Genesis 1:1:1"],
      ["Ramban", "Ramban on Genesis 1:1:1"],
    ]);
    expect(a.license.rights).toBe("link-only");
  });
  it("search_texts: POST to the search wrapper with Sefaria's text query; snippets without markup", async () => {
    const { f, calls } = recorder();
    const a = await searchTexts({ query: "love", filters: ["Tanakh/Torah"], size: 5 }, f);
    expect(calls[0]).toMatchObject({ url: "https://www.sefaria.org/api/search-wrapper", method: "POST", body: { query: "love", type: "text", field: "naive_lemmatizer", size: 5, filters: ["Tanakh/Torah"], filter_fields: [null] } });
    expect(a.total).toBe(2);
    expect(a.results[0]).toMatchObject({ ref: "Leviticus 19:18", heRef: "ויקרא י״ט:י״ח", snippet: "you shall love your neighbour as yourself" });
    expect(a.license.rights).toBe("link-only");
    await expect(searchTexts({ query: "  " }, f)).rejects.toThrow(/query is required/);
  });
  it("get_daily_learnings: the schedules with Sefaria links; a date and diaspora become parameters", async () => {
    const { f, calls } = recorder();
    const a = await getDailyLearnings({ date: "2026-11-15", diaspora: false }, f);
    expect(calls[0].url).toBe("https://www.sefaria.org/api/calendars?diaspora=0&year=2026&month=11&day=15");
    expect(a.items[0]).toMatchObject({ schedule: "Parashat Hashavua", heReading: "וירא", ref: "Genesis 18:1-22:24", url: "https://www.sefaria.org/Genesis.18.1-22.24" });
    expect(a.license.rights).toBe("link-only");
  });
});

describe("the built-in server under the servers screen's rules", () => {
  const on: McpServerConfig = { ...SEFARIA_SERVER, enabled: true, defaultPermission: "read" };
  const reach = (airplane: boolean) => () => ({ airplane, localOnly: false, desktop: false });
  const ctx = (f: typeof fetch): ToolContext => ({ grants: new Set(["network"]), fetch: f });

  it("is a suggested server, off until enabled, remote", () => {
    const s = SUGGESTED_SERVERS.find((x) => x.id === "sefaria")!;
    expect(s).toMatchObject({ transport: "http", url: "https://www.sefaria.org", builtin: true });
    expect(sefariaAgentTools(SEFARIA_SERVER, { reach: reach(false), confirmCall: () => true })).toEqual([]);
  });
  it("offers 4 tools with the network scope and Sefaria as outside content", async () => {
    const tools = await serverAgentTools(on, () => {
      throw new Error("no MCP transport for a built-in server");
    }, { reach: reach(false), confirmCall: () => true });
    expect(tools.map((t) => t.name)).toEqual(["sefaria_get_text", "sefaria_get_commentaries", "sefaria_search_texts", "sefaria_get_daily_learnings"]);
    for (const t of tools) expect([t.scope, t.networkTarget]).toEqual(["network", "https://www.sefaria.org"]);
    const { f } = recorder();
    const r = (await tools[0].run({ reference: "Genesis 1:1" }, ctx(f))) as { license: { rights: string } };
    expect(r.license.rights).toBe("link-only");
    expect(await tools[0].untrusted!({}, r, ctx(f))).toEqual(["Sefaria (sefaria.org)"]);
  });
  it("airplane mode: no tools are offered, and a tool taken before it sends nothing (0 requests)", async () => {
    let airplane = false;
    const o = { reach: () => ({ airplane, localOnly: false, desktop: false }), confirmCall: () => true };
    const tools = sefariaAgentTools(on, o);
    expect(tools).toHaveLength(4);
    airplane = true;
    expect(sefariaAgentTools(on, o)).toEqual([]);
    const { f, calls } = recorder();
    for (const t of tools) await expect(t.run({ reference: "Genesis 1:1", query: "love" }, ctx(f))).rejects.toThrow(/airplane mode/);
    expect(calls).toHaveLength(0);
  });
  it("'ask' asks per call; 'block' removes the tool; no gated fetch means no call", async () => {
    const asked: string[] = [];
    const ask: McpServerConfig = { ...on, defaultPermission: "ask", tools: { search_texts: "block" } };
    const tools = sefariaAgentTools(ask, { reach: reach(false), confirmCall: (_s, name) => (asked.push(name), false) });
    expect(tools.map((t) => t.name)).not.toContain("sefaria_search_texts");
    const { f, calls } = recorder();
    await expect(tools[0].run({ reference: "Genesis 1:1" }, ctx(f))).rejects.toThrow(/did not allow/);
    expect(asked).toEqual(["get_text"]);
    await expect(tools[0].run({ reference: "Genesis 1:1" }, { grants: new Set() })).rejects.toThrow(/no network permission/);
    expect(calls).toHaveLength(0);
  });
});
