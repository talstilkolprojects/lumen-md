/**
 * The AT Protocol calls for publishing (plan W7.19), straight from the app
 * to the person's own PDS: no server of ours in between. Sign-in is with an
 * App Password (Bluesky: Settings → Privacy and security → App passwords);
 * it and the session's refresh token live only in the secret store (2.5)
 * and are never logged.
 *
 * Every call goes to one of: the handle's own domain (`/.well-known/atproto-did`),
 * plc.directory (the DID document), or the PDS that document names. All are
 * in the privacy ledger (src/ai/privacyLedger.ts, "AT Protocol publishing").
 */
import { getSecret, initSecretStore, setSecret } from "../../lib/secretStore";
import { atUri, parseAtUri } from "./standard";

export const PASSWORD_SECRET = "lumen.atproto.appPassword";
export const SESSION_SECRET = "lumen.atproto.refreshJwt";

export interface Identity {
  did: string;
  pds: string;
}

export interface Session extends Identity {
  handle: string;
  accessJwt: string;
}

export class AtprotoError extends Error {
  constructor(
    message: string,
    readonly status = 0,
    readonly code = "",
  ) {
    super(message);
    this.name = "AtprotoError";
  }
}

type Fetch = typeof fetch;

async function json(res: Response): Promise<Record<string, unknown>> {
  const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  if (!res.ok) throw new AtprotoError(String(body.message ?? res.statusText), res.status, String(body.error ?? ""));
  return body;
}

/** handle → DID: the handle's domain first, then the PDS-independent resolver at bsky.social. */
export async function resolveHandle(handle: string, f: Fetch = fetch): Promise<string> {
  const h = handle.trim().replace(/^@/, "").toLowerCase();
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/.test(h)) throw new AtprotoError("not a handle");
  try {
    // privacy-ledger: AT Protocol publishing (the handle's own domain)
    const res = await f(`https://${h}/.well-known/atproto-did`, { headers: { accept: "text/plain" } });
    const did = res.ok ? (await res.text()).trim() : "";
    if (/^did:(plc|web):/.test(did)) return did;
  } catch {
    // why: most handles' domains send no CORS header; the resolver below answers for them
  }
  const r = await json(await f(`https://bsky.social/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(h)}`));
  if (typeof r.did !== "string") throw new AtprotoError("handle not found");
  return r.did;
}

/** DID → the PDS that holds its repository. */
export async function resolvePds(did: string, f: Fetch = fetch): Promise<string> {
  let doc: Record<string, unknown>;
  if (did.startsWith("did:plc:")) doc = await json(await f(`https://plc.directory/${encodeURIComponent(did)}`));
  else if (did.startsWith("did:web:")) {
    const host = did.slice("did:web:".length).replace(/%3A/gi, ":");
    // privacy-ledger: AT Protocol publishing (a did:web document on the person's own domain)
    doc = await json(await f(`https://${host}/.well-known/did.json`));
  } else throw new AtprotoError("unsupported DID");
  const services = Array.isArray(doc.service) ? (doc.service as Array<Record<string, unknown>>) : [];
  const pds = services.find((s) => s.id === "#atproto_pds" || String(s.id).endsWith("#atproto_pds"));
  const url = typeof pds?.serviceEndpoint === "string" ? pds.serviceEndpoint.replace(/\/+$/, "") : "";
  if (!/^https:\/\//.test(url)) throw new AtprotoError("no PDS in the DID document");
  return url;
}

export async function resolveIdentity(handle: string, f: Fetch = fetch): Promise<Identity> {
  const did = await resolveHandle(handle, f);
  return { did, pds: await resolvePds(did, f) };
}

function xrpc(pds: string, method: string): string {
  return `${pds}/xrpc/${method}`;
}

/**
 * Sign in: the stored refresh token when it still works, else the App
 * Password. The refresh token is kept (secret store) so the password is
 * needed again only when the session ends.
 */
export async function signIn(handle: string, password: string | null, f: Fetch = fetch): Promise<Session> {
  await initSecretStore();
  const id = await resolveIdentity(handle, f);
  const refresh = getSecret(SESSION_SECRET);
  if (refresh) {
    try {
      // privacy-ledger: AT Protocol publishing (the person's own PDS)
      const r = await json(await f(xrpc(id.pds, "com.atproto.server.refreshSession"), { method: "POST", headers: { authorization: `Bearer ${refresh}` } }));
      if (r.did === id.did && typeof r.accessJwt === "string") {
        await setSecret(SESSION_SECRET, String(r.refreshJwt ?? refresh));
        return { ...id, handle: String(r.handle ?? handle), accessJwt: r.accessJwt };
      }
    } catch {
      // why: an expired or revoked session; the App Password signs in again below
    }
  }
  const pw = password ?? getSecret(PASSWORD_SECRET);
  if (!pw) throw new AtprotoError("an App Password is needed", 401, "AuthRequired");
  // privacy-ledger: AT Protocol publishing (the person's own PDS)
  const r = await json(await f(xrpc(id.pds, "com.atproto.server.createSession"), { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ identifier: id.did, password: pw }) }));
  if (typeof r.accessJwt !== "string") throw new AtprotoError("no session");
  if (password) await setSecret(PASSWORD_SECRET, password);
  if (typeof r.refreshJwt === "string") await setSecret(SESSION_SECRET, r.refreshJwt);
  return { ...id, handle: String(r.handle ?? handle), accessJwt: r.accessJwt };
}

/** Forget the password and the session on this device. */
export async function signOut(): Promise<void> {
  await initSecretStore();
  await setSecret(PASSWORD_SECRET, null);
  await setSecret(SESSION_SECRET, null);
}

/** Create or replace one record; returns its at:// URI. */
export async function putRecord(s: Session, collection: string, rkey: string, record: Record<string, unknown>, f: Fetch = fetch): Promise<string> {
  // privacy-ledger: AT Protocol publishing (the person's own PDS)
  const r = await json(await f(xrpc(s.pds, "com.atproto.repo.putRecord"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.accessJwt}` }, body: JSON.stringify({ repo: s.did, collection, rkey, record, validate: false }) }));
  return typeof r.uri === "string" ? r.uri : atUri(s.did, collection, rkey);
}

export async function deleteRecord(s: Session, uri: string, f: Fetch = fetch): Promise<void> {
  const p = parseAtUri(uri);
  if (!p || p.did !== s.did) throw new AtprotoError("the record is not in this account");
  // privacy-ledger: AT Protocol publishing (the person's own PDS)
  await json(await f(xrpc(s.pds, "com.atproto.repo.deleteRecord"), { method: "POST", headers: { "content-type": "application/json", authorization: `Bearer ${s.accessJwt}` }, body: JSON.stringify({ repo: s.did, collection: p.collection, rkey: p.rkey }) }));
}
