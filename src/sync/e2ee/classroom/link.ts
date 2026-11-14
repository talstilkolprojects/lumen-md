/**
 * The classroom link (plan W5.21): what a teacher sends the class.
 *
 *   https://lumen-md.vercel.app/#class=<data>
 *   data = base64url( 0x01 ‖ deflate-raw( JSON ) )
 *   JSON = { "v": 1, "t": title, "m": template Markdown,
 *            "k": the assignment's public key (base64url, 65 bytes),
 *            "r": the relay origin, "d": the drop box id (43 characters) }
 *
 * Like the encrypted share link of plan W5.10 (#448, src/share/linkShare.ts
 * there), everything sits in the #fragment, which a browser never sends to
 * a server: the host serving the app sees no template, key or drop box id.
 * Unlike it, nothing in this link is a secret from the class: the template
 * is for them, the public key only lets them seal work to the teacher, and
 * the drop box id only lets them add to it (sync-server/vault-relay.js,
 * "Bearer a.<d>"). The teacher's private key and owner token never leave
 * the teacher's device.
 *
 * Seam for #448: the same base64url and deflate-raw as linkShare.ts. When
 * both are merged, `toBase64Url` / `fromBase64Url` below are replaced by its
 * exports, and `isClassHash` sits beside its `isShareHash` in the boot path
 * (the two fragments never overlap: `#view…` versus `#class=`).
 */

export const CLASS_LINK_VERSION = 1;
/** Characters of the data part a link may carry (the cap of W5.10's links). */
export const MAX_CLASS_LINK_DATA = 32 * 1024;

export interface ClassLink {
  title: string;
  template: string;
  /** The assignment's public key, base64url of the raw 65 bytes. */
  teacherKey: string;
  /** The relay origin (https, or http on this machine). */
  relay: string;
  /** The drop box id: an append-only right on the relay. */
  drop: string;
}

export class ClassLinkError extends Error {
  constructor(readonly code: "malformed" | "tooLarge" | "unsupported") {
    super(`class link: ${code}`);
    this.name = "ClassLinkError";
  }
}

export function toBase64Url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function fromBase64Url(text: string): Uint8Array {
  if (!/^[A-Za-z0-9_-]*$/.test(text)) throw new ClassLinkError("malformed");
  let bin: string;
  try {
    bin = atob(text.replace(/-/g, "+").replace(/_/g, "/") + "===".slice((text.length + 3) % 4));
  } catch {
    throw new ClassLinkError("malformed");
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function pipe(bytes: Uint8Array, stream: CompressionStream | DecompressionStream): Promise<Uint8Array> {
  const writer = stream.writable.getWriter();
  void writer.write(bytes as Uint8Array<ArrayBuffer>).then(() => writer.close()).catch(() => {
    /* why: a corrupt stream rejects the read side below, which reports it */
  });
  return new Uint8Array(await new Response(stream.readable).arrayBuffer());
}

const DROP = /^[A-Za-z0-9_-]{43}$/;
const KEY = /^[A-Za-z0-9_-]{87}$/;

/** The `#class=…` fragment for `link` (throws ClassLinkError("tooLarge") past the cap). */
export async function classLinkHash(link: ClassLink): Promise<string> {
  if (typeof CompressionStream !== "function") throw new ClassLinkError("unsupported");
  const json = JSON.stringify({ v: CLASS_LINK_VERSION, t: link.title, m: link.template, k: link.teacherKey, r: link.relay, d: link.drop });
  const z = await pipe(new TextEncoder().encode(json), new CompressionStream("deflate-raw"));
  const data = new Uint8Array(1 + z.length);
  data[0] = CLASS_LINK_VERSION;
  data.set(z, 1);
  const text = toBase64Url(data);
  if (text.length > MAX_CLASS_LINK_DATA) throw new ClassLinkError("tooLarge");
  return `#class=${text}`;
}

/** Is this a classroom link's fragment? Cheap: the boot path calls it. */
export function isClassHash(hash: string): boolean {
  return /^#class=[A-Za-z0-9_-]+$/.test(hash);
}

/** The assignment in a `#class=` fragment; throws ClassLinkError("malformed") for anything else. */
export async function parseClassHash(hash: string): Promise<ClassLink> {
  if (!isClassHash(hash) || hash.length - 7 > MAX_CLASS_LINK_DATA) throw new ClassLinkError("malformed");
  if (typeof DecompressionStream !== "function") throw new ClassLinkError("unsupported");
  const data = fromBase64Url(hash.slice(7));
  if (data[0] !== CLASS_LINK_VERSION) throw new ClassLinkError("malformed");
  let o: Record<string, unknown>;
  try {
    o = JSON.parse(new TextDecoder().decode(await pipe(data.subarray(1), new DecompressionStream("deflate-raw")))) as Record<string, unknown>;
  } catch {
    throw new ClassLinkError("malformed");
  }
  if (!o || o.v !== CLASS_LINK_VERSION) throw new ClassLinkError("malformed");
  const { t, m, k, r, d } = o;
  if (typeof t !== "string" || typeof m !== "string" || typeof k !== "string" || typeof r !== "string" || typeof d !== "string") throw new ClassLinkError("malformed");
  if (!KEY.test(k) || !DROP.test(d) || !/^https?:\/\/[^/?#\s]+$/.test(r)) throw new ClassLinkError("malformed");
  return { title: t, template: m, teacherKey: k, relay: r, drop: d };
}
