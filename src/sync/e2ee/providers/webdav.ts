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
 * Written over fetch, not the `webdav` package: that package captures the
 * global fetch when it loads (and resolves to node-fetch under vitest), so
 * the privacy ledger and the mock servers could not see its requests; the
 * four verbs here are small.
 */

import { PreconditionFailedError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { basicAuth, checkObjectName, defaultFetch, elements, failed, parseXml, ProviderUnsupportedError, request, type FetchLike } from "./http";

export interface WebdavConfig {
  /** The folder's URL, e.g. `https://cloud.example.com/remote.php/dav/files/me/Lumen/`. */
  url: string;
  username?: string;
  /** Kept in the secret store, never in this object when persisted. */
  password?: string;
}

export interface WebdavProvider extends SyncProvider {
  /** Create the folder when missing and check the server returns ETags; `ProviderUnsupportedError` when it does not. */
  probe(): Promise<void>;
}

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:"><d:prop><d:getetag/><d:resourcetype/></d:prop></d:propfind>';

/** Strip the weak marker: a weak ETag still identifies the version for a PUT precondition on these servers. */
function normEtag(raw: string | null): string | null {
  if (!raw) return null;
  return raw.replace(/^W\//, "");
}

export function webdavProvider(cfg: WebdavConfig, deps: { fetch?: FetchLike } = {}): WebdavProvider {
  const fetchImpl = deps.fetch ?? defaultFetch;
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

  return {
    id: "webdav",

    async probe() {
      // MKCOL: 201 created, 405 already there, 409 parent missing.
      const mk = await go(base, { method: "MKCOL", headers: headers() });
      if (!mk.ok && mk.status !== 405) throw await failed(mk, "webdav", "");
      const probeName = ".lumen-probe";
      const put = await go(url(probeName), { method: "PUT", headers: headers({ "Content-Type": "application/octet-stream" }), body: new Uint8Array([1]) });
      if (!put.ok) throw await failed(put, "webdav", probeName);
      const etag = normEtag(put.headers.get("ETag")) ?? (await etagOf(probeName));
      await go(url(probeName), { method: "DELETE", headers: headers() }).catch(() => undefined);
      if (!etag) throw new ProviderUnsupportedError("webdav", "the server returns no ETags, so it cannot do conditional writes");
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
      const res = await go(url(name), {
        method: "PUT",
        headers: headers({ "Content-Type": "application/octet-stream", ...pre }),
        body: data as BodyInit,
      });
      if (res.status === 412) throw new PreconditionFailedError(name);
      if (!res.ok) throw await failed(res, "webdav", name);
      const etag = normEtag(res.headers.get("ETag")) ?? (await etagOf(name));
      if (!etag) throw new ProviderUnsupportedError("webdav", "the server returns no ETags, so it cannot do conditional writes");
      return { etag };
    },

    async delete(name) {
      const res = await go(url(name), { method: "DELETE", headers: headers() });
      if (res.status === 404 || res.ok) return;
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
}
