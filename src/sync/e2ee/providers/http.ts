/**
 * HTTP plumbing shared by the storage providers (plan 3.5): one fetch
 * signature the tests can replace, bounded retries for transient failures,
 * and the mapping of status codes onto the sync's error classes.
 *
 * `fetch` is read at call time, so the privacy ledger's wrapped
 * `window.fetch` sees every request, and a test can hand in a fake server.
 */

import { PreconditionFailedError, ProviderUnavailableError, type PutCondition, type SyncProvider } from "../provider";

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


/** The object the probes write and delete: a fixed, content-free name. */
export const PROBE_NAME = "lumen-e2ee-cas-probe";

/**
 * Prove a provider's conditional writes when it is connected, through its
 * own `put` (re-review 12.11, RR-7): a create-only write succeeds on a new
 * object and is refused on an existing one; a write with the current etag
 * succeeds and one with the stale etag is refused, leaving the object as it
 * was, and the etag read back is the one the write returned. A provider
 * that fails is refused (`ProviderUnsupportedError`): without these, two
 * devices saving at once can lose a change. The engine runs the same check
 * again before any key or device change.
 */
export async function checkConditionalWrites(p: SyncProvider): Promise<void> {
  const ignored = await conditionalWriteGap(p);
  if (ignored) throw new ProviderUnsupportedError(p.id, `${ignored}, so it cannot do safe conditional writes`);
}

/** Which condition `p` ignores, or null when both hold. */
async function conditionalWriteGap(p: SyncProvider): Promise<string | null> {
  const refused = async (byte: number, cond: PutCondition): Promise<boolean> => {
    try {
      await p.put(PROBE_NAME, new Uint8Array([byte]), cond);
      return false;
    } catch (e) {
      if (e instanceof PreconditionFailedError) return true;
      throw e;
    }
  };
  await p.delete(PROBE_NAME);
  try {
    const a = await p.put(PROBE_NAME, new Uint8Array([1]), { ifNoneMatch: "*" });
    if (!(await refused(2, { ifNoneMatch: "*" }))) return "it accepted If-None-Match: * on an existing object";
    let b: { etag: string };
    try {
      b = await p.put(PROBE_NAME, new Uint8Array([3]), { ifMatch: a.etag });
    } catch (e) {
      if (e instanceof PreconditionFailedError) return "it refused If-Match with the current ETag";
      throw e;
    }
    if (!(await refused(4, { ifMatch: a.etag }))) return "it accepted If-Match with a stale ETag";
    const now = await p.get(PROBE_NAME);
    if (!now || now.data[0] !== 3 || now.etag !== b.etag) return "the ETag read back is not the one the write returned";
    return null;
  } finally {
    await p.delete(PROBE_NAME).catch(() => undefined);
  }
}

/** XML without a dependency: the browser's (and jsdom's) DOMParser. */
export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

/** Every element with local name `local`, whatever its namespace prefix. */
export function elements(root: ParentNode, local: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((el) => el.localName === local);
}
