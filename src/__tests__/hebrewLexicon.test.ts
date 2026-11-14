/** Plan W5.26: the offline Hebrew lexicon — the Wiktionary parser, the lookup, the pack store and its credit. */
import { describe, it, expect, beforeEach } from "vitest";
import { buildPack, pagesOf, parsePage, plainText } from "../../scripts/lib/hewiktionary.mjs";
import { buildIndex, candidates, lookup, type LexiconPack, type PackEntry } from "../lexicon/lexicon";
import { LEXICON_CACHE, LEXICON_PACK_PATH, LexiconUnavailableError, __resetLexicon, downloadLexicon, lexiconManifest, loadLexicon, removeLexicon } from "../lexicon/store";
import { LEXICON_FLAG, lexiconInstalled } from "../lexicon/installed";
import registry from "../../models/registry.json";

const BAYIT = `{{לשון}}
== בַּיִת ==
{{ניתוח דקדוקי
|כתיב מלא=בית
|הגייה=bayit
|חלק דיבר=שם־עצם
|מין=זכר
|שורש={{שורש|ב|י|ת}}
}}
# [[מבנה]] המשמש ל[[מגורים]].<ref>מילון</ref>
#: {{דוגמה|הבית שלנו גדול}}
# '''משפחה''', [[צאצא|צאצאים]].
#* ציטוט ארוך
## תת־משמעות
===צירופים===
* [[בית ספר]]
===נרדפות===
* [[דירה]], [[מעון]]
* [[משכן]]
===תרגום===
* אנגלית: [[house]]
== בַּיִת 2 ==
{{ניתוח דקדוקי
|חלק דיבר=שם עצם
}}
# [[שורה]] בשיר.
`;

describe("Hebrew Wiktionary parser", () => {
  it("one entry per homograph: pointed headword, part of speech, definitions without examples, synonyms", () => {
    const e = parsePage("בית", BAYIT);
    expect(e).toEqual([
      ["בית", "בַּיִת", "שם עצם", ["מבנה המשמש למגורים.", "משפחה, צאצאים."], ["דירה", "מעון", "משכן"]],
      ["בית", "בַּיִת", "שם עצם", ["שורה בשיר."], []],
    ]);
  });

  it("pages that are not Hebrew words give nothing", () => {
    expect(parsePage("house", "== house ==\n# a building")).toEqual([]);
    expect(parsePage("ביתה", "#הפניה [[בית]]")).toEqual([]);
  });

  it("strips wiki markup", () => {
    expect(plainText("[[a|ב]] '''ג''' {{t|{{x}}}} <b>ד</b> [https://example.com ה]")).toBe("ב ג ד ה");
  });

  it("reads pages out of a MediaWiki XML export and builds a sorted pack", () => {
    const xml = `<mediawiki><page><title>שלום</title><ns>0</ns><revision><text bytes="1">== שָׁלוֹם ==\n# היעדר [[מלחמה]].\n===נרדפות===\n* [[שלווה]]</text></revision></page><page><title>בית</title><ns>0</ns><revision><text>${BAYIT.replace(/</g, "&lt;").replace(/>/g, "&gt;")}</text></revision></page><page><title>שיחה:בית</title><ns>1</ns><revision><text>x</text></revision></page></mediawiki>`;
    const pages = [...pagesOf(xml)];
    expect(pages.map((p) => p[1])).toEqual(["0", "0", "1"]);
    const entries = pages.filter((p) => p[1] === "0").flatMap(([t, , text]) => parsePage(t, text));
    const pack = buildPack(entries, { source: "hewiktionary-20261101-pages-articles", built: "2026-11-12" });
    expect(pack).toMatchObject({ format: "lumen-lexicon/1", license: "CC-BY-SA-4.0", count: 3, words: 2 });
    expect(pack.entries.map((e: PackEntry) => e[0])).toEqual(["בית", "בית", "שלום"]);
    expect(pack.attribution).toContain("CC BY-SA 4.0");
  });
});

const PACK: LexiconPack = {
  format: "lumen-lexicon/1",
  source: "test",
  built: "2026-11-12",
  license: "CC-BY-SA-4.0",
  attribution: "Hebrew Wiktionary contributors, CC BY-SA 4.0",
  count: 3,
  words: 3,
  entries: [
    ["בית", "בַּיִת", "שם עצם", ["מבנה למגורים"], ["דירה", "מעון"]],
    ["ורד", "וֶרֶד", "שם עצם", ["פרח"], []],
    ["שמח", "שָׂמֵחַ", "תואר", ["מאושר"], ["עליז"]],
  ],
};

