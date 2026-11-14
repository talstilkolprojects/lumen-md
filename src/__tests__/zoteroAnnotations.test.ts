/**
 * W6.47 — highlights made in the PDF reader go back to Zotero as annotation
 * items, through the Web API (W5.23), only with the user's consent and a key
 * that may write. api.zotero.org is not reachable here: the "test
 * environment" is the stand-in below — a Zotero user library that stores
 * what is POSTed and lists it back, answering in the documented shapes
 * (fixtures/zotero-web/SOURCES.md).
 */
import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createPdfAnnotation, shortId } from "../pdf/annotations";
import {
  findAttachmentKey,
  HIGHLIGHT_COLOR,
  namedAttachment,
  parseSent,
  sendAnnotations,
  toZoteroAnnotation,
  writeToken,
  zoteroCall,
  ZoteroWriteError,
  type ZoteroCall,
} from "../citations/zoteroAnnotations";
import { emptyState } from "../citations/zoteroWeb";
import { blockedByPolicy, classify } from "../ai/privacyLedger";

const FX = join(__dirname, "fixtures/zotero-web");
const fx = (f: string) => JSON.parse(readFileSync(join(FX, f), "utf8"));
const USER = 475425;
const PAGE_H = 842;

const TEXT = "פרוטוקול ישיבה\nהספרייה העירונית נפתחה מחדש אחרי שיפוץ של שנתיים.\n";
const hl = (id: string, page: number, start: number, end: number, note = "") =>
  createPdfAnnotation({ id, source: "papers/oz.pdf", page, text: TEXT, start, end, rect: { left: 72, top: 100 + page, width: 300, height: 14 }, note, now: new Date("2026-11-12T10:00:00Z") });

/** A Zotero user library: keys, write tokens, POSTed items stored and listed back. */
function fakeZotero(opts: { write?: boolean; failIndex?: number } = {}) {
  const items = new Map<string, Record<string, unknown>>();
  const tokens = new Set<string>();
  const log: Array<{ method: string; path: string; headers: Record<string, string>; body?: unknown }> = [];
  let version = 1190;
  let n = 0;
  const call: ZoteroCall = async (method, path, body, headers = {}) => {
    log.push({ method, path, headers, body });
    const res = (status: number, json: unknown) => ({ status, headers: new Headers({ "Last-Modified-Version": String(version) }), body: JSON.stringify(json) });
    if (method === "GET" && path === "/keys/current") return res(200, opts.write === false ? fx("keys-current.json") : fx("keys-current-write.json"));
    if (method === "POST" && path === `/users/${USER}/items`) {
      const access = (opts.write === false ? fx("keys-current.json") : fx("keys-current-write.json")).access.user;
      if (!access.write) return res(403, "Write access denied");
      const tok = headers["Zotero-Write-Token"];
      if (!/^[0-9a-f]{32}$/.test(tok ?? "")) return res(400, "bad token");
      if (tokens.has(tok)) return res(412, "Write token already used");
      tokens.add(tok);
      const list = body as Array<Record<string, unknown>>;
      if (list.length > 50) return res(413, "Too many");
      const out = { successful: {} as Record<string, unknown>, success: {} as Record<string, string>, unchanged: {}, failed: {} as Record<string, unknown> };
      version++;
      list.forEach((it, i) => {
        if (i === opts.failIndex) return void (out.failed[i] = { key: "", code: 400, message: "refused" });
        const A = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";
        const k = ++n;
        const key = `ANNO${A[Math.floor(k / A.length ** 3) % A.length]}${A[Math.floor(k / A.length ** 2) % A.length]}${A[Math.floor(k / A.length) % A.length]}${A[k % A.length]}`;
        items.set(key, { ...it, key, version });
        out.successful[i] = { key, version, data: { ...it, key, version } };
        out.success[i] = key;
      });
      return res(200, out);
    }
    if (method === "GET" && path.startsWith(`/users/${USER}/items/PDFX2345/children`)) return res(200, [...items.values()].map((data) => ({ key: data.key, data })));
    return res(404, "not found");
  };
  return { call, items, log, tokens };
}

