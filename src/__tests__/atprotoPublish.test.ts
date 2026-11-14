/**
 * Publishing to the AT Protocol as Standard.site (plan W7.19): the records,
 * the site's ownership proofs, and the PDS calls against a fake PDS, with
 * the App Password kept out of every message.
 */
import { describe, it, expect } from "vitest";
import { DOCUMENT, PUBLICATION, documentRecord, parseAtUri, publicationRecord, summaryOf, tid, wellKnownPublication, documentLink } from "../publish/atproto/standard";
import { putRecord, resolveIdentity, signIn, deleteRecord, PASSWORD_SECRET, SESSION_SECRET } from "../publish/atproto/client";
import { documentsOf, noteLang, publishNotes } from "../publish/atproto/publish";
import { buildSite } from "../publish/site";
import { getSecret, initSecretStore } from "../lib/secretStore";

const HE = "---\ntitle: שלום עולם\ntags: [עברית, rtl]\n---\n# שלום עולם\n\nזו פסקה ראשונה בעברית, עם **הדגשה** ו-English בתוכה.\n\nפסקה שנייה.\n";

describe("records", () => {
  it("a publication needs an https address", () => {
    expect(publicationRecord({ name: "My notes", url: "https://me.github.io/notes/" })).toEqual({ $type: PUBLICATION, url: "https://me.github.io/notes", name: "My notes" });
    expect(() => publicationRecord({ name: "x", url: "http://insecure.example.com" })).toThrow();
  });
  it("a Hebrew document carries its title, summary, language and direction", () => {
    const r = documentRecord({ site: "at://did:plc:abc/site.standard.publication/3k", path: "Notes/שלום.html", title: "שלום עולם", markdown: HE, lang: "he", tags: ["עברית"], publishedAt: "2026-11-14T10:00:00.000Z" });
    expect(r).toMatchObject({ $type: DOCUMENT, path: "/Notes/שלום.html", title: "שלום עולם", langs: ["he"], textDirection: "rtl", tags: ["עברית"], publishedAt: "2026-11-14T10:00:00.000Z" });
    expect(String(r.description)).toContain("זו פסקה ראשונה בעברית");
    expect(String(r.description)).not.toContain("**");
    expect(String(r.textContent)).toContain("פסקה שנייה");
    expect(String(r.textContent)).not.toContain("title:");
  });
  it("summary: the frontmatter's description wins, and a long first paragraph is cut at a word", () => {
    expect(summaryOf("---\ndescription: Short one\n---\nBody", { description: "Short one" })).toBe("Short one");
    const long = summaryOf(`# T\n\n${"word ".repeat(200)}`);
    expect(long.length).toBeLessThanOrEqual(300);
    expect(long.endsWith("…")).toBe(true);
  });
  it("TIDs are 13 sortable base32 characters", () => {
    const a = tid(1_700_000_000_000, 1);
    const b = tid(1_700_000_000_001, 0);
    expect(a).toMatch(/^[234567a-z]{13}$/);
    expect(a < b).toBe(true);
    expect(parseAtUri(`at://did:plc:abc123/${DOCUMENT}/${a}`)).toEqual({ did: "did:plc:abc123", collection: DOCUMENT, rkey: a });
    expect(parseAtUri("https://example.com")).toBeNull();
  });
  it("the site proves it owns the records", async () => {
    const pub = "at://did:plc:abc/site.standard.publication/3kabc";
    const doc = "at://did:plc:abc/site.standard.document/3kdef";
    expect(wellKnownPublication(pub)).toBe(`${pub}\n`);
    expect(documentLink(doc)).toBe(`<link rel="site.standard.document" href="${doc}" />`);
    const site = await buildSite([{ path: "Notes/a.md", content: "# A\n\nText" }, { path: "b.md", content: "# B" }], {
      title: "S",
      lang: "he",
      render: async (md, o) => `<!doctype html><html dir="rtl"><head><title>${o.title}</title>${o.head ?? ""}</head><body>${o.before ?? ""}<main>${md}</main></body></html>`,
      standardSite: { publication: pub, documents: { "Notes/a.md": doc } },
    });
    expect(site.files.find((f) => f.path === ".well-known/site.standard.publication")?.data).toBe(`${pub}\n`);
    expect(String(site.files.find((f) => f.path === "Notes/a.html")?.data)).toContain(documentLink(doc));
    expect(String(site.files.find((f) => f.path === "b.html")?.data)).not.toContain("site.standard.document");
  });
  it("reads the note's language and its documents", () => {
    expect(noteLang(HE, {})).toBe("he");
    expect(noteLang("# Hello there", {})).toBe("en");
    expect(noteLang("x", { lang: "yi" })).toBe("yi");
    expect(documentsOf([{ path: "a.md", content: "---\natproto-document: at://did:plc:x/site.standard.document/3k\n---\n" }, { path: "b.md", content: "no" }])).toEqual({ "a.md": "at://did:plc:x/site.standard.document/3k" });
  });
});

