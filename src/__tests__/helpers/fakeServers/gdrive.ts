/**
 * A Google Drive v3 API in memory (plan 3.5): files with ids, names,
 * parents, appProperties and ETags (the metadata `ETag` header, changed by
 * every update); `files.list` with the `q` grammar Lumen uses; create
 * (multipart) and media `PATCH` with `If-Match` (412 on a lost race);
 * metadata PATCH with addParents/removeParents (the migration's move);
 * DELETE; and the OAuth token endpoint. Bearer token checked.
 */
import type { FakeRequest, FakeResponse, FakeServer } from "./http";

export interface DriveFile {
  id: string;
  name: string;
  mimeType: string;
  parents: string[];
  appProperties?: Record<string, string>;
  data: Uint8Array;
  etag: string;
  trashed: boolean;
  createdTime?: string;
}

export interface FakeGdrive extends FakeServer {
  files: Map<string, DriveFile>;
  token: string;
  pageSize: number;
  outage: number | null;
}


/** The subset of Drive's `q` grammar the client uses, as a predicate. */
function matcher(q: string): (f: DriveFile) => boolean {
  // Split on " and " outside braces (`appProperties has { key=… and value=… }`).
  const clauses: string[] = [];
  let depth = 0;
  let cur = "";
  for (let i = 0; i < q.length; i++) {
    const ch = q[i];
    if (ch === "{") depth++;
    if (ch === "}") depth--;
    if (depth === 0 && /\s/.test(ch) && /^and\s/i.test(q.slice(i + 1))) {
      clauses.push(cur.trim());
      cur = "";
      i += 4;
      continue;
    }
    cur += ch;
  }
  if (cur.trim()) clauses.push(cur.trim());
  const preds = clauses.map((c): ((f: DriveFile) => boolean) => {
    let m: RegExpExecArray | null;
    if ((m = /^'([^']+)'\s+in\s+parents$/i.exec(c))) return (f) => f.parents.includes(m![1]);
    if ((m = /^name\s*=\s*'((?:[^'\\]|\\.)*)'$/i.exec(c))) {
      const name = m[1].replace(/\\(.)/g, "$1");
      return (f) => f.name === name;
    }
    if ((m = /^mimeType\s*=\s*'([^']+)'$/i.exec(c))) return (f) => f.mimeType === m![1];
    if ((m = /^appProperties has \{\s*key='([^']+)' and value='([^']+)'\s*\}$/i.exec(c))) return (f) => f.appProperties?.[m![1]] === m![2];
    if (/^trashed\s*=\s*false$/i.test(c)) return (f) => !f.trashed;
    throw new Error(`fakeGdrive: unsupported q clause "${c}"`);
  });
  return (f) => preds.every((p) => p(f));
}

