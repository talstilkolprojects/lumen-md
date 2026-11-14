/**
 * Plan W5.23 — Zotero sync through the Web API, without Zotero Desktop:
 * the key's access check, a first sync of a 1,000-item library, a second
 * sync that asks only for changes (If-Modified-Since-Version → 304, and
 * `since=` for the changed and deleted items), notes and PDFs as vault notes
 * with their [@key], Backoff / 429, and the route in the ledger, the CSP and
 * the secret store. api.zotero.org is not reachable here: the server below
 * answers from fixtures written from the API's documentation
 * (fixtures/zotero-web/SOURCES.md).
 */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { emptyState, itemNotes, stateCsl, syncZoteroWeb, zoteroWebGet, ZoteroWebError, type WebGet, type WebResponse } from "../citations/zoteroWeb";
import { fromCslJson } from "../citations/library";
import { classify, blockedByPolicy } from "../ai/privacyLedger";
import { isSecretName } from "../lib/secretStore";

const FX = join(__dirname, "fixtures/zotero-web");
const fx = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8"));

interface Item {
  key: string;
  version: number;
  data: Record<string, unknown>;
  csljson?: Record<string, unknown>;
}

/** A Zotero Web API v3 stand-in: a user library with versions, deletions and the documented headers. */
function fakeZotero(n: number) {
  let version = 1000;
  const items = new Map<string, Item>();
  const deleted = new Map<string, number>();
  const collections = fx("collections.json") as Item[];
  const id = (i: number) => `I${String(i).padStart(7, "0")}`;
  for (let i = 0; i < n; i++) {
    const key = id(i);
    items.set(key, { key, version: 1 + (i % 900), data: { itemType: "journalArticle", title: `Paper ${i}`, collections: i % 10 ? [] : ["COLL0001"] }, csljson: { id: `475425/${key}`, type: "article-journal", title: `Paper ${i}`, author: [{ family: `Author${i % 50}`, given: "A." }], issued: { "date-parts": [[2000 + (i % 25)]] } } });
  }
  for (const f of ["item-book-he.json", "item-note.json", "item-pdf.json"]) {
    const it = fx(f) as Item;
    items.set(it.key, it);
  }
  const log: Array<{ path: string; headers: Record<string, string> }> = [];
  const res = (status: number, body: unknown, headers: Record<string, string> = {}): WebResponse => {
    const h = new Headers({ "Last-Modified-Version": String(version), ...headers });
    return { status, headers: h, body: status === 304 ? "" : JSON.stringify(body) };
  };
  let keyFile = "keys-current.json";
  const get: WebGet = async (path, headers = {}) => {
    log.push({ path, headers });
    const u = new URL(`https://api.zotero.org${path}`);
    const since = Number(u.searchParams.get("since") ?? 0);
    if (u.pathname === "/keys/current") return res(200, fx(keyFile));
    if (!u.pathname.startsWith("/users/475425/")) return res(403, "Forbidden");
    const ims = Number(headers["If-Modified-Since-Version"] ?? 0);
    if (ims && ims >= version) return res(304, null);
    const rest = u.pathname.slice("/users/475425".length);
    if (rest === "/items" && u.searchParams.get("format") === "versions") return res(200, Object.fromEntries([...items].filter(([, it]) => it.version > since).map(([k, it]) => [k, it.version])));
    if (rest === "/items" && u.searchParams.get("itemKey")) {
      const keys = (u.searchParams.get("itemKey") ?? "").split(",");
      if (keys.length > 50) return res(400, "Too many keys");
      return res(200, keys.map((k) => items.get(k)).filter(Boolean));
    }
    if (rest === "/collections" && u.searchParams.get("format") === "versions") return res(200, Object.fromEntries(collections.filter((c) => c.version > since).map((c) => [c.key, c.version])));
    if (rest === "/collections") return res(200, collections.filter((c) => (u.searchParams.get("collectionKey") ?? "").split(",").includes(c.key)));
    if (rest === "/deleted") return res(200, { items: [...deleted].filter(([, v]) => v > since).map(([k]) => k), collections: [], searches: [], tags: [], settings: [] });
    return res(404, "Not found");
  };
  return {
    get,
    log,
    items,
    setKeyFile: (f: string) => (keyFile = f),
    edit(keys: string[]) {
      version++;
      for (const k of keys) {
        const it = items.get(k)!;
        it.version = version;
        (it.csljson as { title: string }).title += " (rev.)";
      }
    },
    add(key: string) {
      version++;
      items.set(key, { key, version, data: { itemType: "book", title: "New book", collections: [] }, csljson: { id: `475425/${key}`, type: "book", title: "New book" } });
    },
    remove(keys: string[]) {
      version++;
      for (const k of keys) {
        items.delete(k);
        deleted.set(k, version);
      }
    },
  };
}

describe("W5.23 first sync", () => {
  it("1,000 items: every top-level item in the CSL copy, in ≤ 50-key batches, well inside 60 s", async () => {
    const z = fakeZotero(1000);
    const t0 = performance.now();
    const r = await syncZoteroWeb(emptyState(), z.get);
    const ms = performance.now() - t0;
    expect(r.state.userID).toBe(475425);
    expect(r.state.version).toBe(1000);
    expect(r.changed).toBe(1003);
    const csl = stateCsl(r.state);
    expect(csl).toHaveLength(1001); // the note and the PDF are children, not sources
    expect(z.log.filter((l) => l.path.includes("itemKey=")).length).toBe(Math.ceil(1003 / 50));
    // 1 key check + 1 versions + 1 collection versions + 1 collection batch + 21 item batches.
    expect(r.requests).toBe(25);
    // Even at 2 s per request (a slow phone network) the sync stays under the plan's 60 s.
    expect(r.requests * 2000).toBeLessThan(60_000);
    expect(ms).toBeLessThan(60_000);
    const lib = fromCslJson(JSON.stringify(csl), ".lumen/zotero-library.csl.json", "zotero");
    expect(lib.find((x) => x.key === "oz2002")?.record.title).toBe("סיפור על אהבה וחושך");
  });

  it("the key must read the library", async () => {
    const z = fakeZotero(1);
    z.setKeyFile("keys-no-library.json");
    await expect(syncZoteroWeb(emptyState(), z.get)).rejects.toMatchObject({ reason: "no-library-access" });
  });
});

