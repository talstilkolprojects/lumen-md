#!/usr/bin/env node
/**
 * Data-safety drill on the merged code (plan W4.33).
 *
 *   node scripts/data-safety-drill.mjs [--kills 200] [--full-disk <dir>] [--out reports] [--json]
 *
 * Every way the app saves a note to a real folder is driven through four
 * kinds of trouble, on a real disk, in real processes:
 *
 *   kill9      a process saves notes as fast as it can and is killed with
 *              SIGKILL at a random moment, `--kills` times;
 *   full-disk  a save that does not fit on the disk (ENOSPC). With
 *              `--full-disk <dir>` the folder is a small file system the
 *              owner mounted (e.g. `mount -t tmpfs -o size=256k tmpfs <dir>`);
 *              without it this part is skipped and the report says so;
 *   permission the folder and its notes become read-only in the middle of
 *              saving (run as root, the saving process drops to uid 65534 so
 *              the permission really applies);
 *   external   another program saves the same notes the way editors do
 *              (temporary file, then rename) while the app is saving.
 *
 * After each round every note is checked: it carries a SHA-256 of its own
 * text, so a note is either one whole version or damaged. A note that was
 * whole before the round must still be whole and no older, no note may
 * disappear, and no temporary file may be left after recovery.
 *
 * The save paths, each loaded from this checkout:
 *
 *   mobile     src/storage/vault/mobile.ts — the real `createMobileBackend`
 *              over a Node `MobileFs` that writes the way the native side
 *              does (Android `openOutputStream(uri, "wt")`, iOS
 *              `Data.write(to:)`: truncate, then write in place);
 *   opfs-sync  the OPFS worker of src/storage/vault/opfsSyncWrite.ts
 *              (Safari before 26): `truncate(0)`, `write`, `flush`, ported
 *              line for line onto a Node file handle;
 *   atomic     src/storage/vault/atomic.ts (plan W1.5), when this checkout
 *              has it: temporary file, fsync, rename, and `recoverDir`;
 *   tauri      the algorithm of `Vault::write` in src-tauri/vault/src/lib.rs
 *              (temporary sibling, `sync_all`, rename), ported to Node —
 *              the Rust code itself is checked by `cargo test`.
 *
 * The File System Access path (`createWritable`) is atomic by the browser's
 * own design (a swap file replaced on close) and is not something Node can
 * drive; the e2e matrix (e2e/data-safety.spec.ts) covers it.
 *
 * Writes `<out>/data-safety-drill-<commit>.json` and `.md`. Exit code 0 when
 * no note on a path that claims to be safe was damaged or lost.
 */
import { spawn, execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readFileSync, mkdirSync, mkdtempSync, rmSync, writeFileSync, chownSync, chmodSync, readdirSync, statSync } from "node:fs";
import * as fsp from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const repo = resolve(here, "..");
const SELF = fileURLToPath(import.meta.url);
const args = process.argv.slice(2);
const arg = (name, dflt) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : dflt;
};

const DIRS = ["", "notes", "notes/deep"];
const NOTES = DIRS.flatMap((d) => Array.from({ length: 6 }, (_, i) => (d ? `${d}/n${i}.md` : `n${i}.md`)));
const NOBODY = 65534;

// ── Versions that check themselves ───────────────────────────────────────

/** One version of a note: "LUMEN1 <sha256> <version>\n<body>". */
function version(v, body) {
  const head = `LUMEN1 ${createHash("sha256").update(`${v}\n${body}`).digest("hex")} ${v}\n`;
  return new TextEncoder().encode(head + body);
}

/** The version number of a whole note, or null when it is damaged. */
function check(bytes) {
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return null;
  }
  const m = /^LUMEN1 ([0-9a-f]{64}) (\d+)\n/.exec(text);
  if (!m) return null;
  const body = text.slice(m[0].length);
  return createHash("sha256").update(`${m[2]}\n${body}`).digest("hex") === m[1] ? Number(m[2]) : null;
}

const randomBody = (max = 3000) => "שלום עולם, hello world. ".repeat(1 + Math.floor(Math.random() * max));

// ── Loading the save paths from this checkout ────────────────────────────

