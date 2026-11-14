#!/usr/bin/env node
/**
 * The content frame's own site (plan W6.40, review E52): a folder with only
 * the frame's page (public/content-frame.html as index.html: Cloudflare Pages
 * answers /x.html with a redirect to /x, and / needs none; its script is inline) and
 * deploy/content-frame/_headers, for a static host on another site than the
 * app — the official one is a Cloudflare Pages project by Direct Upload,
 * https://lumen-md-frame.pages.dev/.
 *
 *   node scripts/content-frame-site.mjs            → dist-frame/
 *   npx wrangler pages deploy dist-frame --project-name lumen-md-frame
 *   then build the app with VITE_CONTENT_FRAME_URL=https://lumen-md-frame.pages.dev/
 *
 * The site sees only `GET /` (the page's one script is inline, plan W10.D1): what
 * the frame shows travels in the #fragment, which a browser never sends.
 * `node scripts/headers.mjs --check` checks deploy/content-frame/_headers
 * against security/policy.json (host content-frame-site).
 */
import { copyFileSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const out = resolve(root, process.argv[2] ?? "dist-frame");
rmSync(out, { recursive: true, force: true });
mkdirSync(out, { recursive: true });
copyFileSync(join(root, "public/content-frame.html"), join(out, "index.html"));
copyFileSync(join(root, "deploy/content-frame/_headers"), join(out, "_headers"));
writeFileSync(join(out, "robots.txt"), "User-agent: *\nDisallow: /\n");
console.log(`content frame site: ${out}\nnext: npx wrangler pages deploy ${process.argv[2] ?? "dist-frame"} --project-name lumen-md-frame`);
