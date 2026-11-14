#!/usr/bin/env node
/**
 * Edit-to-screen latency through a live-share server (plan W4.8 acceptance:
 * p95 < 300 ms from Israel).
 *
 *   node scripts/collab-latency.mjs wss://<server>/ [--n 100]
 *
 * Two clients join one fresh room, as the app does: a token from /token,
 * then the Hocuspocus protocol with `?room=`. Client A appends one
 * encrypted-looking envelope (random bytes, the shape of src/collab/e2e.ts)
 * at a time; the time until client B receives it is one sample. Prints
 * p50 / p95 / max. Run it from the place to measure (e.g. a laptop in Israel).
 */
import * as Y from "yjs";
import * as encoding from "lib0/encoding";
import * as decoding from "lib0/decoding";
import { randomBytes } from "node:crypto";

const url = process.argv[2];
const n = Number(process.argv[process.argv.indexOf("--n") + 1]) || 100;
if (!url || !/^wss?:\/\//.test(url)) {
  console.error("usage: node scripts/collab-latency.mjs wss://<server>/ [--n 100]");
  process.exit(2);
}
const room = `latency-${randomBytes(8).toString("hex")}`;

function tokenUrl(u) {
  const x = new URL(u);
  x.search = "";
  x.pathname = `${x.pathname.replace(/\/+$/, "")}/token`;
  return x.toString();
}
function roomUrl(u) {
  const x = new URL(u);
  x.searchParams.set("room", room);
  return x.toString();
}

function getToken() {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(tokenUrl(url));
    ws.onopen = () => ws.send(JSON.stringify({ room, key: process.env.COLLAB_ACCESS_KEY ?? null }));
    ws.onmessage = (ev) => {
      const m = JSON.parse(String(ev.data));
      if (m.token) resolve(m.token);
      else reject(new Error(`token refused: ${m.error}`));
    };
    ws.onerror = () => reject(new Error("token socket failed"));
  });
}

const frame = (type, write) => {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, room);
  encoding.writeVarUint(e, type);
  write(e);
  return encoding.toUint8Array(e);
};

/** A client: resolves once authenticated; `onUpdate` is called per broadcast update. */
async function client(onUpdate) {
  const token = await getToken();
  const ws = new WebSocket(roomUrl(url));
  ws.binaryType = "arraybuffer";
  await new Promise((r, j) => {
    ws.onopen = r;
    ws.onerror = () => j(new Error("room socket failed"));
  });
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
  });
  ws.send(frame(2, (e) => {
    encoding.writeVarUint(e, 0);
    encoding.writeVarString(e, token);
  }));
  await ready;
  return ws;
}

let waiting = null;
const b = await client(() => waiting?.());
const a = await client(() => {});
const doc = new Y.Doc();
const samples = [];
for (let i = 0; i < n; i++) {
  const sv = Y.encodeStateVector(doc);
  doc.getArray("e2e").push([{ v: 2, iv: new Uint8Array(randomBytes(12)), ct: new Uint8Array(randomBytes(64)) }]);
  const update = Y.encodeStateAsUpdate(doc, sv);
  const got = new Promise((r) => (waiting = r));
  const t0 = performance.now();
  a.send(frame(0, (e) => {
    encoding.writeVarUint(e, 2);
    encoding.writeVarUint8Array(e, update);
  }));
  await Promise.race([got, new Promise((_, j) => setTimeout(() => j(new Error("no broadcast within 5 s")), 5000))]);
  samples.push(performance.now() - t0);
}
a.close();
b.close();
samples.sort((x, y) => x - y);
const at = (q) => samples[Math.min(samples.length - 1, Math.floor(q * samples.length))].toFixed(0);
console.log(`${n} edits through ${new URL(url).host}: p50 ${at(0.5)} ms · p95 ${at(0.95)} ms · max ${at(1)} ms`);
process.exit(Number(at(0.95)) < 300 ? 0 : 1);