describe("W6.47 the annotation item", () => {
  it("is Zotero's highlight: quote, note, colour, page, sort index, a bottom-left rectangle in points", () => {
    const a = hl("11111111-1111-4111-8111-111111111111", 3, 15, 41, "חשוב");
    const it0 = toZoteroAnnotation(a, "PDFX2345", PAGE_H)!;
    expect(it0).toMatchObject({
      itemType: "annotation",
      parentItem: "PDFX2345",
      annotationType: "highlight",
      annotationText: TEXT.slice(15, 41),
      annotationComment: "חשוב",
      annotationColor: HIGHLIGHT_COLOR,
      annotationPageLabel: "3",
      annotationSortIndex: "00002|000015|00103",
    });
    // Top-left (Lumen) → bottom-left (PDF / Zotero): y1 = H − (top + height), y2 = H − top.
    expect(JSON.parse(it0.annotationPosition)).toEqual({ pageIndex: 2, rects: [[72, PAGE_H - 117, 372, PAGE_H - 103]] });
    expect(toZoteroAnnotation(hl("22222222-2222-4222-8222-222222222222", 1, 14, 15), "PDFX2345", PAGE_H)).toBeNull();
  });

  it("finds the PDF's attachment: named in the note, else the one PDF with that file name", () => {
    const state = emptyState();
    state.items.PDFX2345 = { ...fx("item-pdf.json").data, version: 1, type: "attachment", collections: [], attachment: { mode: "imported_file", contentType: "application/pdf", filename: "Oz - 2002 - Sipur.pdf" } };
    expect(findAttachmentKey(state, "papers/Oz - 2002 - Sipur.pdf")).toBe("PDFX2345");
    expect(findAttachmentKey(state, "papers/other.pdf")).toBeNull();
    expect(findAttachmentKey(state, "papers/other.pdf", "PDFX2345")).toBe("PDFX2345");
    expect(findAttachmentKey(state, "papers/other.pdf", "NOPE2345")).toBeNull();
    state.items.PDFY2345 = { ...state.items.PDFX2345 };
    expect(findAttachmentKey(state, "papers/Oz - 2002 - Sipur.pdf")).toBeNull();
    expect(namedAttachment("---\ntitle: x\nzotero-attachment: PDFX2345\n---\n# n")).toBe("PDFX2345");
    expect(namedAttachment("# no front matter\nzotero-attachment: PDFX2345")).toBeNull();
  });

  it("write tokens are 32 hex characters and never repeat", () => {
    const seen = new Set(Array.from({ length: 200 }, writeToken));
    expect(seen.size).toBe(200);
    for (const tkn of seen) expect(tkn).toMatch(/^[0-9a-f]{32}$/);
  });
});

