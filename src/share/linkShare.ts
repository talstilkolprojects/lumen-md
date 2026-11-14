/**
 * Encrypted share link without a server (plan W5.10).
 *
 * A read-only copy of one note travels inside the link itself:
 *
 *   https://lumen-md.vercel.app/#view=<data>&key=<key>
 *
 *   data = base64url( 0x01 ‖ iv (12 bytes) ‖ AES-GCM-256( deflate-raw( JSON ) ) )
 *   key  = base64url( the 256-bit AES key )        (43 characters)
 *   JSON = { "v": 1, "t": title, "m": markdown, "c": created ms, "e"?: expires ms }
 *
 * Both parts sit in the #fragment, which a browser never sends to a server
 * (not in the request line, not in the Referer header): the host serving
 * the app — or any host — receives no byte of the note or of its key. That
 * is also why the data is not in the path or the query: those reach the
 * server (and its logs), and the request line is limited (about 14 KB on
 * Vercel), while the fragment is not.
 *
 * - The key is random per link; whoever has the whole link can read the
 *   note, nobody else. The link can also be given without its key (`#view=
 *   <data>`), and the key sent another way; the viewer asks for it.
 * - AES-GCM authenticates: a changed byte, a wrong key or a truncated link
 *   fails to open, never shows altered text.
 * - The expiry is inside the encrypted payload: the viewer refuses an
 *   expired note. It is a promise of the viewer, not of cryptography —
 *   the link still holds the note, so anyone who kept it and decodes it by
 *   hand can read it. The share dialog says so.
 * - Size: the data part is capped at MAX_LINK_DATA characters, so the link
 *   stays usable in browsers and messengers. A larger note is offered as an
 *   encrypted file instead (`.lumenshare`, the same bytes), opened through
 *   `#view-file&key=<key>`. Opening inflates at most MAX_INFLATE_RATIO times
 *   the compressed size (and at least MAX_LINK_DATA × that), then stops: a
 *   crafted link or file can't make the viewer inflate gigabytes (review
 *   12.11). sealNote refuses a note that would not open under that bound.
 * - Origin: a link made in the desktop or mobile app, or on localhost, would
 *   open for nobody else, so links name the public app (shareOrigin) unless
 *   this page is itself served over https from a public host.
 *
 * WebCrypto (crypto.subtle) and CompressionStream run in every supported
 * browser and in Node; nothing here touches the network.
 */

export const SHARE_VERSION = 1;
/** Characters of the data part a link may carry (24 KB of encrypted, compressed note; a 20 KB note of prose takes about 7,000 to 11,000). */
export const MAX_LINK_DATA = 32 * 1024;
/** The most a note inflates over its compressed size (prose: 3 to 10; deflate's ceiling: about 1,000). */
export const MAX_INFLATE_RATIO = 100;
/** The public app that links open on, unless the page is a public https one (build-time: VITE_SHARE_ORIGIN). */
export const PUBLIC_APP_ORIGIN = "https://lumen-md.vercel.app";

/** The most bytes a note of `compressed` bytes may inflate to. */
export function maxInflated(compressed: number): number {
  return Math.max(MAX_LINK_DATA, compressed) * MAX_INFLATE_RATIO;
}

/** Is `host` a name others can reach (not loopback, not a local-network name)? */
function publicHost(host: string): boolean {
  const h = host.replace(/^\[|\]$/g, "").toLowerCase();
  if (!h || h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h === "::1" || h === "0.0.0.0") return false;
  if (/^127\./.test(h) || /^10\./.test(h) || /^192\.168\./.test(h) || /^172\.(1[6-9]|2\d|3[01])\./.test(h) || /^169\.254\./.test(h)) return false;
  return h.includes(".") || h.includes(":");
}

/**
 * The origin a share link opens on: this page's, when it is https on a
 * public host (a self-hosted Lumen keeps its own links); otherwise the
 * build's VITE_SHARE_ORIGIN, or the public app.
 */
export function shareOrigin(
  loc: { protocol: string; hostname: string; origin: string } | null = typeof location !== "undefined" ? location : null,
  configured: string | undefined = (import.meta as ImportMeta & { env?: Record<string, string | undefined> }).env?.VITE_SHARE_ORIGIN,
): string {
  if (loc && loc.protocol === "https:" && publicHost(loc.hostname)) return loc.origin;
  try {
    const u = new URL(configured || PUBLIC_APP_ORIGIN);
    if (u.protocol === "https:") return u.origin;
  } catch {
    /* why: a malformed build setting: the public app */
  }
  return PUBLIC_APP_ORIGIN;
}

