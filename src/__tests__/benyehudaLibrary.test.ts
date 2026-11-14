/**
 * Plan W7.7: an offline Project Ben-Yehuda library. "ביאליק בריכה" finds
 * "הבריכה" first; 20 golden queries, at least 18 right in the top 3; after
 * the download, search and reading make 0 requests; nothing outside the
 * dump's public-domain catalogue is indexed.
 *
 * The catalogue fixture is a real excerpt of the dump's pseudocatalogue.csv
 * (VERSION 2026-03; seven authors, every third row plus the golden works);
 * the two texts are the opening lines of the works as the dump has them.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { CATALOGUE_URL, DUMP_COMMIT, Library, parseCatalogue, parseWorkNote, plain, publicDomainOnly, quoteBlock, renderWorkNote, textUrl, workNotePath, workUrl } from "../sources/benyehuda/library";
import { boundedText, catalogue, downloadAuthors, loadLibrary, type LibraryStore } from "../sources/benyehuda/core";
import { sha256Hex } from "../sources/datagov/snapshot";

const FIX = join(__dirname, "fixtures", "benyehuda");
const CSV = readFileSync(join(FIX, "pseudocatalogue.csv"), "utf8");
const CATALOGUE = parseCatalogue(CSV);
const TEXT: Record<string, string> = { "/p89/m4387": readFileSync(join(FIX, "m4387.txt"), "utf8"), "/p89/m3604": readFileSync(join(FIX, "m3604.txt"), "utf8") };

const GOLDEN: Array<[string, string]> = [
  ["ביאליק בריכה", "הברכה"],
  ["הכניסיני תחת כנפך", "הכניסיני תחת כנפך"],
  ["ביאליק אל הציפור", "אל הציפור"],
  ["לבדי ביאליק", "לבדי"],
  ["מתי מדבר", "מתי מדבר"],
  ["שירתי ביאליק", "שירתי"],
  ["ספיח", "ספיח"],
  ["רחל כנרת", "כנרת"],
  ["זמר נוגה", "זמר נוגה"],
  ["רחל עקרה", "עקרה"],
  ["אל ארצי", "אל ארצי"],
  ["טשרניחובסקי אני מאמין", "אני מאמין"],
  ["האדם אינו אלא", "האדם אינו אלא"],
  ["הקיצה עמי", "הקיצה עמי"],
  ["קוצו של יוד", "קוצו של יוד"],
  ["לא זה הדרך", "לא זה הדרך"],
  ["אמת מארץ ישראל", "אמת מארץ ישראל"],
  ["ברנר שכול וכישלון", "שכול וכשלון"],
  ["ספר הקבצנים", "ספר הקבצנים"],
  ["מסעות בנימין השלישי", "מסעות בנימין השלישי"],
];

function memory(): LibraryStore & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return { files, read: async (p) => files.get(p) ?? null, write: async (p, c) => void files.set(p, c), list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)) };
}

/** The dump on raw.githubusercontent.com, recorded. */
function dump() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const u = String(input);
    if (u === CATALOGUE_URL) return new Response(CSV, { status: 200 });
    const path = u.replace(/^.*\/txt(\/p\d+\/m\d+)\.txt$/, "$1");
    return new Response(TEXT[path] ?? `טקסט של ${path}`, { status: 200 });
  });
}

describe("the catalogue", () => {
  it("reads the dump's pseudocatalogue", () => {
    expect(CATALOGUE.length).toBeGreaterThan(600);
    const w = CATALOGUE.find((x) => x.id === 4387)!;
    expect([w.path, plain(w.title), w.authors, w.genre]).toEqual(["/p89/m4387", "הברכה", "חיים נחמן ביאליק", "poetry"]);
    expect(textUrl(w)).toBe(`https://raw.githubusercontent.com/projectbenyehuda/public_domain_dump/${DUMP_COMMIT}/txt/p89/m4387.txt`);
    expect(workUrl(w)).toBe("https://benyehuda.org/read/4387");
  });
});

describe("search", () => {
  const lib = new Library(CATALOGUE, [{ id: 4387, text: TEXT["/p89/m4387"] }]);

  it("“ביאליק בריכה” finds “הבריכה” first", () => {
    const top = lib.search("ביאליק בריכה", 3);
    expect(plain(top[0].work.title)).toBe("הברכה");
    expect(top[0].work.authors).toBe("חיים נחמן ביאליק");
  });

  it("20 golden queries: at least 18 right in the top 3", () => {
    const right = GOLDEN.filter(([q, title]) => lib.search(q, 3).some((h) => plain(h.work.title).includes(title)));
    const wrong = GOLDEN.filter((g) => !right.includes(g)).map(([q]) => `${q} → ${lib.search(q, 3).map((h) => plain(h.work.title)).join(" | ")}`);
    expect(right.length, wrong.join("; ")).toBeGreaterThanOrEqual(18);
  });

  it("finds words of a downloaded text, with the line that holds them", () => {
    const hit = lib.search("יער ברכה צנועה", 1)[0];
    expect(hit.work.id).toBe(4387);
    expect(hit.downloaded).toBe(true);
    expect(hit.snippet).toContain("ברכה צנועה");
  });
});