describe("W6.47 sending: consent, write access, once per highlight", () => {
  const anns = [hl("11111111-1111-4111-8111-111111111111", 1, 15, 41, "הערה"), hl("33333333-3333-4333-8333-333333333333", 2, 42, 60)];
  const send = (call: ZoteroCall, consent = true, sentFile = parseSent(null)) =>
    sendAnnotations({ call, userID: USER, parentItem: "PDFX2345", annotations: anns, pageHeights: [PAGE_H, PAGE_H], sentFile, consent, now: 1 });

  it("without consent nothing is asked of zotero.org at all", async () => {
    const z = fakeZotero();
    await expect(send(z.call, false)).rejects.toMatchObject({ reason: "no-consent" });
    expect(z.log).toEqual([]);
  });

  it("a read-only key: refused before any POST, and the user is told to allow writing", async () => {
    const z = fakeZotero({ write: false });
    await expect(send(z.call)).rejects.toBeInstanceOf(ZoteroWriteError);
    await expect(send(z.call)).rejects.toMatchObject({ reason: "no-write-access" });
    expect(z.log.filter((l) => l.method === "POST")).toEqual([]);
  });

  it("a highlight written here appears in Zotero (the test library) under the PDF, and is not sent twice", async () => {
    const z = fakeZotero();
    const r = await send(z.call);
    expect(r).toMatchObject({ sent: 2, skipped: 0, failed: [], requests: 2 });
    // Listed back from the library, as Zotero shows it under the PDF.
    const children = JSON.parse((await z.call("GET", `/users/${USER}/items/PDFX2345/children`)).body) as Array<{ data: Record<string, unknown> }>;
    expect(children.map((c) => c.data.annotationText)).toEqual([TEXT.slice(15, 41), TEXT.slice(42, 60).trim()]);
    expect(children[0].data).toMatchObject({ itemType: "annotation", parentItem: "PDFX2345", annotationComment: "הערה" });
    const post = z.log.find((l) => l.method === "POST")!;
    expect(post.headers["Zotero-Write-Token"]).toMatch(/^[0-9a-f]{32}$/);
    // What was sent is remembered: a second send posts nothing new.
    const again = await send(z.call, true, r.sentFile);
    expect(again).toMatchObject({ sent: 0, skipped: 2 });
    expect(z.items.size).toBe(2);
    expect(Object.keys(r.sentFile.sent).sort()).toEqual(anns.map((a) => shortId(a.id)).sort());
  });

  it("a highlight Zotero refuses is reported and sent again next time", async () => {
    const z = fakeZotero({ failIndex: 1 });
    const r = await send(z.call);
    expect(r.sent).toBe(1);
    expect(r.failed).toEqual([{ id: shortId(anns[1].id), message: "refused" }]);
    expect(Object.keys(r.sentFile.sent)).toEqual([shortId(anns[0].id)]);
  });

  it("the documented response (successful / failed by index) is read the same way", async () => {
    const body = JSON.stringify(fx("write-annotations-response.json"));
    const call: ZoteroCall = async (method) =>
      method === "GET" ? { status: 200, headers: new Headers(), body: JSON.stringify(fx("keys-current-write.json")) } : { status: 200, headers: new Headers(), body };
    const r = await send(call);
    expect(r.sent).toBe(1);
    expect(r.sentFile.sent[shortId(anns[0].id)]).toMatchObject({ key: "ANNO2345", parent: "PDFX2345" });
    expect(r.failed[0].message).toMatch(/annotationText/);
  });

  it("120 highlights go in batches of at most 50, each with its own write token", async () => {
    const z = fakeZotero();
    const many = Array.from({ length: 120 }, (_, i) => hl(`${String(i).padStart(8, "0")}-1111-4111-8111-111111111111`, 1, 15, 41));
    const r = await sendAnnotations({ call: z.call, userID: USER, parentItem: "PDFX2345", annotations: many, pageHeights: [PAGE_H], sentFile: parseSent(null), consent: true });
    const posts = z.log.filter((l) => l.method === "POST");
    expect(posts.map((p) => (p.body as unknown[]).length)).toEqual([50, 50, 20]);
    expect(new Set(posts.map((p) => p.headers["Zotero-Write-Token"])).size).toBe(3);
    expect(r.sent).toBe(120);
  });

  it("the real request: POST with JSON, the key and API version headers, through the given fetch", async () => {
    const seen: Array<{ url: string; init: RequestInit }> = [];
    const doFetch = async (url: string, init: RequestInit) => {
      seen.push({ url, init });
      return new Response(JSON.stringify({ successful: {} }), { status: 200 });
    };
    await zoteroCall("k3y", doFetch)("POST", `/users/${USER}/items`, [{ a: 1 }], { "Zotero-Write-Token": "t" });
    expect(seen[0].url).toBe(`https://api.zotero.org/users/${USER}/items`);
    expect(seen[0].init).toMatchObject({ method: "POST", body: '[{"a":1}]', headers: { "Zotero-API-Key": "k3y", "Zotero-API-Version": "3", "Content-Type": "application/json", "Zotero-Write-Token": "t" } });
  });

  it("the route is in the privacy ledger and a local-only policy blocks it", () => {
    const c = classify("https://api.zotero.org/users/1/items")!;
    expect(c.category).toBe("research");
    expect(c.reason).toMatch(/writes only the PDF highlights you send/);
    expect(blockedByPolicy(c.category, "local-only")).toBe(true);
  });
});
