/**
 * Plan W7.5: laws, bills and committee protocols from the Knesset as cited
 * sources — law names in 50 forms (≥ 47/50), a saved law opens offline with
 * no request, "Ask the law" answers 20 golden questions with a verified
 * section (≥ 18/20), every saved document carries source, retrieval date and
 * rights, and nothing is sent before the user says yes.
 */
import { describe, expect, it, vi } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lawKey, lawMentionsIn, matchLaw, searchTermOf } from "../sources/knesset/lawNames";
import { odataDate, odataString, queryUrl, rowsOf, searchLaws, toDocument, toLaw, type Law } from "../sources/knesset/odata";
import { citeProtocol, findTurn, knessetNumber, parseProtocol, parseProtocolHeader, protocolQuote } from "../sources/knesset/protocol";
import { askTheLaw, lawSections, lookupLaw, parseLawNote, renderBillNote, renderLawNote, saveLaw, type NoteStorage, type SavedLaw } from "../sources/knesset/store";
import { DeclinedError, enabledSources, gatedFetch, setSourceEnabled, SourceOffError, withGate } from "../sources/open/gate";
import { mayCopy, rightsOfSefariaLicense } from "../sources/open/rights";

const FIX = join(__dirname, "fixtures", "knesset");
const read = (f: string) => readFileSync(join(FIX, f), "utf8");
const LAWS_JSON = JSON.parse(read("laws.v4.json"));
const LAWS: Law[] = rowsOf(LAWS_JSON).map(toLaw).filter((l): l is Law => l !== null);
const NAMES: Array<{ input: string; name: string }> = JSON.parse(read("names.json")).items;
const ASK: { laws: Record<string, string>; questions: Array<{ q: string; law: string; section: string }> } = JSON.parse(read("askTheLaw.json"));

function memory(): NoteStorage & { files: Map<string, string> } {
  const files = new Map<string, string>();
  return {
    files,
    read: async (p) => files.get(p) ?? null,
    write: async (p, c) => void files.set(p, c),
    list: async (dir) => [...files.keys()].filter((p) => p.startsWith(`${dir}/`)),
  };
}

/** The recorded OData service: KNS_IsraelLaw filtered by `contains(Name,'…')`, like the real one. */
function odataStub() {
  return vi.fn(async (input: RequestInfo | URL) => {
    const url = new URL(String(input));
    const filter = url.searchParams.get("$filter") ?? "";
    const term = /contains\(Name,'((?:[^']|'')*)'\)/.exec(filter)?.[1]?.replace(/''/g, "'") ?? "";
    const value = LAWS_JSON.value.filter((r: { Name: string }) => r.Name.includes(term));
    return new Response(JSON.stringify({ ...LAWS_JSON, value }), { status: 200, headers: { "content-type": "application/json" } });
  });
}

describe("law names", () => {
  it("recognises 50 ways of writing a law's name: at least 47 right", () => {
    expect(NAMES.length).toBe(50);
    const wrong = NAMES.filter((n) => matchLaw(n.input, LAWS)?.law.name !== n.name).map((n) => `${n.input} → ${matchLaw(n.input, LAWS)?.law.name ?? "null"}`);
    expect(wrong.length, wrong.join("; ")).toBeLessThanOrEqual(3);
  });

  it("the main law, not its amendment; a Basic Law only for a Basic Law", () => {
    expect(matchLaw("חוק הגנת הפרטיות", LAWS)!.law.name).toBe('חוק הגנת הפרטיות, התשמ"א-1981');
    expect(lawKey("ח״י: חופש העיסוק")).toBe(lawKey("חוק-יסוד: חופש העיסוק"));
    expect(lawKey("חוק התכנון והבניה")).toBe(lawKey('חוק התכנון והבנייה, התשכ"ה-1965'));
    expect(matchLaw("חוק יסוד: המכר", LAWS)).toBe(null);
    for (const s of ["שלום עולם", "חוק", "החוק", "חוק משהו שלא קיים בכלל"]) expect({ s, m: matchLaw(s, LAWS) }).toEqual({ s, m: null });
  });

  it("a year that disagrees lowers the match; the service is searched by the name's longest word", () => {
    expect(matchLaw("חוק העונשין 1977", LAWS)!.law.name).toContain("העונשין");
    expect(matchLaw("חוק המכר 1999", LAWS)!.score).toBeLessThan(matchLaw("חוק המכר", LAWS)!.score);
    expect(searchTermOf('חוק הגנת הפרטיות, התשמ"א-1981')).toBe("הפרטיות");
    expect(searchTermOf("[[חוק:חופש המידע]]")).toBe("המידע");
  });

  it("finds law mentions and [[חוק:…]] links in a note", () => {
    const md = "לפי סעיף 7 לחוק הגנת הפרטיות. ראו גם [[חוק:חופש המידע]].";
    const found = lawMentionsIn(md).map((m) => matchLaw(m, LAWS)?.law.name);
    expect(found).toContain('חוק הגנת הפרטיות, התשמ"א-1981');
    expect(found).toContain('חוק חופש המידע, התשנ"ח-1998');
  });
});