/** Bundle a module of src/ for Node, with only the pieces a backend needs. */
async function bundle(entry, outFile) {
  // The saving processes load what the drill built.
  if (args[0] === "--child") return outFile;
  const { build } = await import("esbuild");
  const vaultDir = join(repo, "src", "storage", "vault");
  await build({
    entryPoints: [join(repo, entry)],
    bundle: true,
    format: "esm",
    platform: "node",
    outfile: outFile,
    logLevel: "error",
    external: ["@capacitor/core"],
    plugins: [
      {
        // The vault barrel pulls in the whole app; a backend needs only the
        // shared helpers and the types.
        name: "vault-barrel",
        setup(b) {
          b.onResolve({ filter: /^\.\/index$/ }, (a) => (a.resolveDir === vaultDir ? { path: "barrel", namespace: "vault-barrel" } : undefined));
          b.onLoad({ filter: /.*/, namespace: "vault-barrel" }, () => ({
            contents: 'export * from "./shared"; export * from "./types";',
            resolveDir: vaultDir,
            loader: "ts",
          }));
        },
      },
    ],
  });
  return outFile;
}

/** Node file-system steps over a real folder. */
function nodeFolder(root) {
  const at = (p) => join(root, ...p.split("/").filter(Boolean));
  return { at };
}

