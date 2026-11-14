/**
 * A Dropbox API in memory (plan 3.5): files/download (rev in
 * `Dropbox-API-Result`), files/upload with mode overwrite / add /
 * update(rev) and `strict_conflict` (409 `path/conflict` on a lost race),
 * delete_v2, list_folder (+continue, small pages), move_v2 (the migration's
 * backup step), and the OAuth token endpoints. Bearer token checked.
 */
import type { FakeRequest, FakeResponse, FakeServer } from "./http";

export interface DropboxEntry {
  data: Uint8Array;
  rev: string;
}

export interface FakeDropbox extends FakeServer {
  /** Files by full lower-cased path, e.g. "/apps/lumen/vault/<name>". */
  files: Map<string, DropboxEntry & { display: string }>;
  token: string;
  pageSize: number;
  outage: number | null;
}

const err = (status: number, tag: string, inner?: Record<string, unknown>) => ({
  status,
  headers: { "Content-Type": "application/json" },
  body: JSON.stringify({ error_summary: `${tag}/..`, error: { ".tag": tag, ...(inner ?? {}) } }),
});
const notFound = () => err(409, "path", { path: { ".tag": "not_found" } });
const conflict = () => err(409, "path", { path: { ".tag": "conflict", conflict: { ".tag": "file" } } });

export function fakeDropbox(opts: { token: string } = { token: "dbx-test-token" }): FakeDropbox {
  let seq = 0;
  const server: FakeDropbox = { files: new Map(), token: opts.token, pageSize: 1000, outage: null, log: [], handle: (req) => handle(req) };
  const put = (display: string, data: Uint8Array) => {
    const e = { data: data.slice(), rev: `r${++seq}`, display };
    server.files.set(display.toLowerCase(), e);
    return e;
  };
  const meta = (e: { display: string; rev: string; data: Uint8Array }) => ({
    ".tag": "file",
    name: e.display.split("/").pop(),
    path_lower: e.display.toLowerCase(),
    path_display: e.display,
    rev: e.rev,
    size: e.data.length,
    server_modified: "2026-10-24T10:00:00Z",
  });

  function handle(req: FakeRequest): FakeResponse {
    const p = req.url.pathname;
    server.log.push(`${req.method} ${p}`);
    if (server.outage) return { status: server.outage, body: "outage" };
    if (p === "/oauth2/token") {
      return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ access_token: server.token, refresh_token: "dbx-refresh", expires_in: 14400 }) };
    }
    if (req.headers.get("authorization") !== `Bearer ${server.token}`) return err(401, "invalid_access_token");
    const arg = () => {
      const h = req.headers.get("dropbox-api-arg");
      return h ? (JSON.parse(h) as Record<string, unknown>) : (JSON.parse(new TextDecoder().decode(req.body) || "{}") as Record<string, unknown>);
    };
    switch (p) {
      case "/2/files/download": {
        const e = server.files.get(String(arg().path).toLowerCase());
        if (!e) return notFound();
        return { status: 200, headers: { "Content-Type": "application/octet-stream", "Dropbox-API-Result": JSON.stringify(meta(e)) }, body: e.data.slice() };
      }
      case "/2/files/upload": {
        const a = arg() as { path: string; mode: string | { ".tag": string; update?: string }; autorename?: boolean; strict_conflict?: boolean };
        const key = a.path.toLowerCase();
        const cur = server.files.get(key);
        const mode = typeof a.mode === "string" ? a.mode : a.mode[".tag"];
        if (mode === "add" && cur) {
          if (a.autorename) return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta(put(a.path + " (1)", req.body))) };
          return conflict();
        }
        if (mode === "update") {
          const want = typeof a.mode === "object" ? a.mode.update : undefined;
          if (!cur || cur.rev !== want) {
            // Without strict_conflict Dropbox would autorename a "conflicted copy".
            if (!a.strict_conflict && a.autorename) return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta(put(a.path + " (conflicted copy)", req.body))) };
            return conflict();
          }
        }
        const e = put(a.path, req.body);
        return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify(meta(e)) };
      }
      case "/2/files/delete_v2": {
        const key = String(arg().path).toLowerCase();
        const e = server.files.get(key);
        if (!e) return notFound();
        server.files.delete(key);
        return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metadata: meta(e) }) };
      }
      case "/2/files/move_v2": {
        const a = arg() as { from_path: string; to_path: string };
        const e = server.files.get(a.from_path.toLowerCase());
        if (!e) return notFound();
        if (server.files.has(a.to_path.toLowerCase())) return conflict();
        server.files.delete(a.from_path.toLowerCase());
        const moved = { ...e, display: a.to_path };
        server.files.set(a.to_path.toLowerCase(), moved);
        return { status: 200, headers: { "Content-Type": "application/json" }, body: JSON.stringify({ metadata: meta(moved) }) };
      }
      case "/2/files/list_folder":
      case "/2/files/list_folder/continue": {
        const a = arg() as { path?: string; recursive?: boolean; cursor?: string };
        let folder: string;
        let start = 0;
        let recursive = false;
        if (a.cursor) {
          const c = JSON.parse(atob(a.cursor)) as { folder: string; start: number; recursive: boolean };
          folder = c.folder;
          start = c.start;
          recursive = c.recursive;
        } else {
          folder = String(a.path ?? "").toLowerCase().replace(/\/+$/, "");
          recursive = !!a.recursive;
        }
        const all = [...server.files.values()]
          .filter((e) => {
            const low = e.display.toLowerCase();
            if (!low.startsWith(folder + "/")) return false;
            return recursive || !low.slice(folder.length + 1).includes("/");
          })
          .sort((x, y) => x.display.localeCompare(y.display));
        if (!all.length && !a.cursor && ![...server.files.keys()].some((k) => k.startsWith(folder + "/")) && folder !== "") {
          // An unknown folder is not_found; an empty but implied one lists nothing.
          return notFound();
        }
        const page = all.slice(start, start + server.pageSize);
        const hasMore = start + server.pageSize < all.length;
        return {
          status: 200,
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ entries: page.map(meta), cursor: btoa(JSON.stringify({ folder, start: start + server.pageSize, recursive })), has_more: hasMore }),
        };
      }
      default:
        return { status: 404, body: `unknown endpoint ${p}` };
    }
  }
  return server;
}
