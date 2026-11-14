/**
 * Plan W7.6: data.gov.il and CBS data in a note — 10 common datasets are
 * fetched, saved as a local CSV snapshot and shown with a full attribution
 * (10/10); opening the note offline makes 0 requests; the attribution is a
 * line of the note, so PDF and DOCX exports carry it; refresh shows a diff;
 * personal-looking columns get a warning.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { datastoreUrl, parseSearch, searchUrl, seriesUrl } from "../sources/datagov/api";
import { importResource, importSeries, refreshBlock, type FileStore } from "../sources/datagov/core";
import { attribution, CBS_TERMS, diffSnapshots, insertion, parseBlock, parseCsv, personalColumns, toCsv, verifiedSnapshot } from "../sources/datagov/snapshot";

interface Fixture {
  source: "datagov" | "cbs";
  slug?: string;
  resource?: string;
  series?: string;
  package_show?: unknown;
  datastore_search?: { result: { records: Array<Record<string, unknown>> } };
  series_data?: unknown;
}
const FIX: { datasets: Fixture[]; package_search: unknown } = JSON.parse(readFileSync(join(__dirname, "fixtures", "datagov", "datasets.json"), "utf8"));

function memory(): FileStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c) };
}

/** The recorded services: CKAN package_show / datastore_search, and the CBS series API. */
function services(mutate?: (records: Array<Record<string, unknown>>) => Array<Record<string, unknown>>) {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const json = (body: unknown) => new Response(JSON.stringify(body), { status: 200, headers: { "content-type": "application/json" } });
    if (url.pathname.endsWith("/package_show")) return json(FIX.datasets.find((d) => d.slug === url.searchParams.get("id"))!.package_show);
    if (url.pathname.endsWith("/package_search")) return json(FIX.package_search);
    if (url.pathname.endsWith("/datastore_search")) {
      const d = FIX.datasets.find((x) => x.resource === url.searchParams.get("resource_id"))!;
      const body = structuredClone(d.datastore_search)!;
      if (mutate) body.result.records = mutate(body.result.records);
      return json(body);
    }
    if (url.hostname === "apis.cbs.gov.il") return json(FIX.datasets.find((x) => x.series === url.searchParams.get("id"))!.series_data);
    return new Response("not found", { status: 404 });
  });
}

describe("the APIs", () => {
  it("asks CKAN and the CBS with no key, only for what the user picked", () => {
    expect(searchUrl("תאונות דרכים")).toBe(`https://data.gov.il/api/3/action/package_search?q=${encodeURIComponent("תאונות דרכים")}&rows=10`);
    expect(datastoreUrl("abc", 50000)).toBe("https://data.gov.il/api/3/action/datastore_search?resource_id=abc&limit=32000");
    expect(seriesUrl("120010")).toBe("https://apis.cbs.gov.il/series/data/list?id=120010&format=json&download=false");
    expect(parseSearch(FIX.package_search).map((h) => h.title)).toEqual(["אוכלוסייה ביישובים", "רשימת רחובות בישראל"]);
  });
});