/** A PDS in memory: handle resolution, the DID document, sessions and records. */
function fakePds(password = "abcd-efgh-ijkl-mnop") {
  const calls: Array<{ url: string; body: string; auth: string }> = [];
  const records = new Map<string, unknown>();
  const f = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const body = typeof init?.body === "string" ? init.body : "";
    calls.push({ url, body, auth: String((init?.headers as Record<string, string> | undefined)?.authorization ?? "") });
    const ok = (j: unknown) => new Response(JSON.stringify(j), { status: 200, headers: { "content-type": "application/json" } });
    if (url === "https://tal.example.com/.well-known/atproto-did") return new Response("did:plc:tal", { status: 200 });
    if (url.startsWith("https://bsky.social/xrpc/com.atproto.identity.resolveHandle")) return ok({ did: "did:plc:tal" });
    if (url === "https://plc.directory/did%3Aplc%3Atal") return ok({ id: "did:plc:tal", service: [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://pds.example.com" }] });
    if (url === "https://pds.example.com/xrpc/com.atproto.server.createSession") {
      const b = JSON.parse(body) as { password: string };
      if (b.password !== password) return new Response(JSON.stringify({ error: "AuthenticationRequired", message: "Invalid identifier or password" }), { status: 401 });
      return ok({ did: "did:plc:tal", handle: "tal.example.com", accessJwt: "ACCESS", refreshJwt: "REFRESH" });
    }
    if (url === "https://pds.example.com/xrpc/com.atproto.server.refreshSession") return ok({ did: "did:plc:tal", handle: "tal.example.com", accessJwt: "ACCESS2", refreshJwt: "REFRESH2" });
    if (url === "https://pds.example.com/xrpc/com.atproto.repo.putRecord") {
      const b = JSON.parse(body) as { repo: string; collection: string; rkey: string; record: unknown };
      const uri = `at://${b.repo}/${b.collection}/${b.rkey}`;
      records.set(uri, b.record);
      return ok({ uri, cid: "bafy" });
    }
    if (url === "https://pds.example.com/xrpc/com.atproto.repo.deleteRecord") {
      const b = JSON.parse(body) as { repo: string; collection: string; rkey: string };
      records.delete(`at://${b.repo}/${b.collection}/${b.rkey}`);
      return ok({});
    }
    return new Response("not found", { status: 404 });
  }) as typeof fetch;
  return { f, calls, records, password };
}

describe("the PDS calls", () => {
  it("resolves a handle to its DID and PDS", async () => {
    const pds = fakePds();
    expect(await resolveIdentity("@Tal.example.com", pds.f)).toEqual({ did: "did:plc:tal", pds: "https://pds.example.com" });
  });
  it("signs in with the App Password, keeps it and the refresh token in the secret store only, and the password never shows in an error", async () => {
    await initSecretStore();
    const pds = fakePds();
    await expect(signIn("tal.example.com", "wrong-password-1234", pds.f)).rejects.toThrow("Invalid identifier or password");
    try {
      await signIn("tal.example.com", "wrong-password-1234", pds.f);
    } catch (e) {
      expect(String((e as Error).message)).not.toContain("wrong-password");
    }
    const s = await signIn("tal.example.com", pds.password, pds.f);
    expect(s.accessJwt).toBe("ACCESS");
    expect(getSecret(PASSWORD_SECRET)).toBe(pds.password);
    expect(getSecret(SESSION_SECRET)).toBe("REFRESH");
    // The password went only in the createSession body.
    for (const c of pds.calls) if (!c.url.endsWith("createSession")) expect(c.body + c.url + c.auth).not.toContain(pds.password);
    // Next time the refresh token is enough.
    const again = await signIn("tal.example.com", null, pds.f);
    expect(again.accessJwt).toBe("ACCESS2");
    const uri = await putRecord(again, DOCUMENT, "3kaaa", { $type: DOCUMENT, title: "x" }, pds.f);
    expect(pds.records.has(uri)).toBe(true);
    await deleteRecord(again, uri, pds.f);
    expect(pds.records.has(uri)).toBe(false);
  });
});

describe("publish and publish again", () => {
  it("one publication, one document per note; publishing again replaces the same record", async () => {
    const pds = fakePds();
    const realFetch = globalThis.fetch;
    globalThis.fetch = pds.f;
    try {
      const target = { handle: "tal.example.com", password: pds.password, siteUrl: "https://tal.example.com/notes", siteName: "Tal" };
      const first = await publishNotes([{ path: "Notes/שלום.md", content: HE }], target, new Date("2026-11-14T10:00:00Z"));
      expect(first.notes).toHaveLength(1);
      const docUri = first.notes[0].uri;
      expect(first.notes[0].content).toContain(`atproto-document: ${docUri}`);
      const again = await publishNotes([{ path: "Notes/שלום.md", content: first.notes[0].content.replace("פסקה שנייה", "פסקה מעודכנת") }], { ...target, password: null }, new Date("2026-11-15T10:00:00Z"));
      expect(again.notes[0].uri).toBe(docUri);
      expect(again.publication).toBe(first.publication);
      const rec = pds.records.get(docUri) as Record<string, unknown>;
      expect(rec).toMatchObject({ site: first.publication, title: "שלום עולם", langs: ["he"], textDirection: "rtl", updatedAt: "2026-11-15T10:00:00.000Z" });
      expect(String(rec.textContent)).toContain("פסקה מעודכנת");
      expect([...pds.records.keys()].filter((k) => k.includes(PUBLICATION))).toHaveLength(1);
    } finally {
      globalThis.fetch = realFetch;
    }
  });
});
