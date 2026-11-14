/**
 * The encrypted relay as a `SyncProvider` (plan W4.19): for phones and
 * browsers with no desktop sync folder, and no WebDAV. The relay is the same
 * host as the live-share server (#469); it stores opaque, already encrypted
 * objects and nothing else (sync-server/vault-relay.js).
 *
 * No account: a vault's space on the relay is named by a bearer token that is
 * derived from the vault's recovery words (setup/recoveryWords.ts), so a
 * second device needs nothing but the words. The relay keeps only the
 * token's SHA-256, never the token, and never a key.
 *
 *   GET    /v1/vault/o/            → {"names": [...]}
 *   GET    /v1/vault/o/<name>      → bytes, ETag            (404: none)
 *   PUT    /v1/vault/o/<name>      If-Match / If-None-Match: *   (412: lost race)
 *   DELETE /v1/vault/o/<name>
 *
 * A public relay may ask for more before it opens a new space (review 12.11,
 * sync-server/vault-relay.js): an invite (`X-Lumen-Invite`, from the build's
 * VITE_SYNC_RELAY_INVITE) or a proof of work (428 {"error":"pow","bits":n}),
 * which this provider solves once and sends with its first write.
 */

import { PreconditionFailedError, type PutCondition, type StoredObject, type SyncProvider } from "../provider";
import { checkObjectName, defaultFetch, failed, request, type FetchLike } from "./http";

export interface RelayConfig {
  /** The relay's https origin, e.g. `https://relay.example.com`. */
  url: string;
  /** The space token (secret store; derived from the recovery words). */
  token: string;
  /** The relay's invite secret, when its operator requires one to open a space. */
  invite?: string;
}

/** The most work this app will do for a relay (2^24 hashes: seconds on a phone). */
export const MAX_POW_BITS = 24;

const hex = (b: ArrayBuffer) => [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");
const sha256 = (text: string) => crypto.subtle.digest("SHA-256", new TextEncoder().encode(text));

/** The relay's name for this token's space (the same as the server computes). */
export async function relaySpaceId(token: string): Promise<string> {
  return hex(await sha256(`lumen-vault-relay v1|${token}`));
}

function zeroBits(d: Uint8Array): number {
  let n = 0;
  for (const b of d) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}

/** A nonce whose SHA-256("lumen-vault-relay pow v1|<space>|<nonce>") starts with `bits` zero bits. */
export async function solveRelayPow(space: string, bits: number): Promise<string> {
  if (!Number.isInteger(bits) || bits < 1 || bits > MAX_POW_BITS) throw new Error(`relay: proof of work of ${bits} bits refused (at most ${MAX_POW_BITS})`);
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (zeroBits(new Uint8Array(await sha256(`lumen-vault-relay pow v1|${space}|${nonce}`))) >= bits) return nonce;
  }
}

export interface RelayProvider extends SyncProvider {
  /** Is the relay there and does it take this token? */
  probe(): Promise<void>;
}

/** The relay origin for a live-share server URL (`wss://host/…` → `https://host`). */
export function relayOrigin(collabUrl: string | undefined | null): string | null {
  if (!collabUrl) return null;
  try {
    const u = new URL(collabUrl);
    if (u.protocol === "wss:" || u.protocol === "https:") return `https://${u.host}`;
    // Plain ws/http only for a server on this machine (development).
    if ((u.protocol === "ws:" || u.protocol === "http:") && /^(localhost|127\.0\.0\.1|\[::1\])$/.test(u.hostname)) return `http://${u.host}`;
    return null;
  } catch {
    return null;
  }
}

export function relayProvider(cfg: RelayConfig, deps: { fetch?: FetchLike } = {}): RelayProvider {
  const fetchImpl = deps.fetch ?? defaultFetch;
  const base = `${cfg.url.replace(/\/+$/, "")}/v1/vault/o/`;
  const headers = (extra: Record<string, string> = {}): Record<string, string> => ({ Authorization: `Bearer ${cfg.token}`, ...(cfg.invite ? { "X-Lumen-Invite": cfg.invite } : {}), ...extra });
  /** The proof of work for opening this space, solved once (concurrent first writes share it). */
  let pow: Promise<string> | null = null;
  const powFor = (bits: number) => (pow ??= relaySpaceId(cfg.token).then((space) => solveRelayPow(space, bits)));
  const url = (name: string) => {
    checkObjectName(name);
    return base + encodeURIComponent(name);
  };
  const go = (input: string, init: RequestInit) => request(fetchImpl, input, init, { provider: "relay" });

  return {
    id: "relay",

    async probe() {
      const res = await go(base, { method: "GET", headers: headers() });
      if (!res.ok) throw await failed(res, "relay", "");
    },

    async get(name): Promise<StoredObject | null> {
      const res = await go(url(name), { method: "GET", headers: headers() });
      if (res.status === 404) return null;
      if (!res.ok) throw await failed(res, "relay", name);
      const etag = res.headers.get("ETag");
      if (!etag) throw await failed(res, "relay", name);
      return { data: new Uint8Array(await res.arrayBuffer()), etag };
    },

    async put(name, data, cond?: PutCondition) {
      const pre: Record<string, string> = {};
      if (cond && "ifMatch" in cond) pre["If-Match"] = cond.ifMatch;
      if (cond && "ifNoneMatch" in cond) pre["If-None-Match"] = "*";
      let res = await go(url(name), { method: "PUT", headers: headers({ "Content-Type": "application/octet-stream", ...pre }), body: data as BodyInit });
      if (res.status === 428) {
        // The relay wants a proof of work before it opens this space.
        const ask = (await res.json().catch(() => null)) as { error?: unknown; bits?: unknown } | null;
        if (ask?.error !== "pow" || typeof ask.bits !== "number") throw await failed(res, "relay", name);
        const nonce = await powFor(ask.bits);
        res = await go(url(name), { method: "PUT", headers: headers({ "Content-Type": "application/octet-stream", "X-Lumen-Pow": nonce, ...pre }), body: data as BodyInit });
      }
      if (res.status === 412) throw new PreconditionFailedError(name);
      if (!res.ok) throw await failed(res, "relay", name);
      return { etag: res.headers.get("ETag") ?? "" };
    },

    async delete(name) {
      const res = await go(url(name), { method: "DELETE", headers: headers() });
      if (res.ok || res.status === 404) return;
      throw await failed(res, "relay", name);
    },

    async list() {
      const res = await go(base, { method: "GET", headers: headers() });
      if (res.status === 404) return [];
      if (!res.ok) throw await failed(res, "relay", "");
      const body = (await res.json()) as { names?: unknown };
      return Array.isArray(body.names) ? body.names.filter((n): n is string => typeof n === "string") : [];
    },
  };
}
