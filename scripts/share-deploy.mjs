#!/usr/bin/env node
/**
 * Plan W6.23: deploy the two share servers to Cloudflare Workers (Free plan)
 * with one command, and the owner's session that checks them.
 *
 *   npm run share:deploy                    wrangler login (when needed), then deploy
 *                                           lumen-collab (live share, edge-workers/collab)
 *                                           and lumen-vault-relay (encrypted sync,
 *                                           edge-workers/vault-relay)
 *   npm run share:deploy -- --bundle-only   bundle both Workers (wrangler deploy --dry-run
 *                                           --outdir); deploys nothing
 *   npm run share:deploy -- --dry-run       print every command; run none
 *   npm run owner:share                     the owner session: the deploy above, then
 *                                           1. latency from here: p95 < 150 ms (share-latency.mjs)
 *                                           2. the relay's limits on the real runtime: a
 *                                              temporary copy with tiny limits, deleted after
 *                                           3. `wrangler tail` of both while canary notes
 *                                              go through, scanned: 0 hits (share-scan.mjs)
 *                                           4. a receipt in ~/.lumen-owner/
 *
 * Options: --skip-collab, --skip-relay, --n <samples> (200), --max-p95 <ms> (150).
 * Wrangler runs with npx at a pinned version (the one scripts/collab-deploy.mjs
 * pins); it is not a dependency of the app.
 */
