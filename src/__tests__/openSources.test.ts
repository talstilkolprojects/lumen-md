/**
 * Plan W7.24: one search over the open sources. 20 golden queries (verse,
 * law, poem, statistical series) find the right result in the top 3 (≥ 18);
 * every result has a rights badge; link-only content is never copied in
 * full; a source that is off is sent nothing.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { insertionFor, merge, searchLocal, searchOnline, type LocalSources, type OpenResult } from "../sources/open/search";
import { ALL_RIGHTS, mayCopy } from "../sources/open/rights";
import { Library, parseCatalogue, plain } from "../sources/benyehuda/library";
import { parseLawNote, renderLawNote } from "../sources/knesset/store";
import { rowsOf, toLaw, type Law } from "../sources/knesset/odata";

const F = (...p: string[]) => readFileSync(join(__dirname, "fixtures", ...p), "utf8");
const LAWS_JSON = JSON.parse(F("knesset", "laws.v4.json"));
const LAWS: Law[] = rowsOf(LAWS_JSON).map(toLaw).filter((l): l is Law => l !== null);
const ASK: { laws: Record<string, string> } = JSON.parse(F("knesset", "askTheLaw.json"));
const DATASETS: { datasets: Array<{ source: string; package_show?: { result: Record<string, unknown> } }> } = JSON.parse(F("datagov", "datasets.json"));
const CATALOGUE = parseCatalogue(F("benyehuda", "pseudocatalogue.csv"));

const SAVED = Object.entries(ASK.laws).map(([name, text]) => parseLawNote(`Sources/Knesset/Laws/${name}.md`, renderLawNote(LAWS.find((l) => l.name === name)!, "2026-11-14", text))!);
const ALL_ON = { sefaria: true, knesset: true, datagov: true, benyehuda: true };
const LOCAL: LocalSources = { enabled: ALL_ON, laws: SAVED, library: new Library(CATALOGUE) };

/** data.gov.il's package_search, recorded: titles containing a word of the query. */
const ckan = vi.fn(async (input: RequestInfo | URL) => {
  const url = new URL(String(input));
  const words = (url.searchParams.get("q") ?? "").split(/\s+/);
  const results = DATASETS.datasets.filter((d) => d.package_show && words.some((w) => String(d.package_show!.result.title).includes(w))).map((d) => d.package_show!.result);
  if (url.hostname === "knesset.gov.il") return new Response(JSON.stringify({ value: [] }), { status: 200 });
  return new Response(JSON.stringify({ success: true, result: { count: results.length, results } }), { status: 200 });
});

const GOLDEN: Array<{ q: string; want: (r: OpenResult) => boolean }> = [
  // verses
  { q: "בראשית א:א", want: (r) => r.payload.ref?.key === "Genesis.1.1" },
  { q: "שמות כ׳ ג׳", want: (r) => r.payload.ref?.key === "Exodus.20.3" },
  { q: "Berakhot 2a", want: (r) => r.payload.ref?.key === "Berakhot.2a" },
  { q: "ויקרא יט יח", want: (r) => r.payload.ref?.key === "Leviticus.19.18" },
  { q: "תהלים כג:א", want: (r) => r.payload.ref?.key === "Psalms.23.1" },
  // laws (saved)
  { q: "חוק הגנת הפרטיות", want: (r) => r.title.startsWith("חוק הגנת הפרטיות") },
  { q: "חוק יסוד: כבוד האדם וחירותו", want: (r) => r.title === "חוק-יסוד: כבוד האדם וחירותו" },
  { q: "חוק זכות יוצרים", want: (r) => r.title.startsWith("חוק זכות יוצרים") },
  { q: "ח״י: חופש העיסוק", want: (r) => r.title === "חוק-יסוד: חופש העיסוק" },
  { q: "[[חוק:חופש המידע]]", want: (r) => r.title.startsWith("חוק חופש המידע") },
  // poems and prose (Ben-Yehuda)
  { q: "ביאליק בריכה", want: (r) => r.kind === "work" && plain(r.title) === "הברכה" },
  { q: "רחל כנרת", want: (r) => r.kind === "work" && plain(r.title) === "כנרת" },
  { q: "הכניסיני תחת כנפך", want: (r) => r.kind === "work" && plain(r.title).startsWith("הכניסיני תחת כנפך") },
  { q: "טשרניחובסקי אני מאמין", want: (r) => r.kind === "work" && plain(r.title) === "אני מאמין" },
  { q: "ספר הקבצנים", want: (r) => r.kind === "work" && plain(r.title) === "ספר הקבצנים" },
  // statistical series and datasets
  { q: "מדד המחירים לצרכן", want: (r) => r.payload.seriesId === "120010" },
  { q: "תאונות דרכים", want: (r) => r.kind === "dataset" && r.title.includes("תאונות דרכים") },
  { q: "אוכלוסייה ביישובים", want: (r) => r.kind === "dataset" && r.title.includes("אוכלוסייה") },
  { q: "מחירי דלק", want: (r) => r.kind === "dataset" && r.title.includes("דלק") },
  { q: "סניפי בנקים", want: (r) => r.kind === "dataset" && r.title.includes("בנקים") },
];

