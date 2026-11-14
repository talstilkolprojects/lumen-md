/**
 * Mock storage servers (plan 3.5) share this shape: a `handle(request)`
 * function over an in-memory store. `fakeFetch` turns one into a `fetch`
 * for the providers' tests; the e2e feeds the same handler to
 * `page.route(...).fulfill` so the browser talks to the same server.
 */

export interface FakeRequest {
  method: string;
  url: URL;
  headers: Headers;
  body: Uint8Array;
}

export interface FakeResponse {
  status: number;
  headers?: Record<string, string>;
  body?: Uint8Array | string;
}

export type FakeHandler = (req: FakeRequest) => Promise<FakeResponse> | FakeResponse;

export interface FakeServer {
  handle: FakeHandler;
  /** Every request, as "METHOD /path", for assertions. */
  log: string[];
}

async function bodyBytes(input: Request | string, init?: RequestInit): Promise<Uint8Array> {
  if (input instanceof Request) return new Uint8Array(await input.clone().arrayBuffer());
  const b = init?.body;
  if (b == null) return new Uint8Array();
  if (typeof b === "string") return new TextEncoder().encode(b);
  if (b instanceof Uint8Array) return b;
  if (b instanceof ArrayBuffer) return new Uint8Array(b);
  if (ArrayBuffer.isView(b)) return new Uint8Array(b.buffer, b.byteOffset, b.byteLength);
  if (b instanceof Blob) return new Uint8Array(await b.arrayBuffer());
  if (b instanceof URLSearchParams) return new TextEncoder().encode(b.toString());
  throw new Error("fakeFetch: unsupported body");
}

/** A `fetch` that answers from `handler`; requests for other hosts fail like a network error. */
export function fakeFetch(handler: FakeHandler, hosts?: string[]): (input: Request | string, init?: RequestInit) => Promise<Response> {
  return async (input, init) => {
    const url = new URL(input instanceof Request ? input.url : input);
    if (hosts && !hosts.includes(url.host)) throw new TypeError(`fakeFetch: no route to ${url.host}`);
    const method = (input instanceof Request ? input.method : init?.method) ?? "GET";
    const headers = new Headers(input instanceof Request ? input.headers : init?.headers);
    const body = await bodyBytes(input, init);
    const res = await handler({ method: method.toUpperCase(), url, headers, body });
    const payload = res.body === undefined ? null : typeof res.body === "string" ? res.body : (res.body.slice() as BodyInit);
    return new Response(res.status === 204 || res.status === 304 ? null : payload, { status: res.status, headers: res.headers });
  };
}

/** Several servers behind one fetch, by host. */
export function fakeNetwork(servers: Record<string, FakeHandler>): (input: Request | string, init?: RequestInit) => Promise<Response> {
  const hosts = Object.keys(servers);
  return fakeFetch((req) => servers[req.url.host](req), hosts);
}

export const text = (s: string) => new TextEncoder().encode(s);
export const utf8 = (b: Uint8Array) => new TextDecoder().decode(b);

export function same(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  for (let i = 0; i < a.byteLength; i++) if (a[i] !== b[i]) return false;
  return true;
}