export function fakeGdrive(opts: { token: string } = { token: "gd-test-token" }): FakeGdrive {
  let seq = 0;
  const server: FakeGdrive = { files: new Map(), token: opts.token, pageSize: 1000, outage: null, log: [], handle: (req) => handle(req) };
  const json = (status: number, body: unknown, headers: Record<string, string> = {}) => ({ status, headers: { "Content-Type": "application/json", ...headers }, body: JSON.stringify(body) });
  const meta = (f: DriveFile) => ({ id: f.id, name: f.name, mimeType: f.mimeType, parents: f.parents, appProperties: f.appProperties, size: String(f.data.length), headRevisionId: f.etag.replace(/"/g, ""), createdTime: f.createdTime });
  const bump = (f: DriveFile) => (f.etag = `"g${++seq}"`);

  function create(fields: Partial<DriveFile>, data: Uint8Array): DriveFile {
    const f: DriveFile = { id: `id${++seq}`, name: fields.name ?? "untitled", mimeType: fields.mimeType ?? "application/octet-stream", parents: fields.parents ?? [], appProperties: fields.appProperties, data: data.slice(), etag: "", trashed: false, createdTime: new Date(Date.UTC(2026, 0, 1) + seq * 1000).toISOString() };
    bump(f);
    server.files.set(f.id, f);
    return f;
  }

  function handle(req: FakeRequest): FakeResponse {
    const p = req.url.pathname;
    server.log.push(`${req.method} ${p}${req.url.search}`);
    if (server.outage) return { status: server.outage, body: "outage" };
    if (p === "/token") return json(200, { access_token: server.token, refresh_token: "gd-refresh", expires_in: 3600 });
    if (req.headers.get("authorization") !== `Bearer ${server.token}`) return json(401, { error: { code: 401, message: "Invalid Credentials" } });

    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/drive/v3/files") {
      const q = req.url.searchParams.get("q") ?? "";
      const token = req.url.searchParams.get("pageToken");
      const all = [...server.files.values()].filter(matcher(q)).sort((a, b) => a.id.localeCompare(b.id));
      const start = token ? Number(token) : 0;
      const page = all.slice(start, start + server.pageSize);
      const body: Record<string, unknown> = { files: page.map(meta) };
      if (start + server.pageSize < all.length) body.nextPageToken = String(start + server.pageSize);
      return json(200, body);
    }
    if (req.method === "POST" && p === "/drive/v3/files") {
      const fields = JSON.parse(new TextDecoder().decode(req.body)) as Partial<DriveFile>;
      return json(200, meta(create(fields, new Uint8Array())));
    }
    if (req.method === "POST" && p === "/upload/drive/v3/files") {
      const ct = req.headers.get("content-type") ?? "";
      const boundary = /boundary=([^;]+)/.exec(ct)?.[1];
      if (!boundary) return json(400, { error: { message: "no boundary" } });
      // Split the bytes themselves: TextDecoder("latin1") is windows-1252 per
      // the Encoding Standard and rewrites 0x80–0x9F, corrupting ciphertext.
      const text = Array.from(req.body, (b) => String.fromCharCode(b)).join("");
      const parts = text.split(`--${boundary}`).filter((x) => x.trim() && x.trim() !== "--");
      const metaJson = new TextDecoder().decode(Uint8Array.from(parts[0].slice(parts[0].indexOf("\r\n\r\n") + 4).trim(), (c) => c.charCodeAt(0)));
      const bodyPart = parts[1];
      const start = bodyPart.indexOf("\r\n\r\n") + 4;
      const raw = bodyPart.slice(start, bodyPart.lastIndexOf("\r\n"));
      const data = Uint8Array.from(raw, (c) => c.charCodeAt(0));
      const f = create(JSON.parse(metaJson) as Partial<DriveFile>, data);
      return json(200, meta(f), { ETag: f.etag });
    }
    if ((m = /^\/upload\/drive\/v3\/files\/([^/]+)$/.exec(p)) && req.method === "PATCH") {
      const f = server.files.get(m[1]);
      if (!f || f.trashed) return json(404, { error: { code: 404, message: "File not found" } });
      const ifMatch = req.headers.get("if-match");
      if (ifMatch !== null && ifMatch !== f.etag) return json(412, { error: { code: 412, message: "Precondition Failed" } });
      f.data = req.body.slice();
      bump(f);
      return json(200, meta(f), { ETag: f.etag });
    }
    if ((m = /^\/drive\/v3\/files\/([^/]+)$/.exec(p))) {
      const f = server.files.get(m[1]);
      if (!f || f.trashed) return json(404, { error: { code: 404, message: "File not found" } });
      if (req.method === "GET" && req.url.searchParams.get("alt") === "media") return { status: 200, headers: { "Content-Type": f.mimeType, ETag: f.etag }, body: f.data.slice() };
      if (req.method === "GET") return json(200, meta(f), { ETag: f.etag });
      if (req.method === "DELETE") {
        server.files.delete(f.id);
        return { status: 204 };
      }
      if (req.method === "PATCH") {
        const fields = JSON.parse(new TextDecoder().decode(req.body) || "{}") as Partial<DriveFile>;
        if (fields.name) f.name = fields.name;
        const add = req.url.searchParams.get("addParents");
        const remove = req.url.searchParams.get("removeParents");
        if (remove) f.parents = f.parents.filter((x) => x !== remove);
        if (add) f.parents.push(add);
        bump(f);
        return json(200, meta(f), { ETag: f.etag });
      }
    }
    return json(404, { error: { message: `unknown endpoint ${req.method} ${p}` } });
  }
  return server;
}