describe("W5.23 second sync adds only changes", () => {
  it("nothing changed: one request, answered 304 to If-Modified-Since-Version", async () => {
    const z = fakeZotero(1000);
    const first = await syncZoteroWeb(emptyState(), z.get);
    z.log.length = 0;
    const again = await syncZoteroWeb(first.state, z.get);
    expect(again.notModified).toBe(true);
    expect(again.requests).toBe(1);
    expect(z.log[0].headers["If-Modified-Since-Version"]).toBe("1000");
    expect(again.state).toEqual(first.state);
  });

  it("3 edited, 1 added, 2 deleted: only those 4 items are fetched, the 2 are gone", async () => {
    const z = fakeZotero(1000);
    const first = await syncZoteroWeb(emptyState(), z.get);
    z.edit(["I0000001", "I0000002", "I0000500"]);
    z.add("NEWB0001");
    z.remove(["I0000003", "I0000004"]);
    z.log.length = 0;
    const r = await syncZoteroWeb(first.state, z.get);
    expect(r.notModified).toBe(false);
    expect(r.changed).toBe(4);
    expect(r.deleted).toBe(2);
    const batch = z.log.find((l) => l.path.includes("itemKey="))!.path;
    expect(new URL(`https://x${batch}`).searchParams.get("itemKey")!.split(",").sort()).toEqual(["I0000001", "I0000002", "I0000500", "NEWB0001"]);
    expect(z.log.find((l) => l.path.includes("format=versions"))!.path).toContain("since=1000");
    expect(z.log.find((l) => l.path.includes("/deleted"))!.path).toContain("since=1000");
    const titles = stateCsl(r.state).map((c) => c.title);
    expect(titles).toContain("Paper 1 (rev.)");
    expect(titles).toContain("New book");
    expect(titles).not.toContain("Paper 3");
    expect(stateCsl(r.state)).toHaveLength(1001 + 1 - 2);
    expect(r.state.version).toBe(1003);
  });
});

describe("W5.23 notes and PDFs into the vault", () => {
  it("an item's child note and PDF become one note headed with its [@key], in its collection", async () => {
    const z = fakeZotero(0);
    const { state } = await syncZoteroWeb(emptyState(), z.get);
    const notes = itemNotes(state, (k) => (k === "ABCD2345" ? "oz2002" : null), (h) => h.replace(/<strong>(.*?)<\/strong>/g, "**$1**").replace(/<[^>]+>/g, ""));
    expect(notes).toEqual([
      {
        path: "Zotero/oz2002.md",
        content:
          '---\nsource: "zotero"\nzotero: "ABCD2345"\ncitekey: "oz2002"\ncollections: ["ספרות עברית"]\n---\n\n# סיפור על אהבה וחושך [@oz2002]\n\n## Notes\n\n**פרק 3**: הזיכרון של ירושלים.\n\n## PDF\n\n- [Oz - 2002 - Sipur.pdf](zotero://open-pdf/library/items/PDFX2345) · [zotero.org](https://www.zotero.org/lumen-test/items/PDFX2345)\n',
      },
    ]);
  });
});

describe("W5.23 the network: rate limits, refusals, the ledger, CSP and secrets", () => {
  it("429 with Retry-After is waited out and retried; Backoff delays the next request", async () => {
    const waits: number[] = [];
    let n = 0;
    const seen: Array<Record<string, string>> = [];
    const doFetch = async (_url: string, init: RequestInit) => {
      seen.push(init.headers as Record<string, string>);
      n++;
      if (n === 1) return new Response("slow down", { status: 429, headers: { "Retry-After": "2" } });
      return new Response("{}", { status: 200, headers: { Backoff: "5" } });
    };
    const get = zoteroWebGet("k3y", doFetch, async (ms) => void waits.push(ms));
    await get("/keys/current");
    expect(waits).toEqual([2000]);
    expect(seen[0]).toMatchObject({ "Zotero-API-Key": "k3y", "Zotero-API-Version": "3" });
    await get("/users/1/items?format=versions");
    expect(waits.length).toBe(2);
    expect(waits[1]).toBeGreaterThan(4000);
  });

  it("a refused key is an error the command can act on", async () => {
    const get: WebGet = async () => ({ status: 403, headers: new Headers(), body: "Invalid key" });
    const err = await syncZoteroWeb(emptyState(), get).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ZoteroWebError);
    expect((err as ZoteroWebError).reason).toBe("forbidden");
  });

  it("api.zotero.org is a cloud route in the ledger (blocked by a local-only policy); the key is a secret; the CSP allows it", () => {
    const c = classify("https://api.zotero.org/users/1/items?format=versions");
    expect(c?.category).toBe("research");
    expect(blockedByPolicy(c!.category, "local-only")).toBe(true);
    expect(isSecretName("lumen.zotero.apiKey")).toBe(true);
    for (const f of ["security/policy.json", "index.html", "public/_headers", "deploy/nginx.conf", "src-tauri/tauri.conf.json"]) {
      expect(readFileSync(join(__dirname, "../..", f), "utf8"), f).toContain("https://api.zotero.org");
    }
  });
});
