// Netlify (plan 13.2): the two runner pages and the content frame (plan
// W4.15) get their own security policy.
//
// Netlify applies dist/_headers (public/_headers) to every response, and its
// grammar cannot detach the catch-all rules the way Cloudflare's `! Header`
// lines do, so /playground-runner.html and /livejs-runner.html also received
// the app's X-Frame-Options: DENY and CSP — and the Web Playground and live-js
// blocks could not run on Netlify. This edge function runs for those two
// paths only, takes the CDN's response and replaces those two headers with
// the page's own policy (frame-ancestors 'self' instead of a frame denial).
//
// The policy strings are rendered from security/policy.json: `npm run
// headers` fails when they drift, `npm run headers:write` rewrites them.
import type { Context } from "https://edge.netlify.com";

const POLICIES: Record<string, string> = {
  "/playground-runner.html": "default-src 'none'; script-src 'self' 'nonce-lumen-livejs-runner' blob: 'unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src * data: blob:; media-src * data: blob:; font-src 'self' data:; connect-src 'self'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
  "/content-frame.html": "default-src 'none'; script-src 'self' 'nonce-lumen-livejs-runner' https://gist.github.com; style-src 'self' 'unsafe-inline' https://github.githubassets.com; img-src 'self' data: blob: https:; media-src 'self' blob: https:; frame-src https://www.youtube.com https://www.youtube-nocookie.com https://player.vimeo.com https://www.loom.com https://codepen.io https://codesandbox.io https://www.figma.com https://open.spotify.com https://www.google.com https://maps.google.com https://www.openstreetmap.org https://platform.twitter.com https://www.facebook.com https://www.instagram.com https://www.tiktok.com https://www.redditmedia.com https://www.reddit.com https://www.linkedin.com https://w.soundcloud.com; connect-src 'none'; frame-ancestors 'self'; base-uri 'none'; form-action 'none'",
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

export const config = { path: ["/playground-runner.html", "/livejs-runner.html", "/content-frame.html"] };
