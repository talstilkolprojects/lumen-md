#!/usr/bin/env node
/**
 * Plan W6.23: latency through the deployed share servers, from where this
 * runs (the owner runs it in Israel). Acceptance: p95 < 150 ms.
 *
 *   node scripts/share-latency.mjs --collab wss://lumen-collab.<you>.workers.dev/ \
 *        --relay https://lumen-vault-relay.<you>.workers.dev [--n 200] [--max-p95 150] [--big]
 *
 * Live share (--collab): two clients join one fresh room the way the app
 * does on the public server: a committed room name, the room proof from a
 * random password, the proof of work /token asks for, then the Hocuspocus
 * protocol with `?room=`. Client A appends one envelope at a time
 * ({v: 2, iv, ct}, ct = AES-GCM of a Yjs update holding a canary note, so
 * nothing on the wire is plain); one sample is the time until client B gets
 * it from the server.
 * Vault relay (--relay): one sample is a PUT of a 2 KiB encrypted object
 * and the GET that reads it back (the proof of work for the new space is
 * solved once, before timing). --big also PUTs one object of
 * VAULT_RELAY_MAX_OBJECT (2 MiB on Workers, `--big-bytes` to change): it
 * must not run out of the Workers Free plan's CPU time.
 *
 * Prints p50 / p95 / max per server and one JSON line (for the owner
 * session's receipt). Exit 1 when a p95 is not under --max-p95 (default 150)
 * or a request fails.
 *
 * `--canary <text>` sets the note text (default: a fixed Hebrew + English
 * line); scripts/share-scan.mjs then looks for it in `wrangler tail`'s
 * output (docs: sync/relay-server).
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { createHash, randomBytes, webcrypto } from "node:crypto";
import { realpathSync } from "node:fs";
import { fileURLToPath } from "node:url";

/** Run as a command (also through a symlink), not imported. */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

const subtle = webcrypto.subtle;
const enc = new TextEncoder();
export const DEFAULT_CANARY = "share-latency canary: פגישה עם רונית ביום שלישי";

