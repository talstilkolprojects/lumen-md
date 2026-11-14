/**
 * Sync benchmark (plan W1.8): the first sync of a large vault, and then a
 * single change, against a local WebDAV server.
 *
 *   npx tsx scripts/bench/sync-first.ts [--notes 10000] [--attachments-mb 1024]
 *        [--attachment-mb 8] [--max-first-s 600] [--max-change-s 3] [--json]
 *
 * Everything is real except the disk: the encrypted sync engine, the WebDAV
 * provider and its HTTP requests over loopback to a WebDAV server (the same
 * WebDAV implementation the unit tests and the e2e use, served by node:http),
 * AES-GCM per file. Both devices keep their notes in memory, so the numbers
 * measure the sync, not this machine's disk.
 *
 * Measured, with the plan's limits:
 *   1. device A's first sync: every note and attachment up   (< 10 min)
 *   2. device B's first sync: all of it down                 (< 10 min)
 *   3. one note edited on A: A's round, then B's round       (< 3 s each)
 * Exit code 1 when a limit is missed.
 */

import { createServer, type IncomingMessage } from "node:http";
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { createVault, unlockVault, E2eeSync } from "../../src/sync/e2ee/engine";
import { memoryFiles } from "../../src/sync/e2ee/localFiles";
import { memoryStateStore } from "../../src/sync/e2ee/state";
import { webdavProvider } from "../../src/sync/e2ee/providers/webdav";
import { fakeWebdav } from "../../src/__tests__/helpers/fakeServers/webdav";

const args = process.argv.slice(2);
const opt = (name: string, dflt: number) => {
  const i = args.indexOf(name);
  return i >= 0 ? Number(args[i + 1]) : dflt;
};
const NOTES = opt("--notes", 10_000);
const ATTACH_MB = opt("--attachments-mb", 1024);
const EACH_MB = opt("--attachment-mb", 8);
const MAX_FIRST_S = opt("--max-first-s", 600);
const MAX_CHANGE_S = opt("--max-change-s", 3);
const JSON_OUT = args.includes("--json");

const PASS = "a long benchmark passphrase 2026";
const USER = "bench";
const PW = "bench-password";

function readBody(req: IncomingMessage): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => resolve(new Uint8Array(Buffer.concat(chunks))));
    req.on("error", reject);
  });
}

/** The mock WebDAV server on 127.0.0.1, over real HTTP. */
async function startDav(): Promise<{ url: string; close: () => Promise<void>; requests: () => number }> {
  let dav: ReturnType<typeof fakeWebdav> | null = null;
  let url = "";
  const server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) if (typeof v === "string") headers.set(k, v);
      const out = await dav!.handle({ method: req.method ?? "GET", url: new URL(req.url ?? "/", url), headers, body });
      res.writeHead(out.status, out.headers ?? {});
      res.end(out.body === undefined ? undefined : typeof out.body === "string" ? out.body : Buffer.from(out.body));
    })().catch((e) => {
      res.writeHead(500);
      res.end(String(e));
    });
  });
  server.keepAliveTimeout = 60_000;
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const port = (server.address() as AddressInfo).port;
  url = `http://127.0.0.1:${port}/dav/${USER}/Lumen/`;
  dav = fakeWebdav({ baseUrl: url, username: USER, password: PW, preCreated: true });
  return { url, requests: () => dav!.log.length, close: () => new Promise((r) => server.close(() => r())) };
}

/** A note of 1–3 KB, Hebrew and English, with front matter and links. */
function note(i: number): string {
  const he = "שורה בעברית עם קישור [[פתק " + ((i * 7) % NOTES) + "]] ומילים נוספות. ";
  const en = "A line in English with a #tag and a [link](https://example.com/" + i + "). ";
  const lines = 10 + (i % 25);
  let s = `---\ntitle: פתק ${i}\ntags: [bench, n${i % 50}]\n---\n\n# פתק ${i}\n\n`;
  for (let k = 0; k < lines; k++) s += (k % 2 ? en : he) + "\n";
  return s;
}

