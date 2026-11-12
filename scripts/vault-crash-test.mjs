#!/usr/bin/env node
/**
 * Crash test for atomic saves (plan W1.5): kill -9 in the middle of saving.
 *
 *   node scripts/vault-crash-test.mjs [--kills 1000] [--json]
 *
 * A child process saves notes of random sizes into a real folder on disk, as
 * fast as it can, through the same save steps the phone folders and the OPFS
 * write worker use (src/storage/vault/atomic.ts, temporary file → fsync →
 * rename). After a random moment it is killed with SIGKILL. The recovery
 * then runs on the folder, and every note is checked:
 *
 *   - it is whole: each version carries a SHA-256 of its own text;
 *   - it is the version it had before the kill, or a newer one;
 *   - no note that existed before the kill is missing;
 *   - no temporary file is left.
 *
 * Exit code 0 when no note was damaged. Needs Node 22.13+ (it loads the
 * TypeScript module with type stripping, re-running itself with the flag
 * when the Node version needs it).
 */
import { spawn, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

// Type stripping: on by default from Node 23.6, behind a flag before.
if (!process.features?.typescript && !process.execArgv.includes("--experimental-strip-types")) {
  const r = spawnSync(process.execPath, ["--experimental-strip-types", "--no-warnings", SELF, ...args], { stdio: "inherit" });
  process.exit(r.status ?? 1);
}

const { atomicWrite, isTempName, recoverDir } = await import(pathToFileURL(join(here, "..", "src", "storage", "vault", "atomic.ts")).href);

const DIRS = ["", "notes", "notes/deep"];
// Plus one note per folder whose name fills a file name: 126 Hebrew letters + ".md" = 255 bytes
// (its save takes the short names and the journal, and the real disk refuses anything longer).
const LONG = "א".repeat(126) + ".md";
const NOTES = DIRS.flatMap((d) => [...Array.from({ length: 10 }, (_, i) => `n${i}.md`), LONG].map((n) => (d ? `${d}/${n}` : n)));

/** The atomic-save steps over a real folder; every write is fsynced. */
function diskFs(root) {
  const at = (p) => join(root, ...p.split("/").filter(Boolean));
  return {
    async readdir(dir) {
      return (await fsp.readdir(at(dir), { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    },
    exists: (p) => fsp.stat(at(p)).then(() => true, () => false),
    async writeFile(p, data) {
      const fh = await fsp.open(at(p), "wx");
      try {
        await fh.write(data, 0, data.byteLength, 0);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    size: (p) => fsp.stat(at(p)).then((s) => s.size, () => null),
    readFile: async (p) => new Uint8Array(await fsp.readFile(at(p))),
    rename: (a, b) => fsp.rename(at(a), at(b)),
    remove: (p) => fsp.rm(at(p), { recursive: true, force: false }),
  };
}

/** One version of a note: "LUMEN1 <sha256> <version>\n<body>". */
function version(v, body) {
  const head = `LUMEN1 ${createHash("sha256").update(`${v}\n${body}`).digest("hex")} ${v}\n`;
  return new TextEncoder().encode(head + body);
}

/** The version number of a whole note, or null when it is damaged. */
function check(bytes) {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  const m = /^LUMEN1 ([0-9a-f]{64}) (\d+)\n/.exec(text);
  if (!m) return null;
  const body = text.slice(m[0].length);
  return createHash("sha256").update(`${m[2]}\n${body}`).digest("hex") === m[1] ? Number(m[2]) : null;
}

// ── The child: save until killed ─────────────────────────────────────────
if (args[0] === "--child") {
  const root = args[1];
  let v = Number(args[2]);
  const fs = diskFs(root);
  process.stdout.write("ready\n");
  for (;;) {
    const path = NOTES[Math.floor(Math.random() * NOTES.length)];
    const body = "שלום עולם, hello world. ".repeat(1 + Math.floor(Math.random() * 6000));
    await atomicWrite(fs, path, version(++v, body));
  }
}

// ── The parent ───────────────────────────────────────────────────────────
const kills = Number(arg("--kills", "1000"));
const json = args.includes("--json");
const root = mkdtempSync(join(tmpdir(), "lumen-crash-"));
for (const d of DIRS) if (d) await fsp.mkdir(join(root, d), { recursive: true });
const fs = diskFs(root);
const state = new Map(); // path → version before the kill
let damaged = 0;
let missing = 0;
let older = 0;
let leftovers = 0;
let promoted = 0;
let restored = 0;
let next = 0;

function runChild(ms) {
  return new Promise((resolveRun, reject) => {
    const child = spawn(process.execPath, [...process.execArgv, SELF, "--child", root, String(next)], { stdio: ["ignore", "pipe", "inherit"] });
    let timer = null;
    child.stdout.once("data", () => {
      timer = setTimeout(() => child.kill("SIGKILL"), ms);
    });
    child.on("error", reject);
    child.on("exit", (code, signal) => {
      if (timer) clearTimeout(timer);
      if (signal !== "SIGKILL") reject(new Error(`the saving process ended by itself (code ${code}, signal ${signal})`));
      else resolveRun();
    });
  });
}

try {
  for (let k = 0; k < kills; k++) {
    // Versions only grow: each child starts far above the last one.
    next += 1_000_000;
    await runChild(5 + Math.floor(Math.random() * 60));
    for (const d of DIRS) {
      for (const r of await recoverDir(fs, d)) {
        if (r.action === "promoted") promoted++;
        if (r.action === "restored") restored++;
      }
    }
    for (const d of DIRS) {
      for (const e of await fs.readdir(d)) if (isTempName(e.name)) leftovers++;
    }
    for (const path of NOTES) {
      let bytes;
      try {
        bytes = await fsp.readFile(join(root, path));
      } catch {
        if (state.has(path)) missing++;
        continue;
      }
      let v = null;
      try {
        v = check(bytes);
      } catch {
        v = null;
      }
      if (v === null) {
        damaged++;
        continue;
      }
      if (state.has(path) && v < state.get(path)) older++;
      state.set(path, v);
    }
  }
} finally {
  rmSync(root, { recursive: true, force: true });
}

const bad = damaged + missing + older + leftovers;
const result = { kills, files: state.size, damaged, missing, older, leftovers, promoted, restored };
if (json) console.log(JSON.stringify(result));
else {
  console.log(`vault crash test: ${kills} kills (SIGKILL) in the middle of saving, ${state.size} notes`);
  console.log(`  damaged ${damaged}, missing ${missing}, older than before ${older}, leftovers ${leftovers}`);
  console.log(`  recovery: ${promoted} saves finished, ${restored} old versions put back`);
  console.log(bad ? "FAIL" : "OK: every note is its old or its new version, whole");
}
process.exit(bad ? 1 : 0);