/** The encrypted file's first bytes: "LMSH". */
const FILE_MAGIC = [0x4c, 0x4d, 0x53, 0x48];
export const SHARE_FILE_EXTENSION = ".lumenshare";
const AAD = new TextEncoder().encode("lumen-share:1");
const IV_BYTES = 12;

export interface SharedNote {
  title: string;
  markdown: string;
  /** When the link was made (ms since the epoch). */
  created: number;
  /** After this moment the viewer refuses the note (ms since the epoch). */
  expires?: number;
}

export type ShareError = "malformed" | "key" | "expired" | "unsupported";

export class ShareLinkError extends Error {
  readonly code: ShareError;
  constructor(code: ShareError) {
    super(`share link: ${code}`);
    this.name = "ShareLinkError";
    this.code = code;
  }
}

/* ─── base64url ─── */

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ShareLinkError("malformed");
  const b64 = text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4);
  let bin: string;
  try {
    bin = atob(b64);
  } catch {
    throw new ShareLinkError("malformed");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/* ─── compression ─── */

/** Run `bytes` through `stream`; past `limit` output bytes the stream is cancelled and this throws "malformed". */
async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream, limit = Infinity): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => {
    /* why: a corrupt stream rejects the read side below, which reports it */
  });
  const reader = stream.readable.getReader();
  const chunks: Uint8Array[] = [];
  let n = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    n += value.length;
    if (n > limit) {
      await reader.cancel().catch(() => undefined);
      await writer.abort().catch(() => undefined);
      throw new ShareLinkError("malformed");
    }
    chunks.push(value);
  }
  const out = new Uint8Array(n);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}

function supported(): boolean {
  return typeof crypto !== "undefined" && !!crypto.subtle && typeof CompressionStream === "function" && typeof DecompressionStream === "function";
}

/* ─── encrypt / decrypt ─── */

async function importKey(raw: Uint8Array, usage: KeyUsage): Promise<CryptoKey> {
  if (raw.length !== 32) throw new ShareLinkError("key");
  return crypto.subtle.importKey("raw", raw as Uint8Array<ArrayBuffer>, { name: "AES-GCM" }, false, [usage]);
}

export interface SealedNote {
  /** version ‖ iv ‖ ciphertext — the link's data part, or the file's body. */
  data: Uint8Array;
  /** The raw 256-bit key. */
  key: Uint8Array;
}

/** Compress and encrypt a note with a fresh random key. */
export async function sealNote(note: SharedNote): Promise<SealedNote> {
  if (!supported()) throw new ShareLinkError("unsupported");
  const json: Record<string, unknown> = { v: SHARE_VERSION, t: note.title, m: note.markdown, c: note.created };
  if (note.expires !== undefined) json.e = note.expires;
  const raw = new TextEncoder().encode(JSON.stringify(json));
  const plain = await pipe(raw, new CompressionStream("deflate-raw"));
  // A note the viewer would refuse to inflate is refused here, so every link made opens.
  if (raw.length > maxInflated(plain.length)) throw new ShareLinkError("malformed");
  const key = crypto.getRandomValues(new Uint8Array(32));
  const iv = crypto.getRandomValues(new Uint8Array(IV_BYTES));
  const sealed = new Uint8Array(
    await crypto.subtle.encrypt({ name: "AES-GCM", iv, additionalData: AAD }, await importKey(key, "encrypt"), plain as Uint8Array<ArrayBuffer>),
  );
  const data = new Uint8Array(1 + IV_BYTES + sealed.length);
  data[0] = SHARE_VERSION;
  data.set(iv, 1);
  data.set(sealed, 1 + IV_BYTES);
  return { data, key };
}

/**
 * Decrypt and check a note. Throws ShareLinkError: "malformed" (not a share,
 * or cut short), "key" (wrong key, or the bytes were changed), "expired".
 */
