/**
 * S3-compatible object storage as a `SyncProvider` (plan 3.5): AWS S3,
 * Cloudflare R2, Backblaze B2, MinIO, Garage, Hetzner Object Storage…
 *
 * Objects live under `<prefix><name>` in one bucket; requests are signed
 * with SigV4 (./sigv4.ts, no dependency) instead of the AWS SDK. Conditional
 * writes are S3's `If-Match` (replace exactly the ETag that was read) and
 * `If-None-Match: *` (create only) — a 412, or S3's 409
 * `ConditionalRequestConflict` while another writer holds the key, is a
 * lost race. Listing is `ListObjectsV2` with the prefix.
 */

import { signRequest } from "./sigv4";
import { PreconditionFailedError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { checkObjectName, defaultFetch, elements, failed, parseXml, ProviderUnsupportedError, request, type FetchLike } from "./http";

export interface S3Config {
  /** `https://s3.eu-central-1.amazonaws.com`, `https://<account>.r2.cloudflarestorage.com`, `http://localhost:9000`… */
  endpoint: string;
  region: string;
  bucket: string;
  /** Key prefix, e.g. `lumen/`; empty for the bucket root. */
  prefix?: string;
  accessKeyId: string;
  /** Kept in the secret store, never in this object when persisted. */
  secretAccessKey: string;
  sessionToken?: string;
  /** `endpoint/bucket/key` instead of `bucket.endpoint/key` (MinIO, most self-hosted). Default: path style. */
  pathStyle?: boolean;
}

export interface S3Provider extends SyncProvider {
  /** A signed write + conditional rewrite, to check the credentials and that the service enforces preconditions. */
  probe(): Promise<void>;
}

export function s3Provider(cfg: S3Config, deps: { fetch?: FetchLike } = {}): S3Provider {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const creds = { accessKeyId: cfg.accessKeyId, secretAccessKey: cfg.secretAccessKey, sessionToken: cfg.sessionToken };
  const region = cfg.region || "us-east-1";
  const prefix = cfg.prefix ? (cfg.prefix.endsWith("/") ? cfg.prefix : cfg.prefix + "/") : "";
  const endpoint = new URL(cfg.endpoint);
  const pathStyle = cfg.pathStyle ?? true;
  const bucketBase = pathStyle
    ? `${endpoint.origin}${endpoint.pathname.replace(/\/+$/, "")}/${cfg.bucket}`
    : `${endpoint.protocol}//${cfg.bucket}.${endpoint.host}${endpoint.pathname.replace(/\/+$/, "")}`;
  const keyUrl = (name: string) => {
    checkObjectName(name);
    return `${bucketBase}/${encodeURIComponent(prefix + name).replace(/%2F/g, "/")}`;
  };

  async function signed(url: string, init: { method: string; headers?: Record<string, string>; body?: Uint8Array }): Promise<Response> {
    const headers = await signRequest(creds, { method: init.method, url, headers: init.headers, body: init.body, region });
    return request(fetchImpl, url, { method: init.method, headers, body: init.body as BodyInit | undefined }, { provider: "s3" });
  }

  return {
    id: "s3",

    async probe() {
      const name = ".lumen-probe";
      const a = await signed(keyUrl(name), { method: "PUT", body: new Uint8Array([1]), headers: { "Content-Type": "application/octet-stream" } });
      if (!a.ok) throw await failed(a, "s3", name);
      const etag = a.headers.get("ETag");
      if (!etag) throw new ProviderUnsupportedError("s3", "the service returns no ETag on PUT");
      // A stale precondition must be refused, or two devices could overwrite each other.
      const stale = await signed(keyUrl(name), { method: "PUT", body: new Uint8Array([2]), headers: { "Content-Type": "application/octet-stream", "If-Match": '"not-the-etag"' } });
      await signed(keyUrl(name), { method: "DELETE" }).catch(() => undefined);
      if (stale.status !== 412 && stale.status !== 409) {
        throw new ProviderUnsupportedError("s3", "the service ignores If-Match, so it cannot do conditional writes");
      }
    },

    async get(name): Promise<StoredObject | null> {
      const res = await signed(keyUrl(name), { method: "GET" });
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res, "s3", name);
      const etag = res.headers.get("ETag");
      if (!etag) throw new ProviderUnsupportedError("s3", "the service returns no ETag");
      return { data: new Uint8Array(await res.arrayBuffer()), etag };
    },

    async put(name, data, cond?: PutCondition) {
      const headers: Record<string, string> = { "Content-Type": "application/octet-stream" };
      if (cond && "ifMatch" in cond) headers["If-Match"] = cond.ifMatch;
      if (cond && "ifNoneMatch" in cond) headers["If-None-Match"] = "*";
      const res = await signed(keyUrl(name), { method: "PUT", headers, body: data });
      if (res.status === 412 || res.status === 409) throw new PreconditionFailedError(name);
      if (!res.ok) throw await failed(res, "s3", name);
      const etag = res.headers.get("ETag");
      if (!etag) throw new ProviderUnsupportedError("s3", "the service returns no ETag on PUT");
      return { etag };
    },

    async delete(name) {
      const res = await signed(keyUrl(name), { method: "DELETE" });
      if (res.ok || res.status === 404) return;
      throw await failed(res, "s3", name);
    },

    async list() {
      const out: string[] = [];
      let token: string | undefined;
      do {
        const q = new URLSearchParams({ "list-type": "2", prefix });
        if (token) q.set("continuation-token", token);
        const res = await signed(`${bucketBase}/?${q.toString()}`, { method: "GET" });
        if (!res.ok) throw await failed(res, "s3", "");
        const doc = parseXml(await res.text());
        for (const key of elements(doc, "Key")) {
          const k = key.textContent ?? "";
          if (!k.startsWith(prefix)) continue;
          const name = k.slice(prefix.length);
          if (name && !name.includes("/")) out.push(name);
        }
        const truncated = elements(doc, "IsTruncated")[0]?.textContent === "true";
        token = truncated ? (elements(doc, "NextContinuationToken")[0]?.textContent ?? undefined) : undefined;
      } while (token);
      return out;
    },
  };
}