describe("public domain only", () => {
  it("indexes nothing that is not in the dump's catalogue", () => {
    const foreign = [{ id: 99999999, text: "שיר של משורר בן זמננו" }];
    expect(publicDomainOnly(foreign, CATALOGUE)).toEqual([]);
    const lib = new Library(CATALOGUE, foreign);
    expect(lib.has(99999999)).toBe(false);
    expect(lib.search("משורר בן זמננו", 5).filter((h) => h.work.id === 99999999)).toEqual([]);
  });
});

describe("the download's integrity (RR20-5) and escaping (RR20-3)", () => {
  it("the dump is pinned to a commit, and a catalogue that is not the pinned one is refused", async () => {
    expect(DUMP_COMMIT).toMatch(/^[0-9a-f]{40}$/);
    expect(CATALOGUE_URL).toContain(`/${DUMP_COMMIT}/`);
    const store = memory();
    await expect(catalogue({ store, fetch: dump() as unknown as typeof fetch })).rejects.toThrow(/pinned/);
    expect(store.files.size).toBe(0);
    // A saved catalogue edited in the vault no longer counts.
    store.files.set("Sources/BenYehuda/pseudocatalogue.csv", CSV);
    expect(await catalogue({ store, expectSha256: "0".repeat(64) })).toEqual([]);
  });

  it("refuses an answer over the size limit, and stops on cancel", async () => {
    const big = vi.fn(async () => new Response("x".repeat(2000)));
    await expect(boundedText("https://example.com/x", big as unknown as typeof fetch, 1000)).rejects.toThrow(/too large/);
    const store = memory();
    const stop = new AbortController();
    let n = 0;
    const slow = vi.fn(async (input: RequestInfo | URL) => {
      if (String(input) === CATALOGUE_URL) return new Response(CSV);
      if (++n === 3) stop.abort();
      return new Response("טקסט");
    });
    await expect(downloadAuthors(["חיים נחמן ביאליק"], { fetch: slow as unknown as typeof fetch, store, expectSha256: await sha256Hex(CSV), signal: stop.signal })).rejects.toThrow(/cancelled/);
    expect(store.files.size).toBeLessThan(10);
  });

  it("a catalogue field with a line break adds no frontmatter key; the credit is in the body", () => {
    const [w] = parseCatalogue('ID,path,title,authors,translators,genre\n1,/p1/m1,"T\n# x","A","","poetry\nrights: all-rights-reserved"\n');
    const md = renderWorkNote(w, "text", "2026-11-14");
    const fm = /^---\n([\s\S]*?)\n---/.exec(md)![1];
    expect(fm).not.toMatch(/^rights: all-rights-reserved$/m);
    expect(md).not.toMatch(/^# x$/m);
    expect(md).toContain("מקור: פרויקט בן־יהודה · A, ״[T # x](https://benyehuda.org/read/1)״ · רשות הציבור");
    expect(parseWorkNote(md)!.text).toBe("text");
  });
});

describe("download once, then offline", () => {
  it("downloads the catalogue and one author's works; then search and reading make 0 requests", async () => {
    const store = memory();
    const f = dump();
    const sha = await sha256Hex(CSV);
    const r = await downloadAuthors(["רחל בלובשטיין"], { fetch: f as unknown as typeof fetch, store, retrieved: "2026-11-14", expectSha256: sha });
    const rachel = CATALOGUE.filter((w) => w.authors === "רחל בלובשטיין");
    expect(r.works).toBe(rachel.length);
    expect(f).toHaveBeenCalledTimes(1 + rachel.length);
    for (const w of rachel) expect(String(f.mock.calls.map((c: unknown[]) => c[0]))).toContain(textUrl(w));

    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    vi.stubGlobal("fetch", offline);
    try {
      const lib = await loadLibrary(store, sha);
      expect(lib.search("רחל כנרת", 3).some((h) => plain(h.work.title) === "כנרת" && h.downloaded)).toBe(true);
      const note = store.files.get(workNotePath(rachel.find((w) => plain(w.title) === "כנרת")!))!;
      expect(parseWorkNote(note)!.text.length).toBeGreaterThan(0);
      expect(offline).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it("a saved work carries source, link, date and rights; a quote carries author, work, link and the public-domain mark", () => {
    const w = CATALOGUE.find((x) => x.id === 4387)!;
    const md = renderWorkNote(w, TEXT["/p89/m4387"], "2026-11-14");
    expect(md).toMatch(/^---\ntype: source\nsource: benyehuda\nid: 4387\n/);
    expect(md).toContain("url: https://benyehuda.org/read/4387");
    expect(md).toContain("retrieved: 2026-11-14");
    expect(md).toContain("rights: public-domain");
    expect(parseWorkNote(md)!.text).toContain("אני יודע ברכה צנועה אחת");
    const q = quoteBlock(w, "אני יודע ברכה צנועה אחת:");
    expect(q).toContain("> אני יודע ברכה צנועה אחת:");
    expect(q).toContain(`— חיים נחמן ביאליק, ״[${w.title}](https://benyehuda.org/read/4387)״ · רשות הציבור`);
  });
});
