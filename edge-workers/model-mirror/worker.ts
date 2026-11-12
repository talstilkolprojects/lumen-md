/**
 * Lumen's model mirror (plan W4.14), a Cloudflare Worker.
 *
 *   GET /<tag>/<path…>   → the release asset <path with "/" as "__"> of
 *                          release <tag> on REPO, streamed, with CORS
 *   GET /<tag>/<asset>   → the same, for the flattened asset name
 *   OPTIONS              → CORS preflight
 *
 * Why it exists: GitHub's release downloads (github.com/…/releases/download/
 * → release-assets.githubusercontent.com) send no Access-Control-Allow-Origin
 * header (measured 12.11.2026), so a browser cannot fetch them. The worker
 * adds that header and nothing else: it never stores anything, only tags
 * starting with `models-` are reachable, and the app checks every file's
 * sha256 against models/registry.json, so the proxy is not trusted with the
 * content. Range requests pass through (resumable downloads).
 */

export interface Env {
  REPO: string;
}

const TAG = /^models-[a-z0-9._-]{1,100}$/;
const SEGMENT = /^[A-Za-z0-9._@+=-]{1,200}$/;

const CORS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
  "Access-Control-Allow-Headers": "Range",
  "Access-Control-Expose-Headers": "Content-Length, Content-Range, Accept-Ranges, ETag",
};

/** "/models-x/onnx/a.onnx" → { tag: "models-x", asset: "onnx__a.onnx" }, or null for anything else. */
export function parseMirrorPath(pathname: string): { tag: string; asset: string } | null {
  const parts = pathname.split("/").filter(Boolean).map((p) => {
    try {
      return decodeURIComponent(p);
    } catch {
      return "";
    }
  });
  if (parts.length < 2) return null;
  const [tag, ...rest] = parts;
  if (!TAG.test(tag)) return null;
  if (rest.some((p) => !SEGMENT.test(p) || p === "." || p === "..")) return null;
  const asset = rest.join("__");
  return asset.length <= 255 ? { tag, asset } : null;
}

export function releaseUrl(repo: string, tag: string, asset: string): string {
  return `https://github.com/${repo}/releases/download/${encodeURIComponent(tag)}/${encodeURIComponent(asset)}`;
}

type Fetcher = (input: string, init?: RequestInit) => Promise<Response>;

export async function handle(req: Request, env: Env, fetcher: Fetcher): Promise<Response> {
  if (req.method === "OPTIONS") return new Response(null, { status: 204, headers: CORS });
  if (req.method !== "GET" && req.method !== "HEAD") return new Response("method not allowed", { status: 405, headers: CORS });
  const target = parseMirrorPath(new URL(req.url).pathname);
  if (!target || !/^[\w.-]+\/[\w.-]+$/.test(env.REPO)) return new Response("not found", { status: 404, headers: CORS });
  const headers: Record<string, string> = {};
  const range = req.headers.get("Range");
  if (range && /^bytes=\d*-\d*$/.test(range)) headers.Range = range;
  const upstream = await fetcher(releaseUrl(env.REPO, target.tag, target.asset), { method: req.method, headers, redirect: "follow" });
  const out = new Headers(CORS);
  for (const h of ["Content-Length", "Content-Range", "Accept-Ranges", "ETag", "Last-Modified"]) {
    const v = upstream.headers.get(h);
    if (v) out.set(h, v);
  }
  out.set("Content-Type", "application/octet-stream");
  out.set("Cache-Control", upstream.ok ? "public, max-age=31536000, immutable" : "no-store");
  out.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.ok || upstream.status === 206 ? upstream.body : null, { status: upstream.status, headers: out });
}

export default {
  fetch: (req: Request, env: Env): Promise<Response> => handle(req, env, (input, init) => fetch(input, init)),
};
