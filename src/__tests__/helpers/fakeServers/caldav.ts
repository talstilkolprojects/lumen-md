/**
 * A CalDAV calendar in memory (plan W7.20), as a `fetch`: resources with
 * ETags, PUT with If-Match / If-None-Match (412 on a miss), DELETE with
 * If-Match, REPORT calendar-query (all resources), MKCOL and MKCALENDAR.
 * Basic auth is required when a password is given.
 */
export interface FakeCalDav {
  fetch: typeof fetch;
  items: Map<string, { etag: string; ics: string }>;
  requests: Array<{ method: string; url: string; authorization: string | null }>;
}

export function fakeCalDav(opts: { collection: string; authorization?: string }): FakeCalDav {
  const items = new Map<string, { etag: string; ics: string }>();
  const requests: FakeCalDav["requests"] = [];
  let seq = 0;
  const col = new URL(opts.collection).pathname;
  const esc = (s: string) => s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
  const res = (status: number, body = "", headers: Record<string, string> = {}) => new Response(status === 204 ? null : body, { status, headers });
  const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(typeof input === "string" ? input : input instanceof URL ? input.href : input.url);
    const method = (init?.method ?? "GET").toUpperCase();
    const h = new Headers(init?.headers);
    requests.push({ method, url: url.href, authorization: h.get("authorization") });
    if (opts.authorization && h.get("authorization") !== opts.authorization) return res(401);
    const path = decodeURIComponent(url.pathname);
    if (method === "MKCOL" || method === "MKCALENDAR") return res(201);
    if (method === "REPORT" && url.pathname === col) {
      const body = [...items].map(([p, it]) => `<d:response><d:href>${esc(p)}</d:href><d:propstat><d:prop><d:getetag>${esc(it.etag)}</d:getetag><cal:calendar-data>${esc(it.ics)}</cal:calendar-data></d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`).join("");
      return res(207, `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:cal="urn:ietf:params:xml:ns:caldav">${body}</d:multistatus>`);
    }
    const cur = items.get(path);
    const ifMatch = h.get("if-match");
    if (method === "PUT") {
      if (h.get("if-none-match") === "*" && cur) return res(412);
      if (ifMatch && (!cur || cur.etag !== ifMatch)) return res(412);
      const etag = `"${++seq}"`;
      items.set(path, { etag, ics: String(init?.body ?? "") });
      return res(cur ? 204 : 201, "", { ETag: etag });
    }
    if (method === "DELETE") {
      if (!cur) return res(404);
      if (ifMatch && cur.etag !== ifMatch) return res(412);
      items.delete(path);
      return res(204);
    }
    if (method === "GET") return cur ? res(200, cur.ics, { ETag: cur.etag }) : res(404);
    return res(405);
  };
  return { fetch: fetchImpl as typeof fetch, items, requests };
}