// ── the room proof, as src/collab/roomProof.ts makes it ──
const b64url = (b) => Buffer.from(b).toString("base64url");
const hex = (b) => Buffer.from(b).toString("hex");
export async function roomProof(password, room) {
  const base = await subtle.importKey("raw", enc.encode(password), { name: "PBKDF2" }, false, ["deriveBits"]);
  const bits = await subtle.deriveBits({ name: "PBKDF2", salt: enc.encode(`lumen.collab.proof.v1|${room}`), iterations: 200_000, hash: "SHA-256" }, base, 256);
  const mac = await subtle.importKey("raw", bits, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
  return b64url(new Uint8Array(await subtle.sign("HMAC", mac, enc.encode(`lumen-collab room v1|${room}`))));
}
export const proofVerifier = (proof) => createHash("sha256").update(proof).digest("hex");
export const committedRoomName = (room, verifier) => `${room}_k${createHash("sha256").update(`lumen-collab commit v1|${room}|${verifier}`).digest("hex").slice(0, 32)}`;
export function zeroBits(d) {
  let n = 0;
  for (const b of d) {
    if (b === 0) {
      n += 8;
      continue;
    }
    return n + Math.clz32(b) - 24;
  }
  return n;
}
export function solveRoomPow(room, verifier, bits) {
  for (let i = 0; ; i++) {
    const nonce = i.toString(36);
    if (zeroBits(createHash("sha256").update(`lumen-collab pow v1|${room}|${verifier}|${nonce}`).digest()) >= bits) return nonce;
  }
}
// ── the vault relay's space id and proof of work (sync-server/vault-relay.js) ──
export const relaySpace = (token) => createHash("sha256").update(`lumen-vault-relay v1|${token}`).digest("hex");
export function solveRelayPow(space, bits) {
  for (let i = 0; ; i++) {
    const nonce = String(i);
    if (zeroBits(createHash("sha256").update(`lumen-vault-relay pow v1|${space}|${nonce}`).digest()) >= bits) return nonce;
  }
}

const stats = (xs) => {
  const s = [...xs].sort((a, b) => a - b);
  const at = (q) => s[Math.min(s.length - 1, Math.floor(q * s.length))];
  return { n: s.length, p50: Math.round(at(0.5)), p95: Math.round(at(0.95)), max: Math.round(s[s.length - 1]) };
};
const within = (p, ms) => Promise.race([p, new Promise((_, j) => setTimeout(() => j(new Error(`no answer within ${ms} ms`)), ms))]);

/** An envelope of src/collab/e2e.ts's shape whose ct is a real AES-GCM ciphertext of `update`. */
async function sealed(key, update) {
  const iv = new Uint8Array(randomBytes(12));
  const ct = new Uint8Array(await subtle.encrypt({ name: "AES-GCM", iv, additionalData: enc.encode("v2") }, key, update));
  return { v: 2, iv, ct };
}

export async function measureCollab(url, n, canary, log = console.log) {
  const base = `latency-${randomBytes(6).toString("hex")}`;
  const password = randomBytes(16).toString("base64url");
  const proof = await roomProof(password, base);
  const verifier = proofVerifier(proof);
  const room = committedRoomName(base, verifier);
  const tokenUrl = (() => {
    const x = new URL(url);
    x.search = "";
    x.pathname = `${x.pathname.replace(/\/+$/, "")}/token`;
    return x.toString();
  })();
  const roomUrl = (() => {
    const x = new URL(url);
    x.searchParams.set("room", room);
    return x.toString();
  })();
  let pow;
  const ask = () =>
    new Promise((resolve, reject) => {
      const ws = new WebSocket(tokenUrl);
      ws.onopen = () => ws.send(JSON.stringify({ room, proof, ...(pow ? { pow } : {}), ...(process.env.COLLAB_ACCESS_KEY ? { key: process.env.COLLAB_ACCESS_KEY } : {}) }));
      ws.onmessage = (ev) => {
        const m = JSON.parse(String(ev.data));
        ws.close();
        if (m.token) resolve(m.token);
        else if (m.error === "pow" && typeof m.bits === "number" && !pow) {
          pow = solveRoomPow(room, verifier, m.bits);
          resolve(ask());
        } else reject(new Error(`token refused: ${m.error}`));
      };
      ws.onerror = () => reject(new Error(`token socket failed: ${tokenUrl}`));
    });
  const frame = (type, write) => {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, room);
    encoding.writeVarUint(e, type);
    write(e);
    return encoding.toUint8Array(e);
  };
  async function client(onUpdate) {
    const token = await within(ask(), 60_000);
    const ws = new WebSocket(roomUrl);
    ws.binaryType = "arraybuffer";
    await within(new Promise((r, j) => ((ws.onopen = r), (ws.onerror = () => j(new Error(`room socket failed: ${roomUrl}`))))), 10_000);
    const ready = new Promise((resolve, reject) => {
      ws.onmessage = (ev) => {
        const d = decoding.createDecoder(new Uint8Array(ev.data));
        decoding.readVarString(d);
        const type = decoding.readVarUint(d);
        if (type === 2) {
          const sub = decoding.readVarUint(d);
          if (sub === 2) resolve();
          else reject(new Error(`permission denied: ${decoding.readVarString(d)}`));
        } else if (type === 0 && decoding.readVarUint(d) === 2) onUpdate();
      };
      ws.onclose = (ev) => reject(new Error(`room closed: ${ev.code} ${ev.reason}`));
    });
    ws.send(frame(2, (e) => (encoding.writeVarUint(e, 0), encoding.writeVarString(e, token))));
    await within(ready, 10_000);
    return ws;
  }
  let waiting = null;
  const b = await client(() => waiting?.());
  const a = await client(() => {});
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const plain = new Y.Doc();
  const transport = new Y.Doc();
  const samples = [];
  try {
    for (let i = 0; i < n; i++) {
      const psv = Y.encodeStateVector(plain);
      plain.getText("codemirror").insert(0, `${canary} #${i}\n`);
      const env = await sealed(key, Y.encodeStateAsUpdate(plain, psv));
      const sv = Y.encodeStateVector(transport);
      transport.getArray("e2e").push([env]);
      const update = Y.encodeStateAsUpdate(transport, sv);
      const got = new Promise((r) => (waiting = r));
      const t0 = performance.now();
      a.send(frame(0, (e) => (encoding.writeVarUint(e, 2), encoding.writeVarUint8Array(e, update))));
      await within(got, 5000);
      samples.push(performance.now() - t0);
    }
  } finally {
    a.close();
    b.close();
  }
  const s = stats(samples);
  log(`live share, ${s.n} edits through ${new URL(url).host}: p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms`);
  return s;
}

