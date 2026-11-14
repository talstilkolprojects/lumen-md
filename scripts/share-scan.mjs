#!/usr/bin/env node
/**
 * Plan W6.23: is any note text in what the share servers keep? Scans files
 * and directories (a server's storage, `wrangler dev --persist-to` state,
 * SQLite files, saved logs) for given texts, in every form a server could
 * hold them: UTF-8, UTF-16 (LE/BE), base64 and hex. Exit 0 with "0 hits",
 * exit 1 listing each hit.
 *
 *   node scripts/share-scan.mjs --text "a canary note" [--text …] <path>…
 *   node scripts/share-scan.mjs --texts-file canaries.txt <path>…
 *
 * Used by src/__tests__/shareStorageScan.test.ts (local servers, the app's
 * real encryption) and by the owner on the deployed servers' logs
 * (`wrangler tail` saved to a file while scripts/share-latency.mjs writes
 * canary notes); see docs/src/content/docs/sync/relay-server.md.
 */
import { readFileSync, readdirSync, realpathSync, statSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

/** Run as a command (also through a symlink), not imported. */
function isMain() {
  try {
    return realpathSync(process.argv[1] ?? "") === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return false;
  }
}

/** Every byte pattern under which `text` could sit in a file. */
export function forms(text) {
  const utf8 = Buffer.from(text, "utf8");
  const le = Buffer.from(text, "utf16le");
  const be = Buffer.from(le).swap16();
  const out = [
    ["utf8", utf8],
    ["utf16le", le],
    ["utf16be", be],
    ["hex", Buffer.from(utf8.toString("hex"))],
    ["HEX", Buffer.from(utf8.toString("hex").toUpperCase())],
  ];
  // base64 at each of the three alignments: the middle of a longer base64 run.
  for (let shift = 0; shift < 3; shift++) {
    const b = Buffer.concat([Buffer.alloc(shift), utf8]).toString("base64");
    // Only the 4-character groups whose 3 bytes are all the text's own: the
    // others depend on the bytes before and after it.
    const first = shift === 0 ? 0 : 1;
    const end = Math.floor((shift + utf8.length) / 3);
    const core = b.slice(first * 4, end * 4);
    if (core.length >= 8) {
      out.push([`base64+${shift}`, Buffer.from(core)]);
      out.push([`base64url+${shift}`, Buffer.from(core.replace(/\+/g, "-").replace(/\//g, "_"))]);
    }
  }
  return out;
}

function* files(path) {
  const st = statSync(path);
  if (st.isDirectory()) for (const name of readdirSync(path).sort()) yield* files(join(path, name));
  else if (st.isFile()) yield path;
}

/** [{file, text, form, offset}] for every hit of any of `texts` in `paths` (files or directories, recursively). */
export function scan(paths, texts) {
  const needles = texts.filter((t) => t.length >= 4).flatMap((text) => forms(text).map(([form, bytes]) => ({ text, form, bytes })));
  const hits = [];
  let scanned = 0;
  let bytes = 0;
  for (const p of paths) {
    for (const file of files(p)) {
      const data = readFileSync(file);
      scanned++;
      bytes += data.length;
      for (const n of needles) {
        const at = data.indexOf(n.bytes);
        if (at !== -1) hits.push({ file, text: n.text, form: n.form, offset: at });
      }
    }
  }
  return { hits, files: scanned, bytes };
}

/** The same scan over buffers in memory (a simulated storage, captured log lines). */
export function scanBuffers(named, texts) {
  const needles = texts.filter((t) => t.length >= 4).flatMap((text) => forms(text).map(([form, bytes]) => ({ text, form, bytes })));
  const hits = [];
  for (const [name, buf] of named) {
    const data = Buffer.isBuffer(buf) ? buf : Buffer.from(buf.buffer ?? buf, buf.byteOffset ?? 0, buf.byteLength ?? buf.length);
    for (const n of needles) if (data.indexOf(n.bytes) !== -1) hits.push({ file: name, text: n.text, form: n.form });
  }
  return hits;
}

if (isMain()) {
  const args = process.argv.slice(2);
  const texts = [];
  const paths = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--text") texts.push(args[++i]);
    else if (args[i] === "--texts-file") texts.push(...readFileSync(args[++i], "utf8").split("\n").map((l) => l.trim()).filter(Boolean));
    else paths.push(args[i]);
  }
  if (!texts.length || !paths.length) {
    console.error('usage: node scripts/share-scan.mjs --text "note text" [--text …] <file|dir>…');
    process.exit(2);
  }
  const r = scan(paths, texts);
  for (const h of r.hits) console.log(`HIT ${h.file} @${h.offset}: "${h.text}" as ${h.form}`);
  console.log(`${r.hits.length} hits of ${texts.length} texts in ${r.files} files (${r.bytes} bytes)`);
  process.exit(r.hits.length ? 1 : 0);
}
