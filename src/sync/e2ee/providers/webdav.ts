/**
 * WebDAV as a `SyncProvider` (plan 3.5): Nextcloud, ownCloud, Apache / nginx
 * DAV, Synology, Hetzner Storage Box… — any server with ETags.
 *
 * The vault is one collection (folder); every object is a file in it under
 * its opaque name. Conditional writes are the standard HTTP preconditions:
 * `If-Match: <etag>` to replace exactly the version that was read, and
 * `If-None-Match: *` to create only when nothing is there — a 412 is a lost
 * race. Listing is `PROPFIND` with `Depth: 1`.
 *
 * Some servers answer a write that races another one with 423 Locked
 * (Go's x/net/webdav, Nextcloud's file locking, Apache mod_dav) or 409
 * Conflict instead of 412 (plan W8.3). Those are retried a bounded number
 * of times (the other writer is usually done within a second); when they
 * persist, a conditional write is a lost race (`PreconditionFailedError`,
 * so the engine re-reads and merges, as for a 412), and an unconditional one
 * is `ProviderUnavailableError` (retry the round later). A 409 while the
 * folder itself is missing is RFC 4918's "parent collection missing": a real
 * error, never a race.
 *
 * Written over fetch, not the `webdav` package: that package captures the
 * global fetch when it loads (and resolves to node-fetch under vitest), so
 * the privacy ledger and the mock servers could not see its requests; the
 * four verbs here are small.
 */