export async function measureRelay(origin, n, { big = false, bigBytes = 2 * 1024 * 1024, log = console.log, fetchFn = fetch } = {}) {
  const token = randomBytes(32).toString("base64url");
  const base = `${origin.replace(/\/+$/, "")}/v1/vault/o/`;
  const auth = { Authorization: `Bearer ${token}` };
  const key = await subtle.generateKey({ name: "AES-GCM", length: 256 }, false, ["encrypt"]);
  const object = async (bytes) => {
    const iv = new Uint8Array(randomBytes(12));
    return Buffer.concat([iv, Buffer.from(await subtle.encrypt({ name: "AES-GCM", iv }, key, randomBytes(bytes)))]);
  };
  // The new space: its proof of work, once, before timing.
  let first = await fetchFn(base + "probe", { method: "PUT", headers: auth, body: await object(64) });
  if (first.status === 428) {
    const { bits } = await first.json();
    first = await fetchFn(base + "probe", { method: "PUT", headers: { ...auth, "X-Lumen-Pow": solveRelayPow(relaySpace(token), bits) }, body: await object(64) });
  }
  if (first.status !== 201) throw new Error(`relay: the first PUT answered ${first.status} ${await first.text()}`);
  const samples = [];
  for (let i = 0; i < n; i++) {
    const body = await object(2048);
    const t0 = performance.now();
    const put = await fetchFn(base + `o${i % 8}`, { method: "PUT", headers: auth, body });
    if (put.status !== 201) throw new Error(`relay PUT ${put.status} ${await put.text()}`);
    const get = await fetchFn(base + `o${i % 8}`, { method: "GET", headers: auth });
    const back = Buffer.from(await get.arrayBuffer());
    if (get.status !== 200 || !back.equals(body)) throw new Error(`relay GET ${get.status}`);
    samples.push(performance.now() - t0);
  }
  const s = stats(samples);
  log(`vault relay, ${s.n} PUT+GET through ${new URL(origin).host}: p50 ${s.p50} ms · p95 ${s.p95} ms · max ${s.max} ms`);
  let bigStatus = null;
  if (big) {
    const body = await object(bigBytes - 64);
    const t0 = performance.now();
    const put = await fetchFn(base + "big", { method: "PUT", headers: auth, body });
    bigStatus = put.status;
    log(`vault relay, one PUT of ${bigBytes} bytes: HTTP ${put.status} in ${Math.round(performance.now() - t0)} ms${put.status === 201 ? "" : ` (${(await put.text()).slice(0, 200)})`}`);
  }
  // Leave nothing behind.
  for (const name of ["probe", "big", ...Array.from({ length: 8 }, (_, i) => `o${i}`)]) await fetchFn(base + name, { method: "DELETE", headers: auth }).catch(() => undefined);
  return { ...s, big: bigStatus };
}

if (isMain()) {
  const arg = (name, d) => {
    const i = process.argv.indexOf(name);
    return i === -1 ? d : process.argv[i + 1];
  };
  const collab = arg("--collab", null);
  const relayUrl = arg("--relay", null);
  const n = Number(arg("--n", 200)) || 200;
  const max = Number(arg("--max-p95", 150)) || 150;
  const canary = arg("--canary", DEFAULT_CANARY);
  if (!collab && !relayUrl) {
    console.error("usage: node scripts/share-latency.mjs [--collab wss://<collab>/] [--relay https://<relay>] [--n 200] [--max-p95 150] [--big [--big-bytes N]] [--canary <text>]");
    process.exit(2);
  }
  const out = { at: new Date().toISOString(), maxP95: max };
  let ok = true;
  try {
    if (collab) {
      out.collab = await measureCollab(collab, n, canary);
      ok &&= out.collab.p95 < max;
    }
    if (relayUrl) {
      out.relay = await measureRelay(relayUrl, n, { big: process.argv.includes("--big"), bigBytes: Number(arg("--big-bytes", 2 * 1024 * 1024)) || 2 * 1024 * 1024 });
      ok &&= out.relay.p95 < max && (out.relay.big === null || out.relay.big === 201);
    }
  } catch (e) {
    console.error(String(e?.message ?? e));
    ok = false;
  }
  out.ok = ok;
  console.log(JSON.stringify(out));
  process.exit(ok ? 0 : 1);
}
