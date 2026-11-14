/**
 * Plan W7.19: publishing a note to the AT Protocol with Standard.site, the
 * site's ownership proof, and no secret outside the secret store.
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { APP_PASSWORD_SECRET, AtprotoError, DOCUMENT_NSID, MARKDOWN_TYPE, PUBLICATION_NSID, WELL_KNOWN_PATH, documentRecord, linkTags, login, noteTitle, pdsOf, publicationRecord, publishNote, rkeyFor, summaryOf, tagsOf, unpublishNote, wellKnownFile } from "../publish/standardSite";
import { buildSite } from "../publish/site";
import { isSecretName } from "../lib/secretStore";
import { classify } from "../ai/privacyLedger";
import type { HtmlDocumentOptions } from "../storage/exportHtml";

const ROOT = resolve(__dirname, "..", "..");
const NOTE = "---\ntitle: מכתב לעורך\ntags: [עיתונות, he]\n---\n# מכתב לעורך\n\nשלום, זה **פתק** עם [קישור](https://example.com) ו-English בתוך השורה.\n";
const DID = "did:plc:abc123xyz";
const PASSWORD = "abcd-efgh-ijkl-mnop";

/** A PDS in memory: createSession (with its DID document), putRecord, deleteRecord; and plc.directory. */
function fakePds(opts: { didDoc?: boolean } = {}) {
  const records = new Map<string, unknown>();
  const log: Array<{ url: string; auth: string | null; body: string }> = [];
  const f = (async (input: string, init?: RequestInit) => {
    const url = new URL(input);
    const h = new Headers(init?.headers);
    log.push({ url: url.href, auth: h.get("authorization"), body: String(init?.body ?? "") });
    const body = init?.body ? JSON.parse(String(init.body)) : {};
    const json = (status: number, v: unknown) => new Response(JSON.stringify(v), { status, headers: { "Content-Type": "application/json" } });
    const service = [{ id: "#atproto_pds", type: "AtprotoPersonalDataServer", serviceEndpoint: "https://morel.us-east.host.bsky.network" }];
    if (url.hostname === "plc.directory") return json(200, { id: DID, service });
    if (url.pathname === "/xrpc/com.atproto.server.createSession") {
      if (body.password !== PASSWORD) return json(401, { error: "AuthenticationRequired", message: "Invalid identifier or password" });
      return json(200, { did: DID, handle: "dana.bsky.social", accessJwt: "jwt-1", refreshJwt: "r", ...(opts.didDoc ? { didDoc: { id: DID, service } } : {}) });
    }
    if (h.get("authorization") !== "Bearer jwt-1") return json(401, { error: "AuthenticationRequired" });
    if (url.hostname !== "morel.us-east.host.bsky.network") return json(400, { error: "WrongPds" });
    const key = `${body.collection}/${body.rkey}`;
    if (url.pathname === "/xrpc/com.atproto.repo.putRecord") {
      records.set(key, body.record);
      return json(200, { uri: `at://${body.repo}/${key}`, cid: "bafy" });
    }
    if (url.pathname === "/xrpc/com.atproto.repo.deleteRecord") {
      records.delete(key);
      return json(200, {});
    }
    return json(404, { error: "MethodNotImplemented" });
  }) as unknown as typeof fetch;
  return { f, records, log };
}

async function render(md: string, opts: HtmlDocumentOptions): Promise<string> {
  return `<!doctype html><html lang="he" dir="rtl"><head><title>${opts.title}</title>${opts.head ?? ""}</head><body>${opts.before ?? ""}<main>${md}</main></body></html>`;
}