async function both(q: string): Promise<OpenResult[]> {
  return merge(searchLocal(q, LOCAL), await searchOnline(q, ALL_ON, ckan as unknown as typeof fetch));
}

describe("one search over the open sources", () => {
  it("20 golden queries: the right result in the top 3 in at least 18", async () => {
    let right = 0;
    const wrong: string[] = [];
    for (const g of GOLDEN) {
      const top = (await both(g.q)).slice(0, 3);
      if (top.some(g.want)) right++;
      else wrong.push(`${g.q} → ${top.map((r) => r.title).join(" | ")}`);
    }
    expect(right, wrong.join("; ")).toBeGreaterThanOrEqual(18);
  });

  it("every result has a rights badge", async () => {
    const all = (await Promise.all(GOLDEN.map((g) => both(g.q)))).flat();
    expect(all.length).toBeGreaterThan(20);
    expect(all.filter((r) => !ALL_RIGHTS.includes(r.rights))).toEqual([]);
  });

  it("link-only content is never copied in full; copyable content comes with its credit", () => {
    const secret = "תוכן מוגן שאסור להעתיק";
    const linkOnly: OpenResult = { key: "x", source: "sefaria", kind: "verse", title: "בראשית א׳:א׳", detail: "", rights: "link-only", url: "https://www.sefaria.org/Genesis.1.1", local: true, payload: {} };
    expect(mayCopy("link-only")).toBe(false);
    expect(insertionFor(linkOnly, secret)).not.toContain(secret);
    expect(insertionFor(linkOnly, secret)).toContain("(https://www.sefaria.org/Genesis.1.1)");
    const work = searchLocal("ביאליק בריכה", LOCAL)[0];
    const q = insertionFor(work, "אני יודע ברכה צנועה אחת:");
    expect(q).toContain("> אני יודע ברכה צנועה אחת:");
    expect(q).toContain("רשות הציבור");
    const law = searchLocal("חוק הגנת הפרטיות", LOCAL)[0];
    expect(insertionFor(law, null)).toContain("סעיף 6 לחוק זכות יוצרים");
  });

  it("a source that is off is sent nothing, and its local results are not shown", async () => {
    const f = vi.fn(async () => new Response("{}"));
    const off = { sefaria: false, knesset: false, datagov: false, benyehuda: false };
    expect(await searchOnline("תאונות דרכים", off, f as unknown as typeof fetch)).toEqual([]);
    expect(f).not.toHaveBeenCalled();
    expect(searchLocal("בראשית א:א", { ...LOCAL, enabled: off })).toEqual([]);
    const onlyLaws = await searchOnline("חוק הגנת הפרטיות", { ...off, knesset: true }, f as unknown as typeof fetch);
    expect(onlyLaws).toEqual([]);
    expect(f.mock.calls.every(([u]: unknown[]) => String(u).startsWith("https://knesset.gov.il/"))).toBe(true);
  });

  it("filters by kind", () => {
    expect(searchLocal("ביאליק בריכה", LOCAL, "law")).toEqual([]);
    expect(searchLocal("ביאליק בריכה", LOCAL, "work").every((r) => r.kind === "work")).toBe(true);
  });
});