const secs = (t0: number) => (performance.now() - t0) / 1000;

async function main() {
  const dav = await startDav();
  const provider = () => webdavProvider({ url: dav.url, username: USER, password: PW });

  // Device A: the vault to sync.
  const a = memoryFiles();
  let noteBytes = 0;
  for (let i = 0; i < NOTES; i++) {
    const text = note(i);
    noteBytes += Buffer.byteLength(text);
    a.set(`notes/${String(Math.floor(i / 500)).padStart(2, "0")}/note-${i}.md`, text);
  }
  const attachments = Math.max(0, Math.round(ATTACH_MB / EACH_MB));
  for (let i = 0; i < attachments; i++) a.files.set(`attachments/file-${i}.bin`, new Uint8Array(randomBytes(EACH_MB * 1024 * 1024)));

  const created = await createVault(provider(), PASS);
  const syncA = new E2eeSync({ provider: provider(), keys: created.keys, local: a, store: memoryStateStore() });
  await syncA.markCreated(created.anchor);

  let t0 = performance.now();
  const firstA = await syncA.sync();
  const firstUp = secs(t0);

  const { keys } = await unlockVault(provider(), PASS);
  const b = memoryFiles();
  const syncB = new E2eeSync({ provider: provider(), keys, local: b, store: memoryStateStore() });
  t0 = performance.now();
  const firstB = await syncB.sync();
  const firstDown = secs(t0);

  const one = "notes/00/note-1.md";
  a.set(one, note(1) + "\nedited once\n");
  t0 = performance.now();
  const changeA = await syncA.sync();
  const changeUp = secs(t0);
  t0 = performance.now();
  const changeB = await syncB.sync();
  const changeDown = secs(t0);
  const same = b.text(one) === a.text(one);

  const result = {
    notes: NOTES,
    noteMB: Math.round((noteBytes / 1024 / 1024) * 10) / 10,
    attachments,
    attachmentMB: attachments * EACH_MB,
    requests: dav.requests(),
    firstSyncUpSeconds: Math.round(firstUp * 10) / 10,
    firstSyncDownSeconds: Math.round(firstDown * 10) / 10,
    singleChangeUpSeconds: Math.round(changeUp * 1000) / 1000,
    singleChangeDownSeconds: Math.round(changeDown * 1000) / 1000,
    uploaded: firstA.uploaded,
    downloaded: firstB.downloaded,
    changeUploaded: changeA.uploaded,
    changeDownloaded: changeB.downloaded,
    changeArrived: same,
    limits: { firstSyncSeconds: MAX_FIRST_S, singleChangeSeconds: MAX_CHANGE_S },
  };
  const files = NOTES + attachments;
  const ok =
    firstA.uploaded === files &&
    firstB.downloaded === files &&
    changeA.uploaded === 1 &&
    changeB.downloaded === 1 &&
    same &&
    firstUp < MAX_FIRST_S &&
    firstDown < MAX_FIRST_S &&
    changeUp < MAX_CHANGE_S &&
    changeDown < MAX_CHANGE_S;
  await dav.close();
  if (JSON_OUT) console.log(JSON.stringify({ ...result, ok }));
  else {
    console.log(`Sync benchmark — ${NOTES} notes (${result.noteMB} MB) + ${attachments} attachments (${result.attachmentMB} MB), local WebDAV over HTTP`);
    console.log(`  first sync, up   (device A): ${result.firstSyncUpSeconds} s   limit ${MAX_FIRST_S} s`);
    console.log(`  first sync, down (device B): ${result.firstSyncDownSeconds} s   limit ${MAX_FIRST_S} s`);
    console.log(`  one change, up   (device A): ${result.singleChangeUpSeconds} s   limit ${MAX_CHANGE_S} s`);
    console.log(`  one change, down (device B): ${result.singleChangeDownSeconds} s   limit ${MAX_CHANGE_S} s`);
    console.log(`  ${result.requests} WebDAV requests; ${ok ? "PASS" : "FAIL"}`);
  }
  process.exit(ok ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
