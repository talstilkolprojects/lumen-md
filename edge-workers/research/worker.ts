/**
 * Lumen research worker (Cloudflare) — the part of web research a browser
 * can't do itself because of CORS (Plan D: D6, D7).
 *
 *   GET  /extract?url=<https://…>  → { url, finalUrl, status, title, text, truncated, fetchedAt }
 *   POST /search { provider: "brave" | "tavily" | "searxng", query, key?, count? }
 *        searxng needs no key: the worker queries its SEARXNG_URL (a
 *        self-hosted SearXNG with the JSON format enabled).
 *                                   → { results: [{ title, url, snippet }] }
 *   GET  /healthz                   → "ok"
 *
 * Safety:
 *  - Only origins in ALLOWED_ORIGINS may call it (CORS + an Origin check;
 *    a request without an Origin is refused). That keeps other sites'
 *    pages from using it, but a non-browser client can send any Origin, so
 *    it is not authentication. With RESEARCH_TOKEN set, every request must
 *    also carry it in X-Lumen-Research-Token; the app sends the token the
 *    user entered in AI settings (kept in its secret store, never in the
 *    build); see README.md.
 *  - Public http(s) URLs only, re-checked on every redirect (max 5); no
 *    cookies or credentials are forwarded; 10 s timeout; at most 2 MB read;
 *    HTML / plain text only; returned text capped at 200K characters.
 *  - The search key comes with each request (the user's own) and is never
 *    stored or logged.
 *  - Best-effort per-IP rate limit in the isolate; add a Cloudflare rate-
 *    limiting rule in production (see README.md).
 *  - Extractions are cached at the edge for an hour.
 */
import { charsetOf, htmlToText, isFetchableUrl } from "./extract";

export interface Env {
  /** Comma-separated app origins, e.g. "https://lumen-md.app,http://localhost:5173". */
  ALLOWED_ORIGINS: string;
  /** Optional shared token (a Worker secret) required in X-Lumen-Research-Token. */
  RESEARCH_TOKEN?: string;
  /** Optional self-hosted SearXNG (e.g. http://localhost:8888) for keyless search. */
  SEARXNG_URL?: string;
}

export const TOKEN_HEADER = "X-Lumen-Research-Token";

/** Constant-time string comparison, so the token can't be guessed by timing. */
function sameToken(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

const MAX_BYTES = 2 * 1024 * 1024;
const MAX_TEXT = 200_000;
const TIMEOUT_MS = 10_000;
const MAX_REDIRECTS = 5;
const RATE_PER_MIN = 60;
const UA = "LumenResearch/1.0 (+https://lumen-md.app)";

const hits = new Map<string, number[]>();
function rateLimited(ip: string, now = Date.now()): boolean {
  const list = (hits.get(ip) ?? []).filter((t) => now - t < 60_000);
  list.push(now);
  hits.set(ip, list);
  if (hits.size > 10_000) hits.clear();
  return list.length > RATE_PER_MIN;
}

function cors(origin: string | null, env: Env): Record<string, string> | null {
  const allowed = (env.ALLOWED_ORIGINS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!origin || !allowed.includes(origin)) return null;
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": `Content-Type, ${TOKEN_HEADER}`,
    "Access-Control-Max-Age": "86400",
    Vary: "Origin",
  };
}

const json = (body: unknown, headers: Record<string, string>, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { ...headers, "Content-Type": "application/json; charset=utf-8" } });

async function readCapped(res: Response): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Uint8Array[] = [];
  let size = 0;
  let truncated = false;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      chunks.push(value.subarray(0, value.byteLength - (size - MAX_BYTES)));
      truncated = true;
      await reader.cancel();
      break;
    }
    chunks.push(value);
  }
  const all = new Uint8Array(chunks.reduce((n, c) => n + c.byteLength, 0));
  let off = 0;
  for (const c of chunks) {
    all.set(c, off);
    off += c.byteLength;
  }
  const charset = charsetOf(res.headers.get("content-type"));
  let decoder: TextDecoder;
  try {
    decoder = new TextDecoder(charset);
  } catch {
    decoder = new TextDecoder("utf-8");
  }
  return { text: decoder.decode(all), truncated };
}

