/**
 * A small CalDAV client for tasks (plan W7.20, RFC 4791): list a calendar's
 * VTODOs with their ETags, create and update them with If-Match /
 * If-None-Match (no lost update when the server changed in between), delete,
 * and make a calendar. fetch is passed in: on the desktop it is Tauri's (no
 * CORS); in the PWA it is the browser's, wrapped by the privacy ledger
 * (`caldavFetch`), and a server that refuses CORS gets a clear error.
 *
 * Written here instead of depending on tsdav: we need six requests, the
 * lockfile can't change in this repo's CI, and every byte here is lazy.
 */

export interface DavResource {
  /** Absolute URL of the resource. */
  href: string;
  etag: string;
  ics: string;
}

export interface CalDavOptions {
  /** The calendar collection's URL, ending in `/`. */
  collection: string;
  fetch: typeof fetch;
  /** `Authorization` header value (Basic or Bearer), from the secret store; never logged. */
  authorization?: string;
}

export class CalDavError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly kind: "conflict" | "not-found" | "auth" | "cors" | "server",
  ) {
    super(message);
    this.name = "CalDavError";
  }
}

const XML = 'application/xml; charset="utf-8"';

const QUERY_TODOS = `<?xml version="1.0" encoding="utf-8"?>
<c:calendar-query xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:prop><d:getetag/><c:calendar-data/></d:prop>
  <c:filter><c:comp-filter name="VCALENDAR"><c:comp-filter name="VTODO"/></c:comp-filter></c:filter>
</c:calendar-query>`;

const MKCALENDAR_BODY = (name: string) => `<?xml version="1.0" encoding="utf-8"?>
<c:mkcalendar xmlns:d="DAV:" xmlns:c="urn:ietf:params:xml:ns:caldav">
  <d:set><d:prop><d:displayname>${name.replace(/[<&]/g, (c) => (c === "<" ? "&lt;" : "&amp;"))}</d:displayname>
  <c:supported-calendar-component-set><c:comp name="VTODO"/></c:supported-calendar-component-set></d:prop></d:set>
</c:mkcalendar>`;

const decodeXml = (s: string) =>
  s
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n: string) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_, n: string) => String.fromCodePoint(parseInt(n, 16)))
    .replace(/&amp;/g, "&");

/** The text of the first element with this local name (any namespace prefix). */
function element(xml: string, local: string): string | null {
  const m = new RegExp(`<(?:[A-Za-z0-9_-]+:)?${local}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[A-Za-z0-9_-]+:)?${local}>`).exec(xml);
  return m ? decodeXml(m[1].trim()) : null;
}

/** A 207 multistatus body: each response's href, ETag and calendar data. No DOM needed (works in a worker and in Node). */
export function parseMultistatus(xml: string, base: string): DavResource[] {
  const out: DavResource[] = [];
  for (const m of xml.matchAll(/<(?:[A-Za-z0-9_-]+:)?response(?:\s[^>]*)?>([\s\S]*?)<\/(?:[A-Za-z0-9_-]+:)?response>/g)) {
    const body = m[1];
    const href = element(body, "href");
    const ics = element(body, "calendar-data");
    if (!href || !ics) continue;
    out.push({ href: new URL(href, base).href, etag: element(body, "getetag") ?? "", ics });
  }
  return out;
}

export function createCalDavClient(opts: CalDavOptions) {
  const collection = opts.collection.endsWith("/") ? opts.collection : opts.collection + "/";
  async function req(method: string, url: string, init: { body?: string; headers?: Record<string, string> } = {}): Promise<Response> {
    const headers: Record<string, string> = { ...init.headers };
    if (opts.authorization) headers.Authorization = opts.authorization;
    let res: Response;
    try {
      // privacy-ledger: the caller passes calendarFetch() (config.ts), which records every request.
      res = await opts.fetch(url, { method, headers, body: init.body });
    } catch (e) {
      // A browser hides why: a CORS refusal and an unreachable server look the same.
      throw new CalDavError(`CalDAV ${method} failed before a response (the server may not allow this app's origin, CORS): ${String(e)}`, 0, "cors");
    }
    if (res.status === 401 || res.status === 403) throw new CalDavError(`CalDAV ${method}: ${res.status}`, res.status, "auth");
    if (res.status === 412) throw new CalDavError(`CalDAV ${method}: the server copy changed (412)`, 412, "conflict");
    if (res.status === 404) throw new CalDavError(`CalDAV ${method}: not found`, 404, "not-found");
    if (res.status >= 400) throw new CalDavError(`CalDAV ${method}: ${res.status}`, res.status, "server");
    return res;
  }
  const etagOf = (res: Response) => res.headers.get("etag") ?? "";
  return {
    collection,
    /** Every VTODO in the calendar. */
    async list(): Promise<DavResource[]> {
      const res = await req("REPORT", collection, { body: QUERY_TODOS, headers: { "Content-Type": XML, Depth: "1" } });
      return parseMultistatus(await res.text(), collection);
    },
    /** Create a resource: fails (conflict) if one is already at that name. */
    async create(name: string, ics: string): Promise<{ href: string; etag: string }> {
      const href = new URL(encodeURIComponent(name), collection).href;
      const res = await req("PUT", href, { body: ics, headers: { "Content-Type": "text/calendar; charset=utf-8", "If-None-Match": "*" } });
      return { href, etag: etagOf(res) };
    },
    /** Update only if the server still has `etag`; a 412 is a conflict for the caller to show. */
    async update(href: string, ics: string, etag: string): Promise<{ etag: string }> {
      const res = await req("PUT", href, { body: ics, headers: { "Content-Type": "text/calendar; charset=utf-8", ...(etag ? { "If-Match": etag } : {}) } });
      return { etag: etagOf(res) };
    },
    async remove(href: string, etag: string): Promise<void> {
      try {
        await req("DELETE", href, { headers: etag ? { "If-Match": etag } : {} });
      } catch (e) {
        if (!(e instanceof CalDavError && e.kind === "not-found")) throw e;
      }
    },
    /** MKCOL the parent and MKCALENDAR the collection (tests and first setup); an existing one is fine. */
    async makeCalendar(name: string): Promise<void> {
      const parent = new URL("..", collection).href;
      for (const [method, url, body] of [["MKCOL", parent, undefined], ["MKCALENDAR", collection, MKCALENDAR_BODY(name)]] as const) {
        try {
          await req(method, url, body ? { body, headers: { "Content-Type": XML } } : {});
        } catch (e) {
          if (!(e instanceof CalDavError && (e.status === 405 || e.status === 409))) throw e;
        }
      }
    },
  };
}

export type CalDavClient = ReturnType<typeof createCalDavClient>;

/** `Authorization: Basic …` for a user name and an app password (UTF-8). */
export function basicAuth(user: string, password: string): string {
  const bytes = new TextEncoder().encode(`${user}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}