export async function openNote(data: Uint8Array, key: Uint8Array, now: number = Date.now()): Promise<SharedNote> {
  if (!supported()) throw new ShareLinkError("unsupported");
  if (data.length < 1 + IV_BYTES + 16 || data[0] !== SHARE_VERSION) throw new ShareLinkError("malformed");
  let plain: Uint8Array;
  try {
    plain = new Uint8Array(
      await crypto.subtle.decrypt(
        { name: "AES-GCM", iv: data.subarray(1, 1 + IV_BYTES) as Uint8Array<ArrayBuffer>, additionalData: AAD },
        await importKey(key, "decrypt"),
        data.subarray(1 + IV_BYTES) as Uint8Array<ArrayBuffer>,
      ),
    );
  } catch (e) {
    if (e instanceof ShareLinkError) throw e;
    throw new ShareLinkError("key");
  }
  let json: unknown;
  try {
    json = JSON.parse(new TextDecoder().decode(await pipe(plain, new DecompressionStream("deflate-raw"), maxInflated(plain.length))));
  } catch {
    throw new ShareLinkError("malformed");
  }
  const o = json as { v?: unknown; t?: unknown; m?: unknown; c?: unknown; e?: unknown };
  if (!o || o.v !== SHARE_VERSION || typeof o.m !== "string" || typeof o.t !== "string" || typeof o.c !== "number") throw new ShareLinkError("malformed");
  const note: SharedNote = { title: o.t, markdown: o.m, created: o.c };
  if (typeof o.e === "number") {
    note.expires = o.e;
    if (now > o.e) throw new ShareLinkError("expired");
  }
  return note;
}

/* ─── links ─── */

export interface ShareLink {
  /** The whole link (key included), or null when the note is too large for one. */
  url: string | null;
  /** The link without its key, to send the key another way. */
  urlWithoutKey: string | null;
  /** The key alone (base64url), for the line above or for the file. */
  key: string;
  /** Characters of the data part. */
  dataChars: number;
  /** The encrypted file (always made; the dialog offers it when the link is too large). */
  file: Uint8Array;
  /** Opens the file: `#view-file&key=…`. */
  fileUrl: string;
}

const base = (origin: string) => `${origin.replace(/\/+$/, "")}/`;

/** A share link for `note` on the app at `origin` (e.g. https://lumen-md.vercel.app). */
export async function createShareLink(note: SharedNote, origin: string): Promise<ShareLink> {
  const { data, key } = await sealNote(note);
  const d = toBase64Url(data);
  const k = toBase64Url(key);
  const fits = d.length <= MAX_LINK_DATA;
  const file = new Uint8Array(FILE_MAGIC.length + data.length);
  file.set(FILE_MAGIC, 0);
  file.set(data, FILE_MAGIC.length);
  return {
    url: fits ? `${base(origin)}#view=${d}&key=${k}` : null,
    urlWithoutKey: fits ? `${base(origin)}#view=${d}` : null,
    key: k,
    dataChars: d.length,
    file,
    fileUrl: `${base(origin)}#view-file&key=${k}`,
  };
}

export interface ParsedShareHash {
  /** The data part, or null for `#view-file` (the data comes from a file). */
  data: string | null;
  /** The key, or null when the link came without it. */
  key: string | null;
}

/** Is this a share link's fragment? Cheap: the boot path calls it. */
export function isShareHash(hash: string): boolean {
  return /^#view(?:-file)?(?:[=&]|$)/.test(hash);
}

/** The parts of a share fragment, or null when it is not one. */
export function parseShareHash(hash: string): ParsedShareHash | null {
  if (!isShareHash(hash)) return null;
  const params = new Map<string, string>();
  for (const part of hash.slice(1).split("&")) {
    const i = part.indexOf("=");
    params.set(i < 0 ? part : part.slice(0, i), i < 0 ? "" : part.slice(i + 1));
  }
  const key = params.get("key") || null;
  if (params.has("view-file")) return { data: null, key };
  return { data: params.get("view") || null, key };
}

/** The data bytes of an encrypted share file (null when it is not one). */
export function shareFileData(file: Uint8Array): Uint8Array | null {
  if (file.length < FILE_MAGIC.length || FILE_MAGIC.some((b, i) => file[i] !== b)) return null;
  return file.subarray(FILE_MAGIC.length);
}

/** Expiry choices of the share dialog, in days (0 = never). */
export const EXPIRY_DAYS = [0, 1, 7, 30] as const;
