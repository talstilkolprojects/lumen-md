/**
 * An S3-compatible server in memory (plan 3.5): one bucket, objects with
 * ETags, `If-Match` / `If-None-Match: *` on PUT (412 on a miss, like AWS S3
 * since 2024), ListObjectsV2 with prefix + continuation tokens, DELETE. It
 * verifies every request's SigV4 signature with the known secret — the same
 * algorithm the provider uses, checked against AWS's worked example in
 * sigv4.test.ts — and rejects a wrong key with 403.
 */
import { signRequest } from "../../../sync/e2ee/providers/sigv4";
import type { FakeRequest, FakeResponse, FakeServer } from "./http";

export interface FakeS3 extends FakeServer {
  objects: Map<string, { data: Uint8Array; etag: string }>;
  /** Page size of ListObjectsV2 (small in tests to exercise continuation). */
  pageSize: number;
  outage: number | null;
}

function xmlEscape(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function fakeS3(opts: { endpoint: string; bucket: string; accessKeyId: string; secretAccessKey: string; region: string }): FakeS3 {
  const endpoint = new URL(opts.endpoint);
  let seq = 0;
  const server: FakeS3 = { objects: new Map(), pageSize: 1000, outage: null, log: [], handle: (req) => handle(req) };

  async function verify(req: FakeRequest): Promise<FakeResponse | null> {
    const auth = req.headers.get("authorization") ?? "";
    const m = /^AWS4-HMAC-SHA256 Credential=([^/]+)\/(\d{8})\/([^/]+)\/s3\/aws4_request, SignedHeaders=([^,]+), Signature=([0-9a-f]{64})$/.exec(auth);
    if (!m) return { status: 403, body: "<Error><Code>AccessDenied</Code><Message>missing signature</Message></Error>" };
    if (m[1] !== opts.accessKeyId) return { status: 403, body: "<Error><Code>InvalidAccessKeyId</Code></Error>" };
    const stamp = req.headers.get("x-amz-date") ?? "";
    const date = new Date(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
    const signedNames = m[4].split(";");
    const headers: Record<string, string> = {};
    for (const n of signedNames) if (n !== "host" && n !== "x-amz-date" && n !== "x-amz-content-sha256" && n !== "x-amz-security-token") headers[n] = req.headers.get(n) ?? "";
    const expected = await signRequest(
      { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey, sessionToken: req.headers.get("x-amz-security-token") ?? undefined },
      { method: req.method, url: req.url.toString(), headers, body: req.body, region: m[3], date },
    );
    if (expected.Authorization !== auth) return { status: 403, body: "<Error><Code>SignatureDoesNotMatch</Code></Error>" };
    return null;
  }

  async function handle(req: FakeRequest): Promise<FakeResponse> {
    server.log.push(`${req.method} ${decodeURIComponent(req.url.pathname)}${req.url.search}`);
    if (server.outage) return { status: server.outage, body: "<Error><Code>SlowDown</Code></Error>" };
    if (req.url.host !== endpoint.host) return { status: 404, body: "wrong host" };
    const denied = await verify(req);
    if (denied) return denied;
    const path = decodeURIComponent(req.url.pathname);
    const bucketPrefix = `${endpoint.pathname.replace(/\/+$/, "")}/${opts.bucket}`;
    if (!path.startsWith(bucketPrefix)) return { status: 404, body: "<Error><Code>NoSuchBucket</Code></Error>" };
    const key = path.slice(bucketPrefix.length + 1);
    if (key === "" && req.method === "GET") {
      const prefix = req.url.searchParams.get("prefix") ?? "";
      const token = req.url.searchParams.get("continuation-token");
      const keys = [...server.objects.keys()].filter((k) => k.startsWith(prefix)).sort();
      const start = token ? keys.indexOf(token) + 1 : 0;
      const page = keys.slice(start, start + server.pageSize);
      const truncated = start + server.pageSize < keys.length;
      const body =
        `<?xml version="1.0" encoding="UTF-8"?><ListBucketResult xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Name>${xmlEscape(opts.bucket)}</Name><Prefix>${xmlEscape(prefix)}</Prefix><KeyCount>${page.length}</KeyCount><IsTruncated>${truncated}</IsTruncated>` +
        (truncated ? `<NextContinuationToken>${xmlEscape(page[page.length - 1])}</NextContinuationToken>` : "") +
        page.map((k) => `<Contents><Key>${xmlEscape(k)}</Key><ETag>${xmlEscape(server.objects.get(k)!.etag)}</ETag><Size>${server.objects.get(k)!.data.length}</Size></Contents>`).join("") +
        `</ListBucketResult>`;
      return { status: 200, headers: { "Content-Type": "application/xml" }, body };
    }
    const cur = server.objects.get(key);
    switch (req.method) {
      case "GET":
        if (!cur) return { status: 404, body: "<Error><Code>NoSuchKey</Code></Error>" };
        return { status: 200, headers: { ETag: cur.etag, "Content-Type": "application/octet-stream" }, body: cur.data.slice() };
      case "HEAD":
        return cur ? { status: 200, headers: { ETag: cur.etag } } : { status: 404 };
      case "PUT": {
        const ifMatch = req.headers.get("if-match");
        const ifNone = req.headers.get("if-none-match");
        if (ifMatch !== null && (!cur || cur.etag !== ifMatch)) return { status: 412, body: "<Error><Code>PreconditionFailed</Code></Error>" };
        if (ifNone === "*" && cur) return { status: 412, body: "<Error><Code>PreconditionFailed</Code></Error>" };
        const obj = { data: req.body.slice(), etag: `"s${++seq}"` };
        server.objects.set(key, obj);
        return { status: 200, headers: { ETag: obj.etag } };
      }
      case "DELETE":
        server.objects.delete(key);
        return { status: 204 };
      default:
        return { status: 405, body: "method not allowed" };
    }
  }
  return server;
}
