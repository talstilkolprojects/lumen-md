/**
 * HTTP plumbing shared by the storage providers (plan 3.5): one fetch
 * signature the tests can replace, bounded retries for transient failures,
 * and the mapping of status codes onto the sync's error classes.
 *
 * `fetch` is read at call time, so the privacy ledger's wrapped
 * `window.fetch` sees every request, and a test can hand in a fake server.
 */

import { randomBytes, toB64u } from "../bytes";
import { PreconditionFailedError, PROBE_RACE_ROUNDS, PROBE_RACE_WRITERS, PROBE_REPLACEMENTS, ProviderUnavailableError, type PutCondition, type SyncProvider } from "../provider";

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


/**
 * An object for a probe (third review 12.11, N2): a random 43-character
 * name and random bytes the size of the smallest sealed blob, so a probe
 * looks like any blob upload and a provider can't single it out by its name.
 */
export function probeObject(): { name: string; data: () => Uint8Array } {
  const name = toB64u(randomBytes(32));
  return {
    name,
    data: () => {
      const d = randomBytes(1 + 12 + 256 + 16);
      d[0] = 1;
      return d;
    },
  };
}

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
  const probe = probeObject();
  const race = probeObject();
  const name = probe.name;
  const refused = async (cond: PutCondition): Promise<boolean> => {
    try {
      await p.put(name, probe.data(), cond);
      return false;
    } catch (e) {
      if (e instanceof PreconditionFailedError) return true;
      throw e;
    }
  };
  const races: string[] = [];
  try {
    let cur = await p.put(name, probe.data(), { ifNoneMatch: "*" });
    if (!(await refused({ ifNoneMatch: "*" }))) return "it accepted If-None-Match: * on an existing object";
    // Several replacements in a row (W6.27): an ETag that is the file's mtime
    // in seconds passes one replacement that straddles a second, not three.
    for (let i = 0; i < PROBE_REPLACEMENTS; i++) {
      let b: { etag: string };
      const next = probe.data();
      try {
        b = await p.put(name, next, { ifMatch: cur.etag });
      } catch (e) {
        if (e instanceof PreconditionFailedError) return "it refused If-Match with the current ETag";
        throw e;
      }
      if (b.etag === cur.etag) return "a write kept the same ETag";
      if (!(await refused({ ifMatch: cur.etag }))) return "it accepted If-Match with a stale ETag";
      const now = await p.get(name);
      if (!now || !sameBytes(now.data, next) || now.etag !== b.etag) return "the ETag read back is not the one the write returned";
      cur = b;
    }
    // Creates at once: exactly one may win. A provider that says its
    // create-only isn't atomic (Drive) is sync-only anyway (N7).
    if (p.atomicCreate !== false) {
      for (let round = 0; round < PROBE_RACE_ROUNDS; round++) {
        const r = round === 0 ? race : probeObject();
        races.push(r.name);
        const wins = await Promise.all(Array.from({ length: PROBE_RACE_WRITERS }, () => r.data()).map((d) => p.put(r.name, d, { ifNoneMatch: "*" }).then(() => 1, (e) => (e instanceof PreconditionFailedError ? 0 : Promise.reject(e)))));
        if (wins.reduce((x, y) => x + y, 0) !== 1) return "create-only writes racing on one name both succeeded";
      }
    }
    return null;
  } finally {
    await p.delete(name).catch(() => undefined);
    for (const r of races.length ? races : [race.name]) await p.delete(r).catch(() => undefined);
  }
}

function sameBytes(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

/** XML without a dependency: the browser's (and jsdom's) DOMParser. */
export function parseXml(text: string): Document {
  return new DOMParser().parseFromString(text, "application/xml");
}

/** Every element with local name `local`, whatever its namespace prefix. */
export function elements(root: ParentNode, local: string): Element[] {
  return Array.from(root.querySelectorAll("*")).filter((el) => el.localName === local);
}