/** A `MobileFs` that writes the way Capacitor and the SAF plugin do: in place. */
function nodeMobileFs(root) {
  const { at } = nodeFolder(root);
  return {
    async readdir(path) {
      const out = [];
      for (const e of await fsp.readdir(at(path), { withFileTypes: true })) {
        const s = await fsp.stat(join(at(path), e.name));
        out.push({ name: e.name, type: e.isDirectory() ? "directory" : "file", size: s.size, mtime: s.mtimeMs });
      }
      return out;
    },
    async stat(path) {
      try {
        const s = await fsp.stat(at(path));
        return { type: s.isDirectory() ? "directory" : "file", size: s.size, mtime: s.mtimeMs };
      } catch {
        return null;
      }
    },
    readFile: async (path) => new Uint8Array(await fsp.readFile(at(path))),
    async writeFile(path, data) {
      // openOutputStream(uri, "wt") / Data.write(to:): truncate, then the
      // bytes go out in buffer-sized pieces.
      const fh = await fsp.open(at(path), "w");
      try {
        for (let off = 0; off < data.byteLength; off += 8192) await fh.write(data, off, Math.min(8192, data.byteLength - off), off);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    mkdir: (path) => fsp.mkdir(at(path), { recursive: true }).then(() => undefined),
    rename: (from, to) => fsp.rename(at(from), at(to)),
    remove: (path) => fsp.rm(at(path), { recursive: true }),
  };
}

/** The steps atomic.ts asks for (plan W1.5), over a real folder. */
function atomicDiskFs(root) {
  const { at } = nodeFolder(root);
  return {
    async readdir(dir) {
      return (await fsp.readdir(at(dir), { withFileTypes: true })).map((e) => ({ name: e.name, type: e.isDirectory() ? "directory" : "file" }));
    },
    exists: (p) => fsp.stat(at(p)).then(() => true, () => false),
    async writeFile(p, data) {
      const fh = await fsp.open(at(p), "wx");
      try {
        for (let off = 0; off < data.byteLength; off += 8192) await fh.write(data, off, Math.min(8192, data.byteLength - off), off);
        await fh.sync();
      } finally {
        await fh.close();
      }
    },
    size: (p) => fsp.stat(at(p)).then((s) => s.size, () => null),
    rename: (a, b) => fsp.rename(at(a), at(b)),
    remove: (p) => fsp.rm(at(p), { recursive: true, force: false }),
  };
}

/**
 * Every save path this checkout has: `{ name, claim, open(root) → { save(path, bytes), recover() } }`.
 * `claim` is "atomic" when the code says a save lands whole, "in-place" when it does not.
 */
async function loadPaths(work) {
  const paths = [];
  const atomicMod = existsSync(join(repo, "src/storage/vault/atomic.ts"))
    ? await import(pathToFileURL(await bundle("src/storage/vault/atomic.ts", join(work, "atomic.mjs"))).href)
    : null;
  const mobileJs = await bundle("src/storage/vault/mobile.ts", join(work, "mobile.mjs"));
  const mobile = await import(pathToFileURL(mobileJs).href);
  paths.push({
    name: "mobile",
    source: "src/storage/vault/mobile.ts (createMobileBackend, real code)",
    open(root) {
      const backend = mobile.createMobileBackend(nodeMobileFs(root));
      return {
        save: (p, bytes) => backend.write(p, bytes),
        // With plan W1.5 the backend recovers a folder when it opens it: a
        // fresh backend over the same folder is what the app sees on restart.
        async recover() {
          const fresh = mobile.createMobileBackend(nodeMobileFs(root));
          await fresh.list("").catch(() => undefined);
          if (!atomicMod) return [];
          const fs = atomicDiskFs(root);
          const out = [];
          for (const d of DIRS) out.push(...(await atomicMod.recoverDir(fs, d)));
          return out;
        },
        isTemp: (name) => (atomicMod ? atomicMod.isTempName(name) : false),
      };
    },
  });
  const worker = readFileSync(join(repo, "src/storage/vault/opfsSyncWrite.ts"), "utf8");
  if (/\.move\(/.test(worker)) {
    paths.push({
      name: "opfs-sync",
      source: "src/storage/vault/opfsSyncWrite.ts worker (temporary file, move old aside, move new in), ported",
      open(root) {
        const { at } = nodeFolder(root);
        const put = async (file, bytes) => {
          const fh = await fsp.open(file, existsSync(file) ? "r+" : "w+");
          try {
            await fh.truncate(0);
            for (let off = 0; off < bytes.byteLength; off += 8192) await fh.write(bytes, off, Math.min(8192, bytes.byteLength - off), off);
            await fh.sync();
            if ((await fh.stat()).size !== bytes.byteLength) throw new Error("the write was cut short");
          } finally {
            await fh.close();
          }
        };
        return {
          async save(p, bytes) {
            const name = at(p);
            const sid = `${process.pid}${Math.floor(Math.random() * 1e9).toString(36)}`;
            const d = dirname(name);
            const base = name.slice(d.length + 1);
            const tmp = join(d, `.lumen-tmp~${base}~${sid}`);
            const old = join(d, `.lumen-old~${base}~${sid}`);
            if (!existsSync(name)) await fsp.writeFile(name, new Uint8Array(0)); // getFileHandle(name, { create: true })
            await put(tmp, bytes);
            await fsp.rename(name, old); // probe.move(old)
            await fsp.rename(tmp, name); // file.move(name)
            await fsp.rm(old); // dir.removeEntry(old)
          },
          async recover() {
            if (!atomicMod) return [];
            const fs = atomicDiskFs(root);
            const out = [];
            for (const d of DIRS) out.push(...(await atomicMod.recoverDir(fs, d)));
            return out;
          },
          isTemp: (name) => (atomicMod ? atomicMod.isTempName(name) : false),
        };
      },
    });
  } else
  paths.push({
    name: "opfs-sync",
    source: "src/storage/vault/opfsSyncWrite.ts worker (truncate, write, flush), ported",
    open(root) {
      const { at } = nodeFolder(root);
      return {
        async save(p, bytes) {
          const fh = await fsp.open(at(p), existsSync(at(p)) ? "r+" : "w+");
          try {
            await fh.truncate(0); // handle.truncate(0)
            for (let off = 0; off < bytes.byteLength; off += 8192) await fh.write(bytes, off, Math.min(8192, bytes.byteLength - off), off); // handle.write(bytes, { at: 0 })
            await fh.sync(); // handle.flush()
          } finally {
            await fh.close();
          }
        },
        recover: async () => [],
      };
    },
  });
  paths.push({
    name: "tauri",
    source: "src-tauri/vault/src/lib.rs Vault::write (temporary sibling, sync_all, rename), ported",
    open(root) {
      const { at } = nodeFolder(root);
      return {
        async save(p, bytes) {
          const target = at(p);
          const tmp = join(dirname(target), `.lumen-tmp-${process.pid}-${Math.floor(Math.random() * 1e9)}`);
          const fh = await fsp.open(tmp, "wx");
          try {
            // write_all, sync_all, drop, rename; on any error the temporary file is removed.
            try {
              for (let off = 0; off < bytes.byteLength; off += 8192) await fh.write(bytes, off, Math.min(8192, bytes.byteLength - off), off);
              await fh.sync();
            } finally {
              await fh.close();
            }
            await fsp.rename(tmp, target);
          } catch (e) {
            await fsp.rm(tmp, { force: true });
            throw e;
          }
        },
        // The Rust vault leaves `.lumen-tmp-*` behind after a crash and lists
        // past them; the drill counts them separately (not as damage).
        recover: async () => [],
        tempPrefix: ".lumen-tmp-",
      };
    },
  });
  if (atomicMod) {
    const atomic = atomicMod;
    paths.push({
      name: "atomic",
      source: "src/storage/vault/atomic.ts (plan W1.5, real code)",
      open(root) {
        const fs = atomicDiskFs(root);
        return {
          save: (p, bytes) => atomic.atomicWrite(fs, p, bytes),
          async recover() {
            const out = [];
            for (const d of DIRS) out.push(...(await atomic.recoverDir(fs, d)));
            return out;
          },
          isTemp: (name) => atomic.isTempName(name),
        };
      },
    });
  }
  return paths;
}

// ── The child: save until killed ─────────────────────────────────────────

if (args[0] === "--child") {
  const [, work, pathName, root, startV, mode] = args;
  const paths = await loadPaths(work);
  const p = paths.find((x) => x.name === pathName);
  const store = p.open(root);
  let v = Number(startV);
  let failed = 0;
  process.stdout.write("ready\n");
  for (;;) {
    const note = NOTES[Math.floor(Math.random() * NOTES.length)];
    const bytes = version(++v, randomBody());
    try {
      await store.save(note, bytes);
    } catch (e) {
      // permission: a refused save is expected; it must not damage anything.
      if (mode !== "tolerate") throw e;
      failed++;
      if (failed % 50 === 0) process.stdout.write(`failed ${failed}\n`);
    }
  }
}

if (args[0] === "--external") {
  // Another program (an editor, a sync client) saving the same notes the way
  // most editors do: a temporary file, then rename over the note.
  const [, root, startV] = args;
  let v = Number(startV);
  process.stdout.write("ready\n");
  for (;;) {
    const note = NOTES[Math.floor(Math.random() * NOTES.length)];
    const target = join(root, ...note.split("/"));
    const tmp = `${target}.ext~${Math.floor(Math.random() * 1e9)}`;
    try {
      await fsp.writeFile(tmp, version(++v, randomBody(800)));
      await fsp.rename(tmp, target);
    } catch {
      await fsp.rm(tmp, { force: true });
    }
  }
}

// ── The parent ───────────────────────────────────────────────────────────

const kills = Number(arg("--kills", "200"));
const fullDiskDir = arg("--full-disk", null);
const outDir = resolve(repo, arg("--out", "reports"));
const json = args.includes("--json");
const isRoot = typeof process.getuid === "function" && process.getuid() === 0;
const work = mkdtempSync(join(tmpdir(), "lumen-drill-"));
chmodSync(work, 0o755);
const paths = await loadPaths(work);

function startChild(argv, opts = {}) {
  const child = spawn(process.execPath, [SELF, ...argv], { stdio: ["ignore", "pipe", "pipe"], ...opts });
  let err = "";
  child.stderr.on("data", (d) => (err += d));
  const ready = new Promise((res, rej) => {
    child.stdout.once("data", () => res());
    child.once("exit", (code, signal) => rej(new Error(`child ended before it was ready (code ${code}, signal ${signal}): ${err.slice(0, 400)}`)));
  });
  const exited = new Promise((res) => child.once("exit", (code, signal) => res({ code, signal, err })));
  return { child, ready, exited };
}

async function newFolder(base) {
  const root = mkdtempSync(join(base ?? tmpdir(), "vault-"));
  for (const d of DIRS) if (d) mkdirSync(join(root, d), { recursive: true });
  return root;
}

/** Check every note; `state` holds the version each note had before. */
async function audit(root, store, state, tally) {
  for (const r of await store.recover()) {
    if (r.action === "promoted") tally.promoted++;
    if (r.action === "restored") tally.restored++;
  }
  let orphans = 0;
  for (const d of DIRS) {
    for (const name of readdirSync(join(root, d))) {
      if (statSync(join(root, d, name)).isDirectory()) continue;
      if (store.isTemp?.(name)) tally.leftovers++;
      else if (store.tempPrefix && name.startsWith(store.tempPrefix)) orphans++;
    }
  }
  // Temporary files a crash left that the backend hides but never removes.
  tally.orphanTemps = orphans;
  for (const note of NOTES) {
    let bytes;
    try {
      bytes = await fsp.readFile(join(root, ...note.split("/")));
    } catch {
      if (state.has(note)) tally.missing++;
      continue;
    }
    const v = check(bytes);
    if (v === null) {
      // Counted once; the note is then put back whole (as a user restoring
      // it would), so the next round starts from a whole vault again.
      tally.damaged++;
      tally.damagedSizes.push(bytes.byteLength);
      const fresh = (state.get(note) ?? 0) + 1;
      await fsp.writeFile(join(root, ...note.split("/")), version(fresh, "restored"));
      state.set(note, fresh);
      continue;
    }
    if (state.has(note) && v < state.get(note)) tally.older++;
    state.set(note, v);
  }
}

const newTally = () => ({ rounds: 0, damaged: 0, missing: 0, older: 0, leftovers: 0, orphanTemps: 0, promoted: 0, restored: 0, refused: 0, damagedSizes: [] });

async function seed(root, store, state) {
  let v = 1;
  for (const note of NOTES) {
    await store.save(note, version(v, randomBody(200)));
    state.set(note, v++);
  }
}

/** kill9: SIGKILL in the middle of saving, `kills` times. */
async function drillKill(p) {
  const root = await newFolder();
  const store = p.open(root);
  const state = new Map();
  const t = newTally();
  await seed(root, store, state);
  let next = 0;
  for (let k = 0; k < kills; k++) {
    next += 1_000_000;
    const c = startChild(["--child", work, p.name, root, String(next), "strict"]);
    await c.ready;
    await new Promise((r) => setTimeout(r, 5 + Math.floor(Math.random() * 60)));
    c.child.kill("SIGKILL");
    const end = await c.exited;
    if (end.signal !== "SIGKILL") throw new Error(`${p.name}: the saving process ended by itself (${end.code}): ${end.err.slice(0, 400)}`);
    await audit(root, store, state, t);
    t.rounds++;
  }
  rmSync(root, { recursive: true, force: true });
  return t;
}

/** A full disk: each note grows until a save no longer fits. */
async function drillFullDisk(p) {
  const t = newTally();
  if (!fullDiskDir) return { ...t, skipped: "no small file system given (--full-disk <dir>)" };
  const root = await newFolder(fullDiskDir);
  const store = p.open(root);
  const state = new Map();
  await seed(root, store, state);
  let v = 1000;
  for (let round = 0; round < 40; round++) {
    const note = NOTES[round % NOTES.length];
    try {
      await store.save(note, version(++v, "שלום עולם, hello world. ".repeat(400 + round * 400)));
    } catch (e) {
      // The save must fail loudly (the app keeps the text and retries, G9).
      if (/ENOSPC|no space/i.test(`${e?.code ?? ""} ${e?.message ?? e}`)) t.refused++;
      else throw e;
    }
    await audit(root, store, state, t);
    t.rounds++;
  }
  rmSync(root, { recursive: true, force: true });
  return t;
}

/** Permission loss in the middle of saving. */
async function drillPermission(p) {
  const t = newTally();
  const root = await newFolder();
  const store = p.open(root);
  const state = new Map();
  await seed(root, store, state);
  const asNobody = isRoot;
  const own = (mode) => {
    for (const d of DIRS) {
      const dir = join(root, d);
      for (const name of readdirSync(dir)) {
        const f = join(dir, name);
        try {
          if (statSync(f).isFile()) {
            if (asNobody) chownSync(f, NOBODY, NOBODY);
            chmodSync(f, mode === "rw" ? 0o644 : 0o444);
          }
        } catch (e) {
          // A temporary file the saving process renamed or removed meanwhile.
          if (e?.code !== "ENOENT") throw e;
        }
      }
      if (asNobody) chownSync(dir, NOBODY, NOBODY);
      chmodSync(dir, mode === "rw" ? 0o755 : 0o555);
    }
  };
  if (asNobody) chownSync(dirname(root), process.getuid(), process.getgid());
  chmodSync(dirname(root), 0o755);
  for (let round = 0; round < 20; round++) {
    own("rw");
    const c = startChild(["--child", work, p.name, root, String((round + 1) * 1_000_000), "tolerate"], asNobody ? { uid: NOBODY, gid: NOBODY } : {});
    await c.ready;
    await new Promise((r) => setTimeout(r, 10 + Math.floor(Math.random() * 40)));
    own("ro");
    await new Promise((r) => setTimeout(r, 30));
    c.child.kill("SIGKILL");
    await c.exited;
    own("rw");
    await audit(root, store, state, t);
    t.rounds++;
  }
  rmSync(root, { recursive: true, force: true });
  return { ...t, permissionsEnforced: asNobody || !isRoot };
}

/** Another program saves the same notes while the app saves. */
async function drillExternal(p) {
  const t = newTally();
  const root = await newFolder();
  const store = p.open(root);
  const state = new Map();
  await seed(root, store, state);
  for (let round = 0; round < Math.max(20, Math.floor(kills / 5)); round++) {
    const app = startChild(["--child", work, p.name, root, String((round + 1) * 1_000_000), "tolerate"]);
    const ext = startChild(["--external", root, String((round + 1) * 1_000_000 + 500_000)]);
    await Promise.all([app.ready, ext.ready]);
    await new Promise((r) => setTimeout(r, 20 + Math.floor(Math.random() * 60)));
    ext.child.kill("SIGKILL");
    app.child.kill("SIGKILL");
    await Promise.all([app.exited, ext.exited]);
    // The external writer's own leftovers are not the app's to judge.
    for (const d of DIRS) for (const name of readdirSync(join(root, d))) if (name.includes(".ext~")) rmSync(join(root, d, name));
    // Two writers: "older" is not a loss here (the other program's save can
    // be the last one); only damage and disappearance count.
    const before = t.older;
    await audit(root, store, state, t);
    t.older = before;
    t.rounds++;
  }
  rmSync(root, { recursive: true, force: true });
  return t;
}

const commit = (() => {
  try {
    return execFileSync("git", ["rev-parse", "HEAD"], { cwd: repo, encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();

const results = [];
try {
  for (const p of paths) {
    const r = { path: p.name, source: p.source, kill9: await drillKill(p), fullDisk: await drillFullDisk(p), permission: await drillPermission(p), external: await drillExternal(p) };
    results.push(r);
    if (!json) {
      const line = (k) => {
        const x = r[k];
        return `${k} ${x.rounds} rounds: damaged ${x.damaged}, missing ${x.missing}, older ${x.older}, leftovers ${x.leftovers}${x.refused ? `, refused ${x.refused}` : ""}${x.orphanTemps ? `, orphan temps ${x.orphanTemps}` : ""}`;
      };
      console.log(`${p.name} — ${p.source}`);
      for (const k of ["kill9", "fullDisk", "permission", "external"]) console.log(`  ${line(k)}`);
    }
  }
} finally {
  rmSync(work, { recursive: true, force: true });
}

const bad = (x) => x.damaged + x.missing + x.older + x.leftovers;
const verdict = results.map((r) => ({ path: r.path, lost: bad(r.kill9) + bad(r.fullDisk) + bad(r.permission) + bad(r.external) }));
const report = {
  plan: "W4.33",
  commit,
  date: new Date().toISOString(),
  node: process.version,
  kills,
  fullDisk: fullDiskDir ? "a real small file system" : "skipped (no --full-disk)",
  permissions: isRoot ? "saving process as uid 65534" : "current user",
  results: results.map((r) => ({ ...r, kill9: { ...r.kill9, damagedSizes: r.kill9.damagedSizes.slice(0, 10) } })),
  verdict,
};
mkdirSync(outDir, { recursive: true });
const base = join(outDir, `data-safety-drill-${commit.slice(0, 12)}`);
writeFileSync(`${base}.json`, `${JSON.stringify(report, null, 2)}\n`);
const md = [
  `# Data-safety drill (plan W4.33) — ${commit.slice(0, 12)}`,
  "",
  `${report.date} · Node ${report.node} · ${kills} SIGKILLs per path · full disk: ${report.fullDisk} · permissions: ${report.permissions}`,
  "",
  "| Save path | kill -9 | full disk | permission loss | external edit | notes lost or damaged |",
  "|---|---|---|---|---|---|",
  ...results.map((r) => `| ${r.path} | ${bad(r.kill9)} | ${bad(r.fullDisk)} | ${bad(r.permission)} | ${bad(r.external)} | **${verdict.find((v) => v.path === r.path).lost}** |`),
  "",
  ...results.map((r) => `- **${r.path}**: ${r.source}`),
  "",
].join("\n");
writeFileSync(`${base}.md`, md);
if (json) console.log(JSON.stringify(report));
else console.log(`report: ${base}.md`);
process.exit(verdict.some((v) => v.lost > 0) ? 1 : 0);