describe("the OData client", () => {
  it("builds V4 and V3 queries with quoted literals", () => {
    expect(odataString("ח'י")).toBe("'ח''י'");
    expect(queryUrl("KNS_IsraelLaw", { filter: { contains: { field: "Name", value: "הפרטיות" } }, top: 5 })).toBe(`https://knesset.gov.il/OdataV4/ParliamentInfo/KNS_IsraelLaw?$filter=${encodeURIComponent("contains(Name,'הפרטיות')")}&$top=5`);
    expect(queryUrl("KNS_CommitteeSession", { filter: { eq: [{ field: "CommitteeSessionID", value: 7 }] } }, 3)).toBe(`https://knesset.gov.il/Odata/ParliamentInfo.svc/KNS_CommitteeSession?$filter=${encodeURIComponent("CommitteeSessionID eq 7")}&$top=20&$format=json`);
  });

  it("reads V4 rows, V3 verbose rows and both date forms", () => {
    expect(rowsOf({ value: [1] })).toEqual([1]);
    expect(rowsOf({ d: { results: [2] } })).toEqual([2]);
    expect(rowsOf({ d: [3] })).toEqual([3]);
    expect(odataDate("1981-03-11T00:00:00")).toBe("1981-03-11");
    expect(odataDate(`/Date(${Date.UTC(1981, 2, 11)})/`)).toBe("1981-03-11");
  });

  it("retries once on V3 when V4 answers 403", async () => {
    const f = vi.fn(async (input: RequestInfo | URL) => (String(input).includes("OdataV4") ? new Response("", { status: 403 }) : new Response(JSON.stringify({ value: [LAWS_JSON.value[0]] }), { status: 200 })));
    const laws = await searchLaws("הפרטיות", f as unknown as typeof fetch);
    expect(f).toHaveBeenCalledTimes(2);
    expect(String(f.mock.calls[1][0])).toContain("ParliamentInfo.svc");
    expect(laws[0].name).toContain("הגנת הפרטיות");
  });

  it("only the protocol of a session is a Knesset record; other attachments are link-only", () => {
    const doc = (kind: string) => toDocument({ DocumentCommitteeSessionID: 1, CommitteeSessionID: 2, GroupTypeDesc: kind, ApplicationDesc: "DOC", FilePath: "https://fs.knesset.gov.il/x.doc" })!;
    expect(doc("פרוטוקול ועדה").isProtocol).toBe(true);
    expect(doc("חוות דעת").isProtocol).toBe(false);
    expect(doc("מצגת").isProtocol).toBe(false);
  });
});

