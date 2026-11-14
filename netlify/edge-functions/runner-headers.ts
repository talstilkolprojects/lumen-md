// Netlify (plan 13.2): the two runner pages get their own security policy.
//
// Netlify applies dist/_headers (public/_headers) to every response, and its
// grammar cannot detach the catch-all rules the way Cloudflare's `! Header`
// lines do, so /playground-runner.html and /livejs-runner.html also received
// the app's X-Frame-Options: DENY and CSP — and the Web Playground and live-js
// blocks could not run on Netlify. This edge function runs for those two
// paths only, takes the CDN's response and replaces those two headers with
// the runner's policy (frame-ancestors 'self' instead of a frame denial).
//
// The policy strings are rendered from security/policy.json: `npm run
// headers` fails when they drift, `npm run headers:write` rewrites them.
import type { Context } from "https://edge.netlify.com";

const POLICIES: Record<string, string> = {
  "/playground-runner.html": "default-src 'none'; script-src 'self' 'nonce-lumen-livejs-runner' blob: 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "/livejs-runner.html": "default-src 'none'; script-src 'self' 'nonce-lumen-livejs-runner' blob: 'unsafe-eval'; worker-src blob:; connect-src 'none'; img-src 'none'; style-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
};

export default async (request: Request, context: Context) => {
  const csp = POLICIES[new URL(request.url).pathname];
  const response = await context.next();
  if (!csp) return response;
  const out = new Response(response.body, response);
  out.headers.delete("x-frame-options");
  out.headers.set("content-security-policy", csp);
  return out;
};

export const config = { path: ["/playground-runner.html", "/livejs-runner.html"] };
