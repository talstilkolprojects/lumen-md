#!/usr/bin/env node
/**
 * Deploy the public live-share server (plan W4.8) to Cloudflare, free plan.
 *
 *   npm run collab:deploy            # log in once with `npx wrangler@4.20.0 login`
 *   npm run collab:deploy -- --dry-run
 *
 * 1. Sets the room-token signing secret (COLLAB_TOKEN_SECRET), a fresh
 *    random one unless it is already in the environment.
 * 2. `wrangler deploy` of edge-workers/collab (Worker + two SQLite Durable
 *    Objects, both on the Workers Free plan).
 * 3. Checks /healthz and prints the two build variables to set in the
 *    Vercel project, so the app (and its CSP, through cspEndpoints) uses
 *    the server:
 *      VITE_YJS_WEBSOCKET_URL      wss://<worker>/
 *      VITE_WEBRTC_SIGNALING_URL   wss://<worker>/signal
 *
 * Wrangler is run with npx at a pinned version; it is not a dependency of
 * the app.
 */
import { spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const WRANGLER = "wrangler@4.20.0";
const here = dirname(fileURLToPath(import.meta.url));
const dir = join(here, "..", "edge-workers", "collab");
const dry = process.argv.includes("--dry-run");

function wrangler(args, input) {
  const shown = `npx --yes ${WRANGLER} ${args.join(" ")}`;
  console.log(`$ ${shown}${input ? "   (secret on stdin)" : ""}`);
  if (dry) return "";
  const r = spawnSync("npx", ["--yes", WRANGLER, ...args], { cwd: dir, input, encoding: "utf8", stdio: [input ? "pipe" : "inherit", "pipe", "inherit"] });
  process.stdout.write(r.stdout ?? "");
  if (r.status !== 0) {
    console.error(`\n${shown} failed (exit ${r.status}).`);
    process.exit(r.status ?? 1);
  }
  return r.stdout ?? "";
}

wrangler(["whoami"]);
const secret = process.env.COLLAB_TOKEN_SECRET || randomBytes(36).toString("base64url");
if (secret.length < 32) {
  console.error("COLLAB_TOKEN_SECRET must be at least 32 characters.");
  process.exit(1);
}
const out = wrangler(["deploy"]);
wrangler(["secret", "put", "COLLAB_TOKEN_SECRET"], secret);

const host = /https:\/\/([\w.-]+\.workers\.dev)/.exec(out)?.[1] ?? "<your-worker>.workers.dev";
if (!dry && host.includes(".workers.dev")) {
  const res = await fetch(`https://${host}/healthz`).catch((e) => ({ ok: false, status: String(e) }));
  console.log(`healthz: ${res.ok ? "ok" : `not ok (${res.status})`}`);
}
console.log(`
Set these in the Vercel project (Settings → Environment Variables, Production), then redeploy:
  VITE_YJS_WEBSOCKET_URL=wss://${host}/
  VITE_WEBRTC_SIGNALING_URL=wss://${host}/signal
An uptime check (free): add https://${host}/healthz to a monitor such as UptimeRobot.
If the server is down, the app keeps working peer to peer (WebRTC) and on this device.`);