describe("saved laws: offline, with source, date and rights", () => {
  it("first lookup asks the service; after saving, a second lookup makes 0 requests", async () => {
    const storage = memory();
    const f = odataStub();
    const first = await lookupLaw("חוק הגנת הפרטיות", { storage, fetch: f as unknown as typeof fetch });
    expect(first!.from).toBe("network");
    expect(f).toHaveBeenCalledTimes(1);
    expect(storage.files.size).toBe(0); // nothing is stored until the user asks
    await saveLaw(first!.law!, storage, ASK.laws['חוק הגנת הפרטיות, התשמ"א-1981'], "2026-11-14");
    const offline = vi.fn(async () => {
      throw new TypeError("Failed to fetch");
    });
    const second = await lookupLaw("לחוק הגנת הפרטיות, התשמ״א-1981", { storage, fetch: offline as unknown as typeof fetch });
    expect(second!.from).toBe("vault");
    expect(offline).toHaveBeenCalledTimes(0);
    expect(second!.saved!.law.name).toBe('חוק הגנת הפרטיות, התשמ"א-1981');
  });

  it("every saved document has source, retrieval date and rights in its frontmatter", () => {
    const law = renderLawNote(LAWS[0], "2026-11-14", "1. לא יפגע אדם בפרטיות של זולתו ללא הסכמתו.");
    const bill = renderBillNote({ id: 5, name: "הצעת חוק לדוגמה", knessetNum: 25, subType: "פרטית", privateNumber: 1, publicationDate: null, summary: null }, "2026-11-14");
    for (const md of [law, bill]) {
      expect(md).toMatch(/^---\ntype: source\nsource: knesset\n/);
      expect(md).toMatch(/^url: https:\/\/knesset\.gov\.il\/OdataV4\/ParliamentInfo\/KNS_(IsraelLaw|Bill)\(\d+\)$/m);
      expect(md).toMatch(/^retrieved: 2026-11-14$/m);
      expect(md).toMatch(/^rights: section-6$/m);
    }
    const back = parseLawNote("Sources/Knesset/Laws/x.md", law)!;
    expect(back.law.name).toBe(LAWS[0].name);
    expect(back.text).toBe("1. לא יפגע אדם בפרטיות של זולתו ללא הסכמתו.");
    expect(mayCopy("section-6")).toBe(true);
  });
});

describe("Ask the law", () => {
  const saved: SavedLaw[] = Object.entries(ASK.laws).map(([name, text]) => {
    const law = LAWS.find((l) => l.name === name)!;
    expect(law, name).toBeDefined();
    const path = `Sources/Knesset/Laws/${name}.md`;
    return parseLawNote(path, renderLawNote(law, "2026-11-14", text))!;
  });

  it("splits a law into its sections", () => {
    const s = lawSections(ASK.laws["חוק-יסוד: כבוד האדם וחירותו"]);
    expect(s.map((x) => x.number)).toEqual(["1", "1א", "2", "3", "4", "5", "6", "7", "8", "11"]);
    expect(s.find((x) => x.number === "7")!.text).toContain("(ד) אין פוגעים בסוד שיחו");
  });

  it("20 golden questions on 5 laws: at least 18 with the right section, verified", () => {
    expect(ASK.questions.length).toBe(20);
    expect(new Set(ASK.questions.map((q) => q.law)).size).toBe(5);
    const right = ASK.questions.filter((g) => {
      const a = askTheLaw(g.q, saved, 1)[0];
      return a && a.law.law.name === g.law && a.section.number === g.section && a.verified;
    });
    const wrong = ASK.questions.filter((g) => !right.includes(g)).map((g) => `${g.q} → ${askTheLaw(g.q, saved, 1)[0]?.section.number ?? "none"}`);
    expect(right.length, wrong.join("; ")).toBeGreaterThanOrEqual(18);
  });

  it("an answer quotes the section with a citation and the rights", () => {
    const a = askTheLaw("אין זכות יוצרים בחוקים", saved, 1)[0];
    expect(a.markdown).toContain("> 6. אין זכות יוצרים בחוקים");
    expect(a.markdown).toContain("סעיף 6 לחוק זכות יוצרים");
    expect(a.markdown).toMatch(/\[מקור: הכנסת\]\(https:\/\/knesset\.gov\.il\/OdataV4\/ParliamentInfo\/KNS_IsraelLaw\(\d+\)\)/);
  });
});