describe("lexicon lookup", () => {
  const index = buildIndex(PACK);

  it("finds a word as written, with niqqud, or with prefix letters peeled", () => {
    expect(lookup(index, "בית")).toMatchObject({ word: "בית", prefix: "" });
    expect(lookup(index, "בַּיִת")).toMatchObject({ word: "בית" });
    expect(lookup(index, "ובבית")).toMatchObject({ word: "בית", prefix: "וב" });
    expect(lookup(index, "כשהבית")).toMatchObject({ word: "בית", prefix: "כשה" });
    // Full spelling doubles the ו after a prefix.
    expect(lookup(index, "הוורד")).toMatchObject({ word: "ורד", prefix: "ה" });
    expect(lookup(index, "מחשב")).toBeNull();
  });

  it("does not peel an invalid prefix order (בה… is not ב+ה)", () => {
    expect(candidates("בהבית").map((c) => c.word)).toEqual(["בהבית", "הבית"]);
  });

  it("synonyms go both ways", () => {
    expect(lookup(index, "בית")!.synonyms).toEqual(["דירה", "מעון"]);
    expect(lookup(index, "דירה")).toMatchObject({ word: "דירה", senses: [], synonyms: ["בית"] });
    expect(lookup(index, "עליז")!.synonyms).toEqual(["שמח"]);
  });

  it("a lookup in a 25,000-entry pack takes ≤ 20 ms (the plan's bound), checked over 2,000 lookups", () => {
    const letters = "אבגדהוזחטיכלמנסעפצקרשת";
    const big: PackEntry[] = [];
    for (let i = 0; i < 25000; i++) {
      let w = "";
      for (let n = i + 1; n > 0; n = Math.floor(n / 22)) w += letters[n % 22];
      big.push([w, w, "שם עצם", ["הגדרה " + i], i % 3 ? [] : ["מילה" + letters[i % 22]]]);
    }
    const idx = buildIndex({ ...PACK, count: big.length, entries: big });
    let worst = 0;
    for (let i = 0; i < 2000; i++) {
      const w = "וב" + big[(i * 7919) % big.length][0];
      const t0 = performance.now();
      lookup(idx, w);
      worst = Math.max(worst, performance.now() - t0);
    }
    expect(worst).toBeLessThan(20);
  });
});

/** A fake origin: the manifest and the pack, and Cache Storage in memory. */
function fakeEnv(pack: LexiconPack | null, opts: { corrupt?: boolean } = {}) {
  const json = pack ? JSON.stringify(pack) : "";
  const bytes = new TextEncoder().encode(json);
  const store = new Map<string, Map<string, Response>>();
  const storage = new Map<string, string>();
  let sha = "";
  const ready = crypto.subtle.digest("SHA-256", bytes).then((d) => {
    sha = [...new Uint8Array(d)].map((b) => b.toString(16).padStart(2, "0")).join("");
  });
  const fetchImpl = (async (url: string) => {
    await ready;
    if (!pack) return new Response("", { status: 404 });
    if (url.endsWith("manifest.json")) return new Response(JSON.stringify({ file: "he-wiktionary.json", bytes: bytes.byteLength, sha256: opts.corrupt ? "0".repeat(64) : sha, count: pack.count, words: pack.words, source: pack.source, license: pack.license }));
    if (url.endsWith(LEXICON_PACK_PATH)) return new Response(bytes);
    return new Response("", { status: 404 });
  }) as unknown as typeof fetch;
  const cachesImpl = {
    open: async (name: string) => {
      let c = store.get(name);
      if (!c) store.set(name, (c = new Map()));
      const m = c;
      return { put: async (u: string, r: Response) => void m.set(u, r), match: async (u: string) => m.get(u)?.clone() } as unknown as Cache;
    },
    delete: async (name: string) => store.delete(name),
  } as unknown as CacheStorage;
  const storageImpl = { getItem: (k: string) => storage.get(k) ?? null, setItem: (k: string, v: string) => void storage.set(k, v), removeItem: (k: string) => void storage.delete(k) };
  return { deps: { fetch: fetchImpl, caches: cachesImpl, base: "/", storage: storageImpl }, store, storage };
}

describe("lexicon pack on this device", () => {
  beforeEach(() => {
    __resetLexicon();
    localStorage.clear();
  });

  it("not published yet: the manifest is missing and the download says so", async () => {
    const { deps } = fakeEnv(null);
    expect(await lexiconManifest(deps)).toBeNull();
    await expect(downloadLexicon(deps)).rejects.toBeInstanceOf(LexiconUnavailableError);
  });

  it("downloads on request, checks the checksum, keeps it in Cache Storage and loads the index", async () => {
    const { deps, store, storage } = fakeEnv(PACK);
    expect(await downloadLexicon(deps)).toBe(3);
    expect(store.get(LEXICON_CACHE)?.size).toBe(1);
    expect(storage.get(LEXICON_FLAG)).toBe("1");
    const index = await loadLexicon(deps);
    expect(lookup(index, "לבית")).toMatchObject({ word: "בית" });
    await removeLexicon(deps);
    expect(store.has(LEXICON_CACHE)).toBe(false);
    expect(storage.has(LEXICON_FLAG)).toBe(false);
  });

  it("a pack that does not match the manifest is refused and not stored", async () => {
    const { deps, store } = fakeEnv(PACK, { corrupt: true });
    await expect(downloadLexicon(deps)).rejects.toThrow(/checksum/);
    expect(store.get(LEXICON_CACHE)?.size ?? 0).toBe(0);
  });

  it("the editor's flag is off until the pack is installed", () => {
    expect(lexiconInstalled()).toBe(false);
    localStorage.setItem(LEXICON_FLAG, "1");
    expect(lexiconInstalled()).toBe(true);
  });
});

describe("lexicon credit (plan 1.7)", () => {
  it("the registry credits Hebrew Wiktionary, CC BY-SA 4.0, as a download the credits screen lists", () => {
    const e = (registry as { models: Array<Record<string, unknown>> }).models.find((m) => m.id === "hewiktionary-lexicon")!;
    // CC BY-SA 4.0 is not unconditional: attribution, and share-alike on adaptations, and the pack is one
    // (definitions shortened, examples removed: "unmodified": false). scripts/lib/licenses.mjs classes every
    // CC BY-SA entry "conditional" (V4 sweep, train 4), with commercial use "conditional" too; the credits
    // screen lists conditional entries with their notice. So "conditional", not "allowed" (train 5, audit item 11).
    expect(e).toMatchObject({ license: "CC-BY-SA-4.0", class: "conditional", commercial: "conditional", delivery: "user-download", unmodified: false });
    expect(String(e.attribution)).toMatch(/Hebrew Wiktionary.*CC BY-SA 4\.0/);
  });
});
