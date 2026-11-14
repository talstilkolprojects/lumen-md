/**
 * A WebDAV server in memory (plan 3.5): one collection, files with ETags,
 * the preconditions `If-Match` / `If-None-Match` (412 on a miss), PROPFIND
 * with Depth 0 / 1, MKCOL, HEAD, DELETE. Optional Basic auth.
 */
import type { FakeHandler, FakeRequest, FakeResponse, FakeServer } from "./http";

export interface WebdavFile {
  data: Uint8Array;
  etag: string;
}

export interface FakeWebdav extends FakeServer {
  files: Map<string, WebdavFile>;
  /** The collection exists (MKCOL happened or `preCreated`). */
  collection: boolean;
  /** Answer every request with this status once set (an outage). */
  outage: number | null;
  /** Leave out ETags (a server the sync must refuse). */
  noEtags: boolean;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fakeWebdav(opts: { baseUrl: string; username?: string; password?: string; preCreated?: boolean } = { baseUrl: "https://dav.example/lumen/" }): FakeWebdav {
  const base = new URL(opts.baseUrl);
  const basePath = base.pathname.replace(/\/+$/, "");
  let seq = 0;
  const server: FakeWebdav = {
    files: new Map(),
    collection: !!opts.preCreated,
    outage: null,
    noEtags: false,
    log: [],
    handle: (req) => handle(req),
  };
  const etagHeader = (f: WebdavFile): Record<string, string> => (server.noEtags ? {} : { ETag: f.etag });
  const nameOf = (req: FakeRequest): string | null => {
    const p = decodeURIComponent(req.url.pathname);
    if (p === basePath || p === basePath + "/") return "";
    if (!p.startsWith(basePath + "/")) return null;
    const rest = p.slice(basePath.length + 1);
    return rest.includes("/") ? null : rest;
  };
  const propfindXml = (entries: Array<{ href: string; file?: WebdavFile; collection?: boolean }>) =>
    `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:">${entries
      .map(
        (e) =>
          `<d:response><d:href>${xmlEscape(e.href)}</d:href><d:propstat><d:prop>` +
          (e.collection ? `<d:resourcetype><d:collection/></d:resourcetype>` : `<d:resourcetype/>`) +
          (e.file && !server.noEtags ? `<d:getetag>${xmlEscape(e.file.etag)}</d:getetag>` : "") +
          `</d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`,
      )
      .join("")}</d:multistatus>`;

  function handle(req: FakeRequest): FakeResponse {
    server.log.push(`${req.method} ${decodeURIComponent(req.url.pathname)}`);
    if (server.outage) return { status: server.outage, body: "outage" };
    if (opts.username) {
      const expected = "Basic " + btoa(`${opts.username}:${opts.password ?? ""}`);
      if (req.headers.get("authorization") !== expected) return { status: 401, headers: { "WWW-Authenticate": 'Basic realm="dav"' }, body: "unauthorized" };
    }
    const name = nameOf(req);
    if (name === null) return { status: 404, body: "not found" };
    if (name === "") {
      // The collection itself.
      switch (req.method) {
        case "MKCOL":
          if (server.collection) return { status: 405, body: "exists" };
          server.collection = true;
          return { status: 201 };
        case "PROPFIND": {
          if (!server.collection) return { status: 404, body: "not found" };
          const depth = req.headers.get("depth") ?? "1";
          const entries: Array<{ href: string; file?: WebdavFile; collection?: boolean }> = [{ href: basePath + "/", collection: true }];
          if (depth !== "0") for (const [n, f] of server.files) entries.push({ href: `${basePath}/${encodeURIComponent(n)}`, file: f });
          return { status: 207, headers: { "Content-Type": "application/xml" }, body: propfindXml(entries) };
        }
        default:
          return { status: 405, body: "method not allowed" };
      }
    }
    if (!server.collection) return { status: 409, body: "no collection" };
    const cur = server.files.get(name);
    switch (req.method) {
      case "GET":
        if (!cur) return { status: 404, body: "not found" };
        return { status: 200, headers: { "Content-Type": "application/octet-stream", ...etagHeader(cur) }, body: cur.data.slice() };
      case "HEAD":
        if (!cur) return { status: 404 };
        return { status: 200, headers: etagHeader(cur) };
      case "PROPFIND":
        if (!cur) return { status: 404, body: "not found" };
        return { status: 207, headers: { "Content-Type": "application/xml" }, body: propfindXml([{ href: `${basePath}/${encodeURIComponent(name)}`, file: cur }]) };
      case "PUT": {
        const ifMatch = req.headers.get("if-match");
        const ifNone = req.headers.get("if-none-match");
        if (ifMatch !== null && (!cur || cur.etag !== ifMatch)) return { status: 412, body: "precondition failed" };
        if (ifNone === "*" && cur) return { status: 412, body: "precondition failed" };
        const f: WebdavFile = { data: req.body.slice(), etag: `"w${++seq}"` };
        server.files.set(name, f);
        return { status: cur ? 204 : 201, headers: etagHeader(f) };
      }
      case "DELETE":
        if (!cur) return { status: 404, body: "not found" };
        server.files.delete(name);
        return { status: 204 };
      default:
        return { status: 405, body: "method not allowed" };
    }
  }
  return server;
}

export type { FakeHandler };