describe("committee protocols", () => {
  const turns = parseProtocol(read("protocol.txt"));

  it("reads speakers in both layouts, and the page each turn starts on", () => {
    expect(turns.map((t) => [t.speaker, t.page])).toEqual([
      ['היו"ר ראובן כהן', 1],
      ["שמעון לוי (מחלקת ייעוץ וחקיקה)", 1],
      ["לוי יצחק", 2],
      ['היו"ר ראובן כהן', 2],
    ]);
  });

  it("reads the session's details from the protocol's first lines", () => {
    expect(parseProtocolHeader(read("protocol.txt"))).toEqual({ committee: "ועדת החוקה, חוק ומשפט", sessionNumber: 12, knessetNum: 25, date: "2023-01-03", url: null });
    expect([knessetNumber("הכנסת השש עשרה"), knessetNumber("הכנסת העשרים"), knessetNumber("הכנסת ה-24")]).toEqual([16, 20, 24]);
  });

  it("a quote carries the speaker, the session date and the page, after the uniform citation rules", () => {
    const meta = { committee: "ועדת החוקה, חוק ומשפט", sessionNumber: 12, knessetNum: 25, date: "2023-01-03", url: "https://fs.knesset.gov.il/25/Committees/x.doc" };
    const turn = findTurn(turns, "אני מתנגד לנוסח המוצע")!;
    expect(citeProtocol(meta, turn.page)).toBe("פרוטוקול ישיבה מס' 12 של ועדת החוקה, חוק ומשפט, הכנסת ה-25, 2 (3.1.2023)");
    const q = protocolQuote(turn, "אני מתנגד לנוסח המוצע", meta);
    expect(q).toContain("> אני מתנגד לנוסח המוצע");
    expect(q).toContain("— לוי יצחק, פרוטוקול ישיבה מס' 12");
  });
});

describe("the gate: nothing is sent before the user acts", () => {
  it("asks once, sends after yes; a no sends nothing; a source that is off sends nothing", async () => {
    const base = vi.fn(async () => new Response("{}"));
    const confirm = vi.fn(async () => true);
    const f = gatedFetch({ source: "knesset", reason: "r", confirm, base: base as unknown as typeof fetch });
    await f("https://knesset.gov.il/a");
    await f("https://knesset.gov.il/b");
    expect(confirm).toHaveBeenCalledTimes(1);
    expect(base).toHaveBeenCalledTimes(2);

    const no = vi.fn(async () => new Response("{}"));
    expect(await withGate({ source: "knesset", reason: "r", confirm: async () => false, base: no as unknown as typeof fetch }, (g) => g("https://knesset.gov.il/a"))).toBe(null);
    expect(no).not.toHaveBeenCalled();

    const off = vi.fn(async () => new Response("{}"));
    const ask = vi.fn(async () => true);
    await expect(gatedFetch({ source: "knesset", reason: "r", confirm: ask, enabled: () => false, base: off as unknown as typeof fetch })("https://knesset.gov.il/a")).rejects.toBeInstanceOf(SourceOffError);
    expect(off).not.toHaveBeenCalled();
    expect(ask).not.toHaveBeenCalled();
    expect(new DeclinedError().name).toBe("DeclinedError");
  });

  it("sources start off except Sefaria, and the choice is remembered", () => {
    const store = new Map<string, string>();
    const s = { getItem: (k: string) => store.get(k) ?? null, setItem: (k: string, v: string) => void store.set(k, v) };
    expect(enabledSources(s)).toEqual({ sefaria: true, knesset: false, datagov: false, benyehuda: false });
    setSourceEnabled("knesset", true, s);
    expect(enabledSources(s).knesset).toBe(true);
    expect(rightsOfSefariaLicense("CC-BY-NC")).toBe("link-only");
    expect(rightsOfSefariaLicense("CC-BY-SA")).toBe("cc-by-sa");
  });
});