import { spawn, spawnSync } from "node:child_process";
import { createWriteStream, mkdirSync, mkdtempSync, realpathSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/** Run as a command (also through a symlink), not imported. */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

export const WRANGLER = "wrangler@4.20.0";
const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
export const DIRS = { collab: join(root, "edge-workers", "collab"), relay: join(root, "edge-workers", "vault-relay") };
export const NAMES = { collab: "lumen-collab", relay: "lumen-vault-relay" };
/** The temporary relay the session checks the limits on (deleted at the end). */
export const CHECK_NAME = "lumen-vault-relay-limits";
export const CHECK_LIMITS = { VAULT_RELAY_MAX_TOTAL: 65536, VAULT_RELAY_NEW_SPACES_PER_DAY: 2, VAULT_RELAY_POW_BITS: 0 };

const argv = process.argv.slice(2);
const flag = (f) => argv.includes(f);
const opt = (f, d) => (argv.indexOf(f) === -1 ? d : argv[argv.indexOf(f) + 1]);
const dry = flag("--dry-run");

function run(cmd, args, { cwd = root, input, capture = true } = {}) {
  const shown = `${cmd} ${args.join(" ")}`;
  console.log(`$ ${cwd === root ? "" : `(cd ${cwd.slice(root.length + 1)}) `}${shown}${input ? "   (secret on stdin)" : ""}`);
  if (dry) return { status: 0, stdout: "" };
  const r = spawnSync(cmd, args, { cwd, input, encoding: "utf8", stdio: [input ? "pipe" : "inherit", capture ? "pipe" : "inherit", "inherit"] });
  if (capture) process.stdout.write(r.stdout ?? "");
  return { status: r.status ?? 1, stdout: r.stdout ?? "" };
}
const wrangler = (args, o) => run("npx", ["--yes", WRANGLER, ...args], o);
function must(r, what) {
  if (r.status !== 0) {
    console.error(`\n${what} failed (exit ${r.status}).`);
    process.exit(r.status || 1);
  }
  return r;
}
/** The workers.dev host in wrangler's output. */
export const hostIn = (out, name) => new RegExp(`https://(${name}\\.[\\w.-]+\\.workers\\.dev)`).exec(out)?.[1] ?? /https:\/\/([\w.-]+\.workers\.dev)/.exec(out)?.[1] ?? null;

async function healthz(host) {
  if (dry || !host) return null;
  const r = await fetch(`https://${host}/healthz`).catch((e) => ({ ok: false, status: String(e) }));
  console.log(`healthz ${host}: ${r.ok ? "ok" : `not ok (${r.status})`}`);
  return r.ok;
}

async function main() {
  const receipt = { at: new Date().toISOString(), steps: {} };
  // ── log in ──
  const who = wrangler(["whoami"]);
  if (!dry && /not authenticated|not logged in/i.test(who.stdout)) must(wrangler(["login"], { capture: false }), "wrangler login");

  if (flag("--bundle-only")) {
    for (const k of ["collab", "relay"]) {
      const out = mkdtempSync(join(tmpdir(), `lumen-${k}-bundle-`));
      must(wrangler(["deploy", "--dry-run", "--outdir", out], { cwd: DIRS[k] }), `bundling ${NAMES[k]}`);
      console.log(`${NAMES[k]}: bundled into ${out}`);
    }
    return;
  }

  // ── deploy ──
  const hosts = {};
  if (!flag("--skip-collab")) {
    const r = must(run("node", [join("scripts", "collab-deploy.mjs"), ...(dry ? ["--dry-run"] : [])]), "deploying lumen-collab");
    hosts.collab = hostIn(r.stdout, NAMES.collab);
  }
  if (!flag("--skip-relay")) {
    const r = must(wrangler(["deploy"], { cwd: DIRS.relay }), "deploying lumen-vault-relay");
    hosts.relay = hostIn(r.stdout, NAMES.relay);
    await healthz(hosts.relay);
  }
  receipt.hosts = hosts;
  console.log(`
Set these in the Vercel project (Settings → Environment Variables, Production), then redeploy:
  VITE_YJS_WEBSOCKET_URL=wss://${hosts.collab ?? "<lumen-collab host>"}/
  VITE_WEBRTC_SIGNALING_URL=wss://${hosts.collab ?? "<lumen-collab host>"}/signal
  VITE_SYNC_RELAY_URL=https://${hosts.relay ?? "<lumen-vault-relay host>"}
Uptime (free): add https://${hosts.collab ?? "<lumen-collab host>"}/healthz and https://${hosts.relay ?? "<lumen-vault-relay host>"}/healthz
to a monitor such as UptimeRobot, and make its public status page (docs: sync/relay-server).`);

  if (!flag("--session")) return;
  if (dry) {
    console.log(`\n(session) node scripts/share-latency.mjs --collab wss://<collab>/ --relay https://<relay> --big --n ${opt("--n", 200)} --max-p95 ${opt("--max-p95", 150)}`);
    const vars = Object.entries(CHECK_LIMITS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    run("npx", ["--yes", WRANGLER, "deploy", "--name", CHECK_NAME, ...vars], { cwd: DIRS.relay });
    run("npx", ["--yes", WRANGLER, "delete", "--name", CHECK_NAME], { cwd: DIRS.relay });
    run("npx", ["--yes", WRANGLER, "tail", NAMES.collab, "--format", "json"]);
    run("npx", ["--yes", WRANGLER, "tail", NAMES.relay, "--format", "json"]);
    console.log("(session) node scripts/share-scan.mjs --text <canary> <the two tail logs>");
    return;
  }
  const { measureCollab, measureRelay, DEFAULT_CANARY } = await import("./share-latency.mjs");
  const { scan } = await import("./share-scan.mjs");
  const n = Number(opt("--n", 200)) || 200;
  const maxP95 = Number(opt("--max-p95", 150)) || 150;
  const canary = `${DEFAULT_CANARY} ${Date.now().toString(36)}`;
  const outDir = join(homedir(), ".lumen-owner");
  mkdirSync(outDir, { recursive: true });
  const stamp = receipt.at.replace(/[:.]/g, "-");

  // 3 (started first): tail both Workers while the latency run writes canary notes.
  const tails = [];
  for (const k of Object.keys(hosts)) {
    if (!hosts[k]) continue;
    const file = join(outDir, `share-tail-${k}-${stamp}.log`);
    const child = spawn("npx", ["--yes", WRANGLER, "tail", NAMES[k], "--format", "json"], { cwd: DIRS[k], stdio: ["ignore", "pipe", "pipe"] });
    const w = createWriteStream(file);
    child.stdout.pipe(w);
    child.stderr.pipe(w);
    tails.push({ child, file, w });
  }
  await new Promise((r) => setTimeout(r, 8000)); // tail connects

  // 1. latency.
  let ok = true;
  if (hosts.collab) {
    receipt.steps.collabLatency = await measureCollab(`wss://${hosts.collab}/`, n, canary);
    ok &&= receipt.steps.collabLatency.p95 < maxP95;
  }
  if (hosts.relay) {
    receipt.steps.relayLatency = await measureRelay(`https://${hosts.relay}`, n, { big: true });
    ok &&= receipt.steps.relayLatency.p95 < maxP95 && receipt.steps.relayLatency.big === 201;
  }
  await new Promise((r) => setTimeout(r, 5000));
  for (const t of tails) t.child.kill("SIGINT");
  await Promise.all(tails.map((t) => new Promise((r) => t.w.on("close", r).end())));
  const s = scan(tails.map((t) => t.file), [canary, DEFAULT_CANARY]);
  receipt.steps.logScan = { files: s.files, bytes: s.bytes, hits: s.hits.length };
  console.log(`log scan: ${s.hits.length} hits of the canary in ${s.files} tail logs (${s.bytes} bytes)`);
  ok &&= s.hits.length === 0;

  // 2. the relay's limits on the real runtime, on a temporary copy with tiny limits.
  if (hosts.relay) {
    const vars = Object.entries(CHECK_LIMITS).flatMap(([k, v]) => ["--var", `${k}:${v}`]);
    const d = must(wrangler(["deploy", "--name", CHECK_NAME, ...vars], { cwd: DIRS.relay }), "deploying the temporary relay");
    const host = hostIn(d.stdout, CHECK_NAME);
    try {
      receipt.steps.relayLimits = await checkLimits(`https://${host}`);
      console.log(`relay limits on ${host}: ${JSON.stringify(receipt.steps.relayLimits)}`);
      ok &&= receipt.steps.relayLimits.ok;
    } finally {
      // Wrangler asks before it deletes: answer y (it is only the temporary copy).
      wrangler(["delete", "--name", CHECK_NAME], { cwd: DIRS.relay, capture: false });
    }
  }

  receipt.ok = ok;
  const file = join(outDir, `share-receipt-${stamp}.json`);
  writeFileSync(file, JSON.stringify(receipt, null, 2));
  console.log(`\n${ok ? "✓" : "✗"} receipt: ${file}`);
  console.log("Last, by hand: open one share link in two browsers on two networks (e.g. a laptop on Wi-Fi and a phone on mobile data) and edit together.");
  process.exit(ok ? 0 : 1);
}

/**
 * The two limits of W6.23 on a relay deployed with CHECK_LIMITS: per address
 * and day (the third new space from this address: 429), and the global
 * ceiling (64 KiB: the 17th 4 KiB block, from any space: 507).
 */
export async function checkLimits(origin, fetchFn = fetch) {
  const base = `${origin.replace(/\/+$/, "")}/v1/vault/o/`;
  const tok = (i) => `limits-${i}-${Math.random().toString(36).slice(2)}${"x".repeat(32)}`;
  const put = (t, name, bytes) => fetchFn(base + name, { method: "PUT", headers: { Authorization: `Bearer ${t}` }, body: new Uint8Array(bytes) });
  const a = tok(1);
  const b = tok(2);
  const statuses = [];
  statuses.push((await put(a, "o0", 4000)).status, (await put(b, "o0", 4000)).status);
  const third = await put(tok(3), "o0", 10);
  const perAddress = third.status === 429 && (await third.json()).error === "new spaces today";
  // 2 blocks used; 14 more fill 64 KiB.
  for (let i = 1; i <= 14; i++) statuses.push((await put(i % 2 ? a : b, `o${i}`, 4000)).status);
  const over = await put(a, "o15", 10);
  const ceiling = over.status === 507 && (await over.json()).error === "relay full";
  return { ok: perAddress && ceiling && statuses.every((s) => s === 201), perAddress, ceiling, statuses: [...new Set(statuses)] };
}

if (isMain()) await main();
