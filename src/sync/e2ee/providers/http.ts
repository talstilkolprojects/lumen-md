/**
 * HTTP plumbing shared by the storage providers (plan 3.5): one fetch
 * signature the tests can replace, bounded retries for transient failures,
 * and the mapping of status codes onto the sync's error classes.
 *
 * `fetch` is read at call time, so the privacy ledger's wrapped
 * `window.fetch` sees every request, and a test can hand in a fake server.
 */

import { PreconditionFailedError, ProviderUnavailableError } from "../provider";

export type FetchLike = (input: Request | string, init?: RequestInit) => Promise<Response>;

export const defaultFetch: FetchLike = (input, init) => globalThis.fetch(input, init);

/** The provider refused the credentials (401 / 403). */
export class ProviderAuthError extends Error {
  constructor(
    readonly provider: string,
    readonly status: number,
  ) {
    super(`${provider}: the storage refused the credentials (${status})`);
    this.name = "ProviderAuthError";
  }
}

/** The provider cannot do what the sync needs (no ETags, no conditional writes). */
export class ProviderUnsupportedError extends Error {
  constructor(provider: string, what: string) {
    super(`${provider}: ${what}`);
    this.name = "ProviderUnsupportedError";
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/**
 * `fetch` with up to `retries` more attempts on a network error, a 5xx or a
 * 429 (not on other 4xx: those are answers). After the last attempt a
 * transient failure becomes `ProviderUnavailableError`, so a sync round can
 * be retried as a whole.
 */
export async function request(
  fetchImpl: FetchLike,
  input: Request | string,
  init: RequestInit | undefined,
  opts: { provider: string; retries?: number; baseDelayMs?: number } = { provider: "provider" },
): Promise<Response> {
  const retries = opts.retries ?? 2;
  let last: unknown;
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const res = await fetchImpl(input instanceof Request && attempt > 0 ? input.clone() : input, init);
      if (res.status >= 500 || res.status === 429) {
        last = new ProviderUnavailableError(`${opts.provider}: ${res.status} ${res.statusText}`);
        if (attempt < retries) {
          await sleep((opts.baseDelayMs ?? 300) * 2 ** attempt);
          continue;
        }
        throw last;
      }
      return res;
    } catch (e) {
      if (e instanceof ProviderUnavailableError) throw e;
      // A network error: offline, DNS, CORS, abort.
      last = e;
      if (attempt < retries) {
        await sleep((opts.baseDelayMs ?? 300) * 2 ** attempt);
        continue;
      }
    }
  }
  throw new ProviderUnreachableError(`${opts.provider}: ${(last as Error)?.message ?? "network error"}`);
}

/**
 * The request never got an answer: offline, DNS — or, in a browser, CORS or
 * the page's CSP refused it (fetch cannot tell them apart). Still a
 * `ProviderUnavailableError` to the sync engine: retry later.
 */
export class ProviderUnreachableError extends ProviderUnavailableError {
  constructor(message: string) {
    super(message);
    this.name = "ProviderUnreachableError";
  }
}

/** The error for a non-success answer: 412 → precondition, 401/403 → auth, else a plain error. */
export async function failed(res: Response, provider: string, objectName: string): Promise<Error> {
  if (res.status === 412) return new PreconditionFailedError(objectName);
  if (res.status === 401 || res.status === 403) return new ProviderAuthError(provider, res.status);
  const text = await res.text().catch(() => "");
  return new Error(`${provider}: ${res.status} ${res.statusText}${text ? ` — ${text.slice(0, 200)}` : ""}`);
}

/** Basic auth header value. */
export function basicAuth(username: string, password: string): string {
  const bytes = new TextEncoder().encode(`${username}:${password}`);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return `Basic ${btoa(bin)}`;
}

/** Only the vault's object names reach a provider: the fixed header name or a 43-character HMAC name. */
export function checkObjectName(name: string): void {
  if (!/^[A-Za-z0-9_.-]{1,64}$/.test(name)) throw new Error(`Invalid object name "${name}"`);
}

/** XML without a dependency: the browser's (and jsdom's) DOMParser. */
export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

/** Every element with local name `local`, whatever its namespace prefix. */
export function elements(root: ParentNode, local: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((el) => el.localName === local);
}