describe("Standard.site publishing (W7.19)", () => {
  it("a Hebrew note becomes a document: title, summary, tags, Markdown content, path", () => {
    const d = documentRecord({ site: "at://did:plc:x/site.standard.publication/p", path: "Letters/מכתב.md", markdown: NOTE, publishedAt: new Date("2026-11-14T08:00:00Z") });
    expect(d).toMatchObject({ $type: DOCUMENT_NSID, title: "מכתב לעורך", publishedAt: "2026-11-14T08:00:00.000Z", tags: ["עיתונות", "he"], content: { $type: MARKDOWN_TYPE, text: NOTE } });
    expect(d.path).toBe("/Letters/" + encodeURIComponent("מכתב"));
    expect(d.description).toBe("שלום, זה פתק עם קישור ו-English בתוך השורה.");
    expect(d.textContent).toContain("שלום");
    expect("lang" in d || "dir" in d).toBe(false);
    expect(noteTitle("no heading", "a/b.md")).toBe("b");
    expect(summaryOf("x ".repeat(400)).length).toBeLessThanOrEqual(301);
    expect(tagsOf("---\ntags:\n  - a\n  - b\n---\n")).toEqual(["a", "b"]);
  });

  it("a publication needs https; record keys are stable, valid and different per note", () => {
    expect(publicationRecord({ url: "https://dana.example/", name: " Dana " })).toEqual({ $type: PUBLICATION_NSID, url: "https://dana.example", name: "Dana" });
    expect(() => publicationRecord({ url: "http://dana.example", name: "x" })).toThrow(/https/);
    const k = rkeyFor("Letters/מכתב.md");
    expect(k).toMatch(/^[2-7a-z]{13}$/);
    expect(rkeyFor("Letters/מכתב.md")).toBe(k);
    expect(rkeyFor("Letters/other.md")).not.toBe(k);
  });

  it("login with an App Password finds the PDS in the DID document, or through plc.directory", async () => {
    for (const didDoc of [true, false]) {
      const { f, log } = fakePds({ didDoc });
      const s = await login(f, { identifier: "dana.bsky.social", appPassword: PASSWORD });
      expect(s).toEqual({ did: DID, handle: "dana.bsky.social", accessJwt: "jwt-1", pds: "https://morel.us-east.host.bsky.network" });
      expect(log.some((l) => l.url.startsWith("https://plc.directory/"))).toBe(!didDoc);
    }
    const { f } = fakePds();
    await expect(login(f, { identifier: "dana.bsky.social", appPassword: "wrong" })).rejects.toBeInstanceOf(AtprotoError);
    expect(pdsOf({})).toBeNull();
  });

  it("publish writes the publication and the document; publishing again updates the same record; unpublish deletes it", async () => {
    const { f, records, log } = fakePds({ didDoc: true });
    const s = await login(f, { identifier: "dana.bsky.social", appPassword: PASSWORD });
    const site = { url: "https://dana.example", name: "Dana's notes" };
    const r = await publishNote(f, s, { site, path: "Letters/מכתב.md", markdown: NOTE, now: new Date("2026-11-14T08:00:00Z") });
    expect(r.publication).toBe(`at://${DID}/${PUBLICATION_NSID}/${rkeyFor("https://dana.example")}`);
    expect(r.document).toBe(`at://${DID}/${DOCUMENT_NSID}/${rkeyFor("Letters/מכתב.md")}`);
    expect(r.url).toBe(`https://dana.example/Letters/${encodeURIComponent("מכתב")}.html`);
    expect(records.size).toBe(2);
    await publishNote(f, s, { site, path: "Letters/מכתב.md", markdown: NOTE.replace("שלום", "שלום רב"), now: new Date("2026-11-15T08:00:00Z"), publishedAt: new Date("2026-11-14T08:00:00Z") });
    expect(records.size).toBe(2);
    const doc = records.get(`${DOCUMENT_NSID}/${rkeyFor("Letters/מכתב.md")}`) as { updatedAt: string; publishedAt: string; textContent: string };
    expect([doc.publishedAt, doc.updatedAt]).toEqual(["2026-11-14T08:00:00.000Z", "2026-11-15T08:00:00.000Z"]);
    expect(doc.textContent).toContain("שלום רב");
    await unpublishNote(f, s, "Letters/מכתב.md");
    expect([...records.keys()]).toEqual([`${PUBLICATION_NSID}/${rkeyFor("https://dana.example")}`]);
    // The password went once, to createSession; nothing else carries it.
    expect(log.filter((l) => l.body.includes(PASSWORD)).map((l) => new URL(l.url).pathname)).toEqual(["/xrpc/com.atproto.server.createSession"]);
  });

  it("the static site proves ownership: /.well-known/site.standard.publication and a <link> per page", async () => {
    const pub = `at://${DID}/${PUBLICATION_NSID}/${rkeyFor("https://dana.example")}`;
    const docUri = `at://${DID}/${DOCUMENT_NSID}/${rkeyFor("Letters/a.md")}`;
    const { files } = await buildSite([{ path: "Letters/a.md", content: "# א" }, { path: "b.md", content: "# b" }], { title: "S", lang: "he", render, standardSite: { publication: pub, documents: { "Letters/a.md": docUri } } });
    const get = (p: string) => String(files.find((x) => x.path === p)?.data);
    expect(get(WELL_KNOWN_PATH)).toBe(pub);
    expect(get("Letters/a.html")).toContain(`<link rel="site.standard.document" href="${docUri}" />`);
    expect(get("Letters/a.html")).toContain(`<link rel="site.standard.publication" href="${pub}" />`);
    expect(get("b.html")).not.toContain("site.standard.document");
    const plain = await buildSite([{ path: "b.md", content: "# b" }], { title: "S", lang: "he", render });
    expect(plain.files.some((x) => x.path === WELL_KNOWN_PATH)).toBe(false);
    expect(() => wellKnownFile("https://not-at-uri")).toThrow();
    expect(linkTags(pub)).not.toContain("site.standard.document");
  });

  it("the App Password is a secret-store name; every host is in the ledger and in every CSP", () => {
    expect(isSecretName(APP_PASSWORD_SECRET)).toBe(true);
    for (const h of ["https://bsky.social/xrpc/x", "https://morel.us-east.host.bsky.network/xrpc/x", "https://plc.directory/did:plc:x"]) expect(classify(h)?.category, h).toBe("third-party");
    const headers = readFileSync(join(ROOT, "public/_headers"), "utf8");
    for (const h of ["https://bsky.social", "https://*.host.bsky.network", "https://plc.directory"]) expect(headers).toContain(h);
  });
});
