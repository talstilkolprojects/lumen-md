# Research worker

This worker does the part of web research that a browser can't do itself because of CORS: it reads a web page as text, and it forwards a search request to the user's own search API key. It is used by **Research: Ask a Question…** and **Research: Verify Citations in This Note**.

Claude's built-in web search doesn't need this worker. When the AI provider is Anthropic, research uses the Messages API `web_search` tool, and only citation checks go through `/extract`.

## Deploy

```sh
cd edge-workers/research
npx wrangler deploy
```

Then:
1. Add a route on the app's domain (see `wrangler.toml`).
2. Set `ALLOWED_ORIGINS`.
3. Set the shared token with `npx wrangler secret put RESEARCH_TOKEN`, and build the app with the same value in `VITE_RESEARCH_TOKEN` (or enter it in the app under AI settings → Research token). It is required: without it the worker answers every request except `/healthz` with 503.
4. Build the app with `VITE_RESEARCH_ENDPOINT=https://research.<your-domain>`.

**Production:** also add a Cloudflare rate-limiting rule on the route, for example 120 requests per minute per IP. The worker's own per-isolate limit is only a best-effort backstop.

## Who can call it

The worker has no user accounts, so it can't tell who is calling. It applies these checks:

- **Origin.** Requests must carry an `Origin` listed in `ALLOWED_ORIGINS`, and requests without one are refused. This keeps other websites from using the worker from their pages. It is **not** authentication: a script outside a browser can send any `Origin`.
- **Shared token (required).** Every request (except the CORS preflight and `/healthz`) must send the `RESEARCH_TOKEN` secret in the `X-Lumen-Research-Token` header, or it gets 401. A worker deployed without the secret refuses everything with 503 (`token-not-configured`), so it is never an open endpoint by mistake. The app sends it when built with `VITE_RESEARCH_TOKEN`. For a public web app, the token is part of the shipped JavaScript, so it only stops casual reuse of the endpoint. It is a real secret only when the app build itself is private, for example an internal deployment.
- **Rate limits.** The worker keeps a best-effort per-IP limit in each isolate (60 requests per minute).

To actually restrict who can use the worker, put it behind [Cloudflare Access](https://developers.cloudflare.com/cloudflare-one/policies/access/) for internal deployments, and add a Cloudflare rate-limiting rule on the route for public ones (see Deploy).

## Endpoints

| Endpoint | Returns |
|---|---|
| `GET /extract?url=` | Title and readable text of a public page (`{ url, finalUrl, status, title, text, truncated, fetchedAt }`). Dead links report their HTTP status. |
| `POST /search` `{ provider: "brave" \| "tavily", query, key, count? }` | `{ results: [{ title, url, snippet }] }` |
| `GET /healthz` | Health check |

## Limits

- Only public http(s) URLs are fetched. Private, loopback, link-local and metadata addresses are refused, as are IPv6 literals, internal hostnames and non-default ports. Each redirect target is checked again, up to 5 redirects.
- Requests time out after 10 s. At most 2 MB is read, and only HTML or plain text is accepted. The returned text is capped at 200K characters.
- Cookies and credentials are never forwarded. The search key is used for that one request only, and is never stored or logged.