describe("10 common datasets: fetched, saved, shown, attributed", () => {
  it("10/10 with a complete attribution", async () => {
    expect(FIX.datasets.length).toBe(10);
    let complete = 0;
    for (const d of FIX.datasets) {
      const store = memory();
      const f = services();
      const r = d.source === "cbs" ? await importSeries(d.series!, { fetch: f as unknown as typeof fetch, store, retrieved: "2026-11-14" }) : await importResource({ name: d.slug! }, d.resource!, { fetch: f as unknown as typeof fetch, store, retrieved: "2026-11-14" });
      const csv = store.files.get(r.block.snapshot)!;
      expect(r.rows, d.slug ?? d.series).toBeGreaterThan(0);
      expect(parseCsv(csv).rows.length).toBe(r.rows);
      const line = attribution(r.block);
      const parts =
        d.source === "cbs"
          ? ['הלשכה המרכזית לסטטיסטיקה (הלמ"ס)', r.block.title, "(14.11.2026)", "ניתן לצפייה באתר: https://apis.cbs.gov.il/", "as is", CBS_TERMS]
          : ["data.gov.il", `"${r.block.title}"`, "עודכן 1.9.2026", "נשלף 14.11.2026", `https://data.gov.il/dataset/${d.slug}/resource/${d.resource}`];
      if (parts.every((p) => line.includes(p)) && r.markdown.includes(line)) complete++;
    }
    expect(complete).toBe(10);
  });

  it("the attribution is a line of the note, under the block (so exports carry it)", async () => {
    const r = await importResource({ name: "road-accidents" }, FIX.datasets[1].resource!, { fetch: services() as unknown as typeof fetch, store: memory(), retrieved: "2026-11-14" });
    const [block, rest] = r.markdown.split("```\n\n");
    expect(block.startsWith("```dataset\n")).toBe(true);
    expect(rest.trim()).toBe(attribution(r.block));
    expect(parseBlock(block.replace(/^```dataset\n/, ""))!.snapshot).toBe(r.block.snapshot);
  });
});

describe("offline, refresh and the personal-data warning", () => {
  it("the note's data is the local CSV: reading it makes 0 requests", async () => {
    const store = memory();
    const r = await importSeries("120010", { fetch: services() as unknown as typeof fetch, store, retrieved: "2026-11-14" });
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", offline);
    try {
      const csv = await store.read(r.block.snapshot);
      expect(parseCsv(csv!).rows).toEqual([
        ["2026-09", "105.1"],
        ["2026-10", "105.4"],
      ]);
      expect(offline).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("refresh writes a new snapshot and shows what changed", async () => {
    const store = memory();
    const first = await importResource({ name: "population-in-settlements" }, FIX.datasets[0].resource!, { fetch: services() as unknown as typeof fetch, store, retrieved: "2026-11-01" });
    const later = services((recs) => [...recs.map((r) => (r["שם_ישוב"] === "חיפה" ? { ...r, "סך_הכל_אוכלוסייה": 291000 } : r)).filter((r) => r["שם_ישוב"] !== "תל אביב - יפו"), { _id: 9, "סמל_ישוב": 7000, "שם_ישוב": "לוד", "סך_הכל_אוכלוסייה": 90000 }]);
    const r = await refreshBlock(first.markdown.split("```\n")[0].replace(/^```dataset\n/, ""), { fetch: later as unknown as typeof fetch, store, retrieved: "2026-11-14" });
    expect(r!.after.block.snapshot).not.toBe(first.block.snapshot);
    expect(store.files.has(first.block.snapshot)).toBe(true);
    expect(r!.diff.added.map((x) => x[1])).toEqual(["לוד"]);
    expect(r!.diff.removed.map((x) => x[1])).toEqual(["תל אביב - יפו"]);
    expect(r!.diff.changed.map((c) => [c.key, c.after[2]])).toEqual([["4000", "291000"]]);
  });

  it("a diff without a unique key compares whole rows", () => {
    const d = diffSnapshots("a,b\n1,x\n1,y\n", "a,b\n1,x\n1,z\n");
    expect(d.added).toEqual([["1", "z"]]);
    expect(d.removed).toEqual([["1", "y"]]);
  });

  it("warns on personal-looking columns, not on place names", () => {
    expect(personalColumns(["שם_ישוב", "סמל_ישוב", "שם_רחוב", "עיר"])).toEqual([]);
    expect(personalColumns(["שם_פרטי", "ת.ז", "טלפון", "email", "mispar_rechev", "תאריך_לידה", "count"])).toEqual(["שם_פרטי", "ת.ז", "טלפון", "email", "mispar_rechev", "תאריך_לידה"]);
  });

  it("remote fields can't leave the block (RR20-3)", () => {
    const md = insertion({ source: "datagov", id: "r1", title: "T", snapshot: "Data/datagov/r1/2026-11-14.csv", retrieved: "2026-11-14", view: "table", organization: "a\n---", updated: null, dataset: "slug\n```\n<b>Z1Z</b>" });
    expect(md).not.toMatch(/^```\n<b>/m);
    expect(md.split("\n").filter((l) => l.startsWith("```")).length).toBe(2);
    expect(parseBlock(md.split("```dataset\n")[1].split("\n```")[0])!.dataset).toBe("slug\n```\n<b>Z1Z</b>");
  });

  it("a block reads only the file it wrote: its own folder, and its hash (RR20-4)", async () => {
    expect(parseBlock("source: datagov\nid: r1\nsnapshot: Private/diary.md\n")).toBe(null);
    expect(parseBlock("source: datagov\nid: r1\nsnapshot: Data/datagov/other/2026-11-14.csv\n")).toBe(null);
    expect(parseBlock("source: cbs\nid: r1\nsnapshot: Data/datagov/r1/2026-11-14.csv\n")).toBe(null);
    const store = memory();
    const r = await importSeries("120010", { fetch: services() as unknown as typeof fetch, store, retrieved: "2026-11-14" });
    expect(r.block.sha256).toMatch(/^[0-9a-f]{64}$/);
    const back = parseBlock(r.markdown.split("```dataset\n")[1].split("\n```")[0])!;
    expect(await verifiedSnapshot(back, store.read)).toBe(store.files.get(r.block.snapshot));
    store.files.set(r.block.snapshot, "edited,elsewhere\n");
    expect(await verifiedSnapshot(back, store.read)).toBe(null);
    expect(await verifiedSnapshot({ ...back, sha256: null }, store.read)).toBe(null);
  });

  it("CSV round-trips quotes, commas and new lines", () => {
    const t = { fields: [{ id: "a", type: "text" }, { id: "b", type: "text" }], rows: [{ a: 'say "hi"', b: "x,y" }, { a: "two\nlines", b: null }], total: 2 };
    expect(parseCsv(toCsv(t))).toEqual({ header: ["a", "b"], rows: [['say "hi"', "x,y"], ["two\nlines", ""]] });
  });
});
