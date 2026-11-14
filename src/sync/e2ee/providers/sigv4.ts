/**
 * AWS Signature Version 4 for S3 requests (plan 3.5), with WebCrypto and no
 * dependency: canonical request → string to sign → HMAC chain → Authorization
 * header. Verified against the worked example in AWS's "Authenticating
 * Requests (AWS Signature Version 4)" documentation (sigv4.test.ts).
 *
 * Why not `aws4fetch` (plan 3.5.7): the package could not be kept in the
 * shared node_modules of this environment (another lane's install pruned
 * it), and the signing itself is ~90 lines.
 */

const enc = new TextEncoder();

function hex(buf: ArrayBuffer | Uint8Array): string {
  const bytes = buf instanceof Uint8Array ? buf : new Uint8Array(buf);
  let out = "";
  for (const b of bytes) out += b.toString(16).padStart(2, "0");
  return out;
}

export async function sha256Hex(data: Uint8Array | string): Promise<string> {
  const bytes = typeof data === "string" ? enc.encode(data) : data;
  return hex(await crypto.subtle.digest("SHA-256", bytes as BufferSource));
}

async function hmac(key: Uint8Array | ArrayBuffer, data: string): Promise<ArrayBuffer> {
  const k = await crypto.subtle.importKey("raw", key as BufferSource, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return crypto.subtle.sign("HMAC", k, enc.encode(data));
}

/** RFC 3986 encoding, which `encodeURIComponent` almost is. */
function rfc3986(s: string): string {
  return encodeURIComponent(s).replace(/[!'()*]/g, (c) => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

/** `20130524T000000Z` */
export function amzDate(d: Date): string {
  return d.toISOString().replace(/[:-]|\.\d{3}/g, "");
}

export interface SigV4Credentials {
  accessKeyId: string;
  secretAccessKey: string;
  sessionToken?: string;
}

export interface SigV4Input {
  method: string;
  url: string;
  headers?: Record<string, string>;
  body?: Uint8Array;
  region: string;
  service?: string;
  /** The request time (tests pass a fixed one). */
  date?: Date;
}

/** The headers to send: the given ones plus host, x-amz-date, x-amz-content-sha256 (and the session token) and Authorization. */
export async function signRequest(creds: SigV4Credentials, input: SigV4Input): Promise<Record<string, string>> {
  const url = new URL(input.url);
  const service = input.service ?? "s3";
  const date = input.date ?? new Date();
  const stamp = amzDate(date);
  const day = stamp.slice(0, 8);
  const payloadHash = await sha256Hex(input.body ?? new Uint8Array());

  const headers: Record<string, string> = {};
  for (const [k, v] of Object.entries(input.headers ?? {})) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  headers.host = url.host;
  headers["x-amz-date"] = stamp;
  headers["x-amz-content-sha256"] = payloadHash;
  if (creds.sessionToken) headers["x-amz-security-token"] = creds.sessionToken;

  const signedNames = Object.keys(headers).sort();
  const canonicalHeaders = signedNames.map((k) => `${k}:${headers[k]}\n`).join("");
  // The path arrives already percent-encoded (the provider encodes object
  // keys); S3 signs it as sent, not double-encoded.
  const canonicalPath = url.pathname || "/";
  const canonicalQuery = [...url.searchParams.entries()]
    .map(([k, v]) => [rfc3986(k), rfc3986(v)] as const)
    .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : a[1] < b[1] ? -1 : a[1] > b[1] ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join("&");
  const canonicalRequest = [input.method.toUpperCase(), canonicalPath, canonicalQuery, canonicalHeaders, signedNames.join(";"), payloadHash].join("\n");

  const scope = `${day}/${input.region}/${service}/aws4_request`;
  const stringToSign = ["AWS4-HMAC-SHA256", stamp, scope, await sha256Hex(canonicalRequest)].join("\n");

  let key: ArrayBuffer = await hmac(enc.encode(`AWS4${creds.secretAccessKey}`), day);
  key = await hmac(key, input.region);
  key = await hmac(key, service);
  key = await hmac(key, "aws4_request");
  const signature = hex(await hmac(key, stringToSign));

  const out: Record<string, string> = { ...(input.headers ?? {}) };
  out["x-amz-date"] = stamp;
  out["x-amz-content-sha256"] = payloadHash;
  if (creds.sessionToken) out["x-amz-security-token"] = creds.sessionToken;
  out.Authorization = `AWS4-HMAC-SHA256 Credential=${creds.accessKeyId}/${scope}, SignedHeaders=${signedNames.join(";")}, Signature=${signature}`;
  return out;
}