import { PreconditionFailedError, ProviderUnavailableError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { basicAuth, checkConditionalWrites, checkObjectName, defaultFetch, elements, failed, parseXml, probeObject, ProviderUnsupportedError, request, type FetchLike } from "./http";

export interface WebdavConfig {
  /** The folder's URL, e.g. `https://cloud.example.com/remote.php/dav/files/me/Lumen/`. */
  url: string;
  username?: string;
  /** Kept in the secret store, never in this object when persisted. */
  password?: string;
}

/** How a write that meets 423 Locked or 409 Conflict is retried (plan W8.3). */
export interface WebdavLockRetry {
  /** Further attempts after the first (default 3). */
  retries: number;
  /** First wait in ms, doubled each time, plus up to the same again at random (default 200). */
  baseDelayMs: number;
}

export const DEFAULT_LOCK_RETRY: WebdavLockRetry = { retries: 3, baseDelayMs: 200 };

/** A status that means another writer has (or had) the file: 423 Locked, 409 Conflict. */
export function isRaceStatus(status: number): boolean {
  return status === 423 || status === 409;
}

export interface WebdavProvider extends SyncProvider {
  /**
   * Create the folder when missing, check the server returns ETags
   * (`ProviderUnsupportedError` when it does not), and that it refuses a
   * stale If-Match and a second If-None-Match: * (RR-7): servers that don't
   * evaluate preconditions on PUT accept every write, and are refused too.
   */
  probe(): Promise<void>;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>';

/** Strip the weak marker: a weak ETag still identifies the version for a PUT precondition on these servers. */
function normEtag(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^W\//, "");
}

export function webdavProvider(cfg: WebdavConfig, deps: { fetch?: FetchLike; lockRetry?: WebdavLockRetry; sleep?: (ms: number) => Promise<void> } = {}): WebdavProvider {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const lockRetry = deps.lockRetry ?? DEFAULT_LOCK_RETRY;
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));
  const backoff = (attempt: number) => {
    const d = lockRetry.baseDelayMs * 2 ** attempt;
    return d + Math.floor(Math.random() * (d + 1));
  };
  const base = cfg.url.endsWith("/") ? cfg.url : cfg.url + "/";
  const auth = cfg.username ? basicAuth(cfg.username, cfg.password ?? "") : null;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({
    ...(auth ? { Authorization: auth } : {}),
    ...extra,
  });
  const url = (name: string) => {
    checkObjectName(name);
    return base + encodeURIComponent(name);
  };
  const go = (input: string, init: RequestInit) => request(fetchImpl, input, init, { provider: "webdav" });

  async function etagOf(name: string): Promise<string | null> {
    // A PUT answer without an ETag: ask the server for it.
    const res = await go(url(name), { method: "PROPFIND", headers: headers({ Depth: "0", "Content-Type": "application/xml" }), body: PROPFIND_BODY });
    if (!res.ok && res.status !== 207) return null;
    const doc = parseXml(await res.text());
    const tag = elements(doc, "getetag")[0]?.textContent?.trim() ?? null;
    return normEtag(tag || null);
  }

  /** Does the vault's folder exist? A 409 without it is "parent missing", not a race. */
  async function collectionExists(): Promise<boolean> {
    const res = await go(base, { method: "PROPFIND", headers: headers({ Depth: "0", "Content-Type": "application/xml" }), body: PROPFIND_BODY });
    return res.ok || res.status === 207;
  }

  /**
   * Send a write; while the answer is 423 or 409 (and the folder exists),
   * wait and send it again, at most `lockRetry.retries` more times.
   * → the last answer, and whether it is still a race status.
   */
  async function withLockRetry(send: () => Promise<Response>): Promise<{ res: Response; raced: boolean }> {
    for (let attempt = 0; ; attempt++) {
      const res = await send();
      if (!isRaceStatus(res.status)) return { res, raced: false };
      if (res.status === 409 && !(await collectionExists())) return { res, raced: false };
      if (attempt >= lockRetry.retries) return { res, raced: true };
      await res.body?.cancel().catch(() => undefined);
      await sleep(backoff(attempt));
    }
  }

  const provider: WebdavProvider = {
    id: "webdav",

    async probe() {
      // MKCOL: 201 created, 405 already there, 409 parent missing.
      const mk = await go(base, { method: "MKCOL", headers: headers() });
      if (!mk.ok && mk.status !== 405) throw await failed(mk, "webdav", "");
      const probe = probeObject(); // a random, blob-like name and size (third review N2)
      const put = await go(url(probe.name), { method: "PUT", headers: headers({ "Content-Type": "application/octet-stream" }), body: probe.data() as BodyInit });
      if (!put.ok) throw await failed(put, "webdav", probe.name);
      const etag = normEtag(put.headers.get("ETag")) ?? (await etagOf(probe.name));
      await go(url(probe.name), { method: "DELETE", headers: headers() }).catch(() => undefined);
      if (!etag) throw new ProviderUnsupportedError("webdav", "the server returns no ETags, so it cannot do conditional writes");
      await checkConditionalWrites(provider);
    },

    async get(name): Promise<StoredObject | null> {
      const res = await go(url(name), { method: "GET", headers: headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res, "webdav", name);
      const data = new Uint8Array(await res.arrayBuffer());
      const etag = normEtag(res.headers.get("ETag")) ?? (await etagOf(name));
      if (!etag) throw new ProviderUnsupportedError("webdav", "the server returns no ETags, so it cannot do conditional writes");
      return { data, etag };
    },

    async put(name, data, cond?: PutCondition) {
      const pre: Record<string, string> = {};
      if (cond && "ifMatch" in cond) pre["If-Match"] = cond.ifMatch;
      if (cond && "ifNoneMatch" in cond) pre["If-None-Match"] = "*";
      const { res, raced } = await withLockRetry(() =>
        go(url(name), {
          method: "PUT",
          headers: headers({ "Content-Type": "application/octet-stream", ...pre }),
          body: data as BodyInit,
        }),
      );
      if (res.status === 412) throw new PreconditionFailedError(name);
      if (raced) {
        // Still locked or conflicting after the retries: someone else is writing this object.
        if (cond) throw new PreconditionFailedError(name);
        throw new ProviderUnavailableError(`webdav: ${name} stayed ${res.status === 423 ? "locked (423)" : "in conflict (409)"} after ${lockRetry.retries + 1} attempts`);
      }
      if (!res.ok) throw await failed(res, "webdav", name);
      const etag = normEtag(res.headers.get("ETag")) ?? (await etagOf(name));
      if (!etag) throw new ProviderUnsupportedError("webdav", "the server returns no ETags, so it cannot do conditional writes");
      return { etag };
    },

    async delete(name) {
      const { res, raced } = await withLockRetry(() => go(url(name), { method: "DELETE", headers: headers() }));
      if (res.status === 404 || res.ok) return;
      if (raced) throw new ProviderUnavailableError(`webdav: ${name} stayed ${res.status === 423 ? "locked (423)" : "in conflict (409)"} after ${lockRetry.retries + 1} attempts`);
      throw await failed(res, "webdav", name);
    },

    async list() {
      const res = await go(base, { method: "PROPFIND", headers: headers({ Depth: "1", "Content-Type": "application/xml" }), body: PROPFIND_BODY });
      if (res.status === 404) return [];
      if (!res.ok && res.status !== 207) throw await failed(res, "webdav", "");
      const doc = parseXml(await res.text());
      const basePath = new URL(base).pathname.replace(/\/+$/, "");
      const out: string[] = [];
      for (const r of elements(doc, "response")) {
        const href = elements(r, "href")[0]?.textContent?.trim();
        if (!href) continue;
        if (elements(r, "collection").length) continue;
        let path: string;
        try {
          path = decodeURIComponent(new URL(href, base).pathname);
        } catch {
          continue;
        }
        if (!path.startsWith(basePath + "/")) continue;
        const name = path.slice(basePath.length + 1);
        if (name && !name.includes("/")) out.push(name);
      }
      return out;
    },
  };
  return provider;
}