async function extract(target: string): Promise<Record<string, unknown>> {
  let url = target;
  // One deadline for the whole extraction (every redirect hop and the body
  // read), so a chain of slow redirects can't stretch it past TIMEOUT_MS.
  const signal = AbortSignal.timeout(TIMEOUT_MS);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    if (!isFetchableUrl(url)) return { url: target, finalUrl: url, status: 0, error: "blocked-url" };
    const res = await fetch(url, {
      redirect: "manual",
      headers: { "User-Agent": UA, Accept: "text/html,application/xhtml+xml,text/plain;q=0.9,*/*;q=0.1" },
      signal,
    });
    if (res.status >= 300 && res.status < 400 && res.headers.get("location")) {
      url = new URL(res.headers.get("location")!, url).href;
      continue;
    }
    if (!res.ok) return { url: target, finalUrl: url, status: res.status, error: "http-error" };
    const type = (res.headers.get("content-type") ?? "").toLowerCase();
    if (!/text\/html|application\/xhtml\+xml|text\/plain/.test(type)) {
      return { url: target, finalUrl: url, status: res.status, error: "unsupported-type", contentType: type.split(";")[0] };
    }
    const body = await readCapped(res);
    const page = type.includes("text/plain") ? { title: "", text: body.text } : htmlToText(body.text);
    const truncated = body.truncated || page.text.length > MAX_TEXT;
    return {
      url: target,
      finalUrl: url,
      status: res.status,
      title: page.title,
      text: page.text.slice(0, MAX_TEXT),
      truncated,
      fetchedAt: new Date().toISOString(),
    };
  }
  return { url: target, finalUrl: url, status: 0, error: "too-many-redirects" };
}

interface SearchResult {
  title: string;
  url: string;
  snippet: string;
}

async function search(provider: string, query: string, key: string, count: number, env?: Env): Promise<SearchResult[]> {
  if (provider === "searxng") {
    const base = env?.SEARXNG_URL?.replace(/\/+$/, "");
    if (!base) throw new Error("searxng is not configured on this research service (SEARXNG_URL)");
    const res = await fetch(`${base}/search?q=${encodeURIComponent(query)}&format=json`, { headers: { Accept: "application/json" }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`searxng ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).slice(0, count).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
  }
  if (provider === "brave") {
    const u = `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=${count}`;
    const res = await fetch(u, { headers: { Accept: "application/json", "X-Subscription-Token": key }, signal: AbortSignal.timeout(TIMEOUT_MS) });
    if (!res.ok) throw new Error(`brave ${res.status}`);
    const data = (await res.json()) as { web?: { results?: Array<{ title?: string; url?: string; description?: string }> } };
    return (data.web?.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: (r.description ?? "").replace(/<[^>]+>/g, "") }));
  }
  if (provider === "tavily") {
    const res = await fetch("https://api.tavily.com/search", {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${key}` },
      body: JSON.stringify({ query, max_results: count, search_depth: "basic" }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) throw new Error(`tavily ${res.status}`);
    const data = (await res.json()) as { results?: Array<{ title?: string; url?: string; content?: string }> };
    return (data.results ?? []).map((r) => ({ title: r.title ?? "", url: r.url ?? "", snippet: r.content ?? "" }));
  }
  throw new Error("unknown provider");
}

export default {
  async fetch(req: Request, env: Env, ctx: { waitUntil(p: Promise<unknown>): void }): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/healthz") return new Response("ok");
    const headers = cors(req.headers.get("Origin"), env);
    if (!headers) return new Response("Forbidden origin", { status: 403 });
    if (req.method === "OPTIONS") return new Response(null, { status: 204, headers });
    // Checked after the preflight: browsers never send custom headers on OPTIONS.
    if (env.RESEARCH_TOKEN && !sameToken(req.headers.get(TOKEN_HEADER) ?? "", env.RESEARCH_TOKEN)) {
      return json({ error: "unauthorized" }, headers, 401);
    }
    const ip = req.headers.get("CF-Connecting-IP") ?? "unknown";
    if (rateLimited(ip)) return json({ error: "rate-limited" }, { ...headers, "Retry-After": "60" }, 429);

    try {
      if (req.method === "GET" && url.pathname === "/extract") {
        const target = url.searchParams.get("url") ?? "";
        if (!isFetchableUrl(target)) return json({ error: "blocked-url" }, headers, 400);
        const cache = (caches as unknown as { default: Cache }).default;
        const key = new Request(`https://research-cache.invalid/extract?url=${encodeURIComponent(target)}`);
        const hit = await cache.match(key);
        if (hit) return json(await hit.json(), headers);
        const out = await extract(target);
        if (!out.error) ctx.waitUntil(cache.put(key, new Response(JSON.stringify(out), { headers: { "Cache-Control": "max-age=3600" } })));
        return json(out, headers);
      }
      if (req.method === "POST" && url.pathname === "/search") {
        const body = (await req.json().catch(() => ({}))) as { provider?: string; query?: string; key?: string; count?: number };
        const query = String(body.query ?? "").slice(0, 400).trim();
        const key = String(body.key ?? "");
        const provider = String(body.provider ?? "");
        if (!query || (!key && provider !== "searxng")) return json({ error: "query and key are required" }, headers, 400);
        const count = Math.max(1, Math.min(10, Number(body.count) || 5));
        const results = await search(provider, query, key, count, env);
        return json({ results: results.filter((r) => isFetchableUrl(r.url)) }, headers);
      }
      return json({ error: "not found" }, headers, 404);
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      return json({ error: message.slice(0, 200) }, headers, 502);
    }
  },
};
